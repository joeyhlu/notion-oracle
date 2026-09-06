/** Electron main process: the floating overlay window, tray, hotkey, and the bridge to the AI CLI. */

import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { NotionClient } from "../../../extension/src/lib/notion.ts";
import { NOTION_API_TOOLS } from "../../../extension/src/lib/tools.ts";
import { DEFAULT_SETTINGS, type BrainId, type ChatEvent, type ChatRequest, type OverlayMode, type Settings } from "../shared/types.ts";
import { ClaudeBrain } from "./brains/claude.ts";
import { CodexBrain } from "./brains/codex.ts";
import type { Brain, McpServerSpec } from "./brains/types.ts";
import { checkBrain, resolveCli } from "./cli.ts";
import { getNotionWindowTitle } from "./notion-window.ts";
import { buildSystemPrompt, buildUserTurn } from "./prompt.ts";
import { SettingsStore } from "./settings.ts";
import { openTerminal } from "./terminal.ts";

const COLLAPSED = { width: 64, height: 64 };
const EXPANDED = { width: 420, height: 680 };
const MARGIN = 16;

if (process.env.NOTION_ORACLE_USER_DATA) app.setPath("userData", process.env.NOTION_ORACLE_USER_DATA);

const settings = new SettingsStore(app.getPath("userData"));
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let mode: OverlayMode = "collapsed";
let activeRun: AbortController | null = null;
const brains: Record<BrainId, Brain> = { claude: new ClaudeBrain(), codex: new CodexBrain() };

function placeWindow(target: { width: number; height: number }): void {
  if (!win) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  win.setBounds({
    x: Math.round(area.x + area.width - target.width - MARGIN),
    y: Math.round(mode === "expanded" ? area.y + Math.max(MARGIN, (area.height - target.height) / 2) : area.y + area.height - target.height - MARGIN),
    width: target.width,
    height: target.height,
  });
}

function setMode(next: OverlayMode): void {
  mode = next;
  placeWindow(next === "expanded" ? EXPANDED : COLLAPSED);
  win?.webContents.send("oracle:mode", next);
  if (next === "expanded") {
    win?.show();
    win?.focus();
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    ...COLLAPSED,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    title: "Notion Oracle",
    webPreferences: { preload: join(__dirname, "../preload/preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: "deny" };
  });
  void win.loadFile(join(__dirname, "../renderer/index.html"));
  win.once("ready-to-show", () => {
    placeWindow(COLLAPSED);
    win?.show();
    // First launch: open straight into setup.
    if (!settings.get().setupComplete) setMode("expanded");
  });
  win.on("closed", () => (win = null));
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(__dirname, "../tray.png"));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Notion Oracle");
  const refreshMenu = () => {
    const menu = Menu.buildFromTemplate([
      { label: "Open Oracle", click: () => setMode("expanded") },
      { label: "Hide overlay", click: () => win?.hide() },
      { label: "Show overlay", click: () => win?.show() },
      { type: "separator" },
      { label: "Start at login", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
      { label: `Shortcut: ${settings.get().hotkey.replace("CommandOrControl", process.platform === "darwin" ? "⌘" : "Ctrl")}`, enabled: false },
      { type: "separator" },
      { label: "Quit Notion Oracle", click: () => app.quit() },
    ]);
    tray?.setContextMenu(menu);
  };
  refreshMenu();
  tray.on("click", () => setMode(mode === "expanded" ? "collapsed" : "expanded"));
}

function registerHotkey(): void {
  globalShortcut.unregisterAll();
  const accelerator = settings.get().hotkey || DEFAULT_SETTINGS.hotkey;
  try {
    globalShortcut.register(accelerator, () => setMode(mode === "expanded" ? "collapsed" : "expanded"));
  } catch {
    // Invalid accelerator; the tray still works.
  }
}

async function openExternal(url: string): Promise<void> {
  // Send Notion links to the desktop app instead of the browser.
  const target = /^https:\/\/(www\.)?notion\.so\//.test(url) ? url.replace(/^https:\/\//, "notion://") : url;
  await shell.openExternal(target);
}

function serverScriptPath(): string {
  return join(app.getAppPath(), "dist", "mcp", "notion-server.js").replace("app.asar" + (process.platform === "win32" ? "\\" : "/"), "app.asar.unpacked" + (process.platform === "win32" ? "\\" : "/"));
}

function mcpSpec(current: Settings): McpServerSpec {
  return {
    name: "notion",
    // Electron's own binary doubles as Node for the tool server, so users need nothing else installed.
    command: process.execPath,
    args: [serverScriptPath()],
    env: { ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1", NOTION_TOKEN: current.notionToken },
    toolNames: NOTION_API_TOOLS.map((t) => t.name),
  };
}

async function runChat(request: ChatRequest): Promise<void> {
  const send = (event: ChatEvent) => win?.webContents.send("oracle:chat-event", event);
  const current = settings.get();
  const brain = brains[current.brain];
  const cliPath = await resolveCli(current.brain, current.brain === "claude" ? current.claudePath : current.codexPath);
  if (!cliPath) {
    send({ type: "error", message: `${current.brain === "claude" ? "Claude Code" : "Codex CLI"} is not installed. Open settings to install and sign in.`, threadId: request.threadId });
    return;
  }
  activeRun?.abort();
  const controller = new AbortController();
  activeRun = controller;
  const tempDir = join(app.getPath("userData"), "run");
  const cwd = join(app.getPath("userData"), "workspace");
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  send({ type: "status", message: "Starting…" });
  try {
    const hint = { notionWindowTitle: await getNotionWindowTitle() };
    await brain.run({
      cliPath,
      prompt: buildUserTurn(request.text, hint),
      systemPrompt: buildSystemPrompt(current.customInstructions),
      threadId: request.threadId,
      mcp: mcpSpec(current),
      model: current.model,
      cwd,
      tempDir,
      signal: controller.signal,
      onEvent: send,
    });
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error), threadId: request.threadId });
  } finally {
    if (activeRun === controller) activeRun = null;
  }
}

function registerIpc(): void {
  ipcMain.handle("oracle:get-settings", () => settings.get());
  ipcMain.handle("oracle:save-settings", (_e, patch: Partial<Settings>) => {
    const next = settings.update(patch);
    registerHotkey();
    return next;
  });
  ipcMain.handle("oracle:check-brain", (_e, brain: BrainId, pathOverride?: string) => checkBrain(brain, pathOverride));
  ipcMain.handle("oracle:open-sign-in", (_e, brain: BrainId) => {
    const current = settings.get();
    void resolveCli(brain, brain === "claude" ? current.claudePath : current.codexPath).then((path) => {
      const command = brain === "claude" ? "auth login" : "login";
      openTerminal(`${path ? JSON.stringify(path) : brain} ${command}`);
    });
  });
  ipcMain.handle("oracle:open-external", (_e, url: string) => openExternal(url));
  ipcMain.handle("oracle:test-notion", async (_e, token: string) => {
    try {
      const client = new NotionClient(token.trim());
      const me = await client.me();
      const results = await client.search("", undefined, 5);
      return { ok: true, message: results.length ? `Connected as "${me.name ?? "integration"}"; it can see ${results.length}${results.length === 5 ? "+" : ""} pages.` : `Connected as "${me.name ?? "integration"}", but it cannot see any pages yet. Share pages with it in Notion (••• → Connections).` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("oracle:page-hint", async () => ({ notionWindowTitle: await getNotionWindowTitle() }));
  ipcMain.handle("oracle:platform", () => process.platform);
  ipcMain.handle("oracle:chat-send", (_e, request: ChatRequest) => void runChat(request));
  ipcMain.handle("oracle:chat-abort", () => activeRun?.abort());
  ipcMain.handle("oracle:set-mode", (_e, next: OverlayMode) => setMode(next));
  ipcMain.handle("oracle:quit", () => app.quit());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => setMode("expanded"));
  app.whenReady().then(() => {
    if (process.platform === "darwin") app.dock?.hide();
    registerIpc();
    createWindow();
    createTray();
    registerHotkey();
  });
  // Keep running in the tray when the overlay window is closed.
  app.on("window-all-closed", () => undefined);
  app.on("will-quit", () => globalShortcut.unregisterAll());
}
