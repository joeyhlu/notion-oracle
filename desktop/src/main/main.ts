/** Electron main process: the floating overlay window, tray, hotkey, and the bridge to the AI CLI. */

import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { NotionClient } from "../../../extension/src/lib/notion.ts";
import { notionTools } from "../../../extension/src/lib/tools.ts";
import { CALENDAR_TOOL_NAMES } from "../mcp/calendar-tools.ts";
import { DEFAULT_SETTINGS, type BrainId, type ChatEvent, type ChatRequest, type OverlayMode, type Settings } from "../shared/types.ts";
import { ClaudeBrain } from "./brains/claude.ts";
import { CodexBrain } from "./brains/codex.ts";
import type { Brain, McpServerSpec } from "./brains/types.ts";
import { checkBrain, resolveCli } from "./cli.ts";
import { FrontmostWatcher, isNotionApp, resetFrontmostSupport, shouldShowOverlay, type FrontmostSample } from "./frontmost.ts";
import { getNotionWindow } from "./notion-window.ts";
import { getNotionSelection } from "./selection.ts";
import { buildSystemPrompt, buildUserTurn } from "./prompt.ts";
import { SettingsStore } from "./settings.ts";
import { openTerminal } from "./terminal.ts";
import { pruneChanges, readChanges, rewriteChanges } from "../shared/journal-file.ts";
import type { Change } from "../shared/journal.ts";
import { undoChange } from "./undo.ts";
import { ConversationStore } from "../shared/conversations-file.ts";
import { newConversationId, titleFrom, type Conversation } from "../shared/conversations.ts";

const COLLAPSED = { width: 64, height: 64 };
const EXPANDED = { width: 420, height: 680 };
const MARGIN = 16;

if (process.env.NOTION_ORACLE_USER_DATA) app.setPath("userData", process.env.NOTION_ORACLE_USER_DATA);

const settings = new SettingsStore(app.getPath("userData"));
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let mode: OverlayMode = "collapsed";
let activeRun: AbortController | null = null;
let frontmost: FrontmostSample = { name: null, supported: true };
let watcher: FrontmostWatcher | null = null;
/** Set while the user explicitly opened the panel, so it survives Oracle briefly losing focus. */
let pinnedOpen = false;
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

/** Show or hide the overlay based on the foreground app, without touching the collapsed/expanded mode. */
function applyVisibility(): void {
  if (!win) return;
  const show =
    pinnedOpen ||
    shouldShowOverlay({
      followNotion: settings.get().followNotion,
      detectionSupported: frontmost.supported,
      frontmostApp: frontmost.name,
      oracleFocused: win.isFocused(),
    });
  if (show && !win.isVisible()) win.showInactive();
  else if (!show && win.isVisible()) win.hide();
}

function setMode(next: OverlayMode): void {
  mode = next;
  placeWindow(next === "expanded" ? EXPANDED : COLLAPSED);
  win?.webContents.send("oracle:mode", next);
  // An expanded panel stays put until the user closes it; collapsing hands control back to
  // foreground tracking so the pill disappears when they leave Notion.
  pinnedOpen = next === "expanded";
  if (next === "expanded") {
    win?.show();
    win?.focus();
  } else {
    applyVisibility();
  }
}

function startFrontmostWatcher(): void {
  watcher?.stop();
  watcher = new FrontmostWatcher({
    onChange: (sample) => {
      frontmost = sample;
      // Leaving Notion for another app closes the panel rather than leaving it floating.
      if (mode === "expanded" && sample.supported && sample.name !== null && !isNotionApp(sample.name) && !win?.isFocused()) {
        pinnedOpen = false;
        setMode("collapsed");
        return;
      }
      applyVisibility();
    },
  });
  watcher.start();
}

function createWindow(): void {
  win = new BrowserWindow({
    ...COLLAPSED,
    frame: false,
    transparent: true,
    // The overlay is shown without stealing focus, so without this the first click on it is
    // consumed just to activate the window instead of pressing what the user aimed at.
    acceptFirstMouse: true,
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
  win.on("focus", () => applyVisibility());
  win.on("blur", () => applyVisibility());
  win.once("ready-to-show", () => {
    placeWindow(COLLAPSED);
    // First launch: open straight into setup, regardless of what is in the foreground.
    if (!settings.get().setupComplete) setMode("expanded");
    else applyVisibility();
  });
  win.on("closed", () => (win = null));
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(__dirname, "../tray.png"));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip(`Notion Oracle ${app.getVersion()}`);
  const refreshMenu = () => {
    const menu = Menu.buildFromTemplate([
      // app.getVersion() reads package.json, the same source the renderer's version is built from.
      { label: `Notion Oracle ${app.getVersion()}`, enabled: false },
      { type: "separator" },
      { label: "Open Oracle", click: () => setMode("expanded") },
      {
        label: "Only show over Notion",
        type: "checkbox",
        checked: settings.get().followNotion,
        click: (item) => {
          settings.update({ followNotion: item.checked });
          resetFrontmostSupport();
          startFrontmostWatcher();
          applyVisibility();
          refreshMenu();
        },
      },
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
    globalShortcut.register(accelerator, () => {
      // The hotkey is the escape hatch: it opens the panel even when the overlay is hidden
      // because Notion is not in front.
      if (mode === "expanded" && win?.isVisible()) setMode("collapsed");
      else setMode("expanded");
    });
  } catch {
    // Invalid accelerator; the tray still works.
  }
}

async function openExternal(url: string): Promise<void> {
  // Send Notion links to the desktop app instead of the browser.
  const target = /^https:\/\/(www\.)?notion\.so\//.test(url) ? url.replace(/^https:\/\//, "notion://") : url;
  await shell.openExternal(target);
}

function serverScriptPath(file: string): string {
  const sep = process.platform === "win32" ? "\\" : "/";
  return join(app.getAppPath(), "dist", "mcp", file).replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
}

/** Electron's own binary doubles as Node for the tool servers, so users need nothing else installed. */
const NODE_ENV = { ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1" };

function mcpSpecs(current: Settings): McpServerSpec[] {
  const servers: McpServerSpec[] = [
    {
      name: "notion",
      command: process.execPath,
      args: [serverScriptPath("notion-server.js")],
      env: {
        ...NODE_ENV,
        NOTION_TOKEN: current.notionToken,
        ORACLE_JOURNAL: journalPath(),
        ORACLE_CONTENT_SEARCH: current.contentSearch ? "1" : "0",
        ORACLE_BULK_EDIT: current.bulkEdit ? "1" : "0",
      },
      // The allow-list must match what the server exposes, or an enabled tool is never callable.
      toolNames: notionTools({ contentSearch: current.contentSearch, bulkEdit: current.bulkEdit }).map((t) => t.name),
    },
  ];
  if (current.calendarAutomation && (process.platform === "darwin" || process.platform === "win32")) {
    servers.push({
      name: "calendar",
      command: process.execPath,
      args: [serverScriptPath("calendar-server.js")],
      env: { ...NODE_ENV, CALENDAR_AUTO_SAVE: current.calendarAutoSave ? "1" : "0", CALENDAR_STRATEGY: current.calendarStrategy, CALENDAR_BACKEND: current.calendarBackend, CALENDAR_STATE_DIR: app.getPath("userData"), ORACLE_JOURNAL: journalPath() },
      toolNames: [...CALENDAR_TOOL_NAMES],
    });
  }
  return servers;
}

const journalPath = (): string => join(app.getPath("userData"), "changes.jsonl");

let conversations: ConversationStore | null = null;
const store = (): ConversationStore => (conversations ??= new ConversationStore(app.getPath("userData")));

/**
 * Loads the conversation this turn belongs to, or starts one.
 *
 * The user's message is written before the run so a crash mid-reply still leaves a record of what
 * was asked, which is what makes the conversation worth reopening at all.
 */
function openConversation(request: ChatRequest): Conversation {
  const now = new Date().toISOString();
  const existing = request.conversationId ? store().get(request.conversationId) : null;
  const conversation: Conversation = existing ?? {
    id: request.conversationId ?? newConversationId(),
    threadId: request.threadId,
    title: titleFrom(request.text),
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  conversation.messages.push({ role: "user", text: request.text });
  conversation.updatedAt = now;
  store().save(conversation);
  return conversation;
}

/** Entries written since `since`, which is how a turn reports only its own changes. */
function changesSince(since: string): Change[] {
  return readChanges(journalPath()).filter((c) => c.at > since);
}

async function runChat(request: ChatRequest): Promise<void> {
  // Stamped centrally so no event can escape without saying which run produced it.
  const send = (event: ChatEvent) => win?.webContents.send("oracle:chat-event", { ...event, runId: request.runId });
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
  // Sampled before the run so the turn reports what it changed, not the whole history.
  const startedAt = new Date().toISOString();
  const conversation = openConversation(request);
  const withChanges = (event: ChatEvent) => {
    if (event.type === "done") {
      // Saved with the CLI's session id attached: that is what lets a reopened conversation carry
      // on rather than start over with the transcript merely redrawn.
      conversation.threadId = event.threadId ?? conversation.threadId;
      if (event.text.trim()) conversation.messages.push({ role: "assistant", text: event.text });
      conversation.updatedAt = new Date().toISOString();
      store().save(conversation);
      send({ ...event, changes: changesSince(startedAt), conversationId: conversation.id });
      return;
    }
    send(event);
  };
  try {
    // Read together: both shell out, and the selection must reflect the moment of sending.
    const [window, selection] = await Promise.all([
      getNotionWindow(),
      current.readSelection ? getNotionSelection() : Promise.resolve(null),
    ]);
    const hint = { notionWindowTitle: window.title, windowStatus: window.status, selection };
    await brain.run({
      cliPath,
      prompt: buildUserTurn(request.text, hint),
      systemPrompt: buildSystemPrompt(current.customInstructions, { calendar: current.calendarAutomation, calendarAutoSave: current.calendarAutoSave, contentSearch: current.contentSearch, bulkEdit: current.bulkEdit }),
      threadId: request.threadId,
      mcpServers: mcpSpecs(current),
      model: current.model,
      cwd,
      tempDir,
      signal: controller.signal,
      onEvent: withChanges,
    });
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error), threadId: request.threadId });
  } finally {
    if (activeRun === controller) activeRun = null;
    // Between runs, with no child process appending, is the only safe moment to rewrite.
    pruneChanges(journalPath());
  }
}

function registerIpc(): void {
  ipcMain.handle("oracle:get-settings", () => settings.get());
  ipcMain.handle("oracle:save-settings", (_e, patch: Partial<Settings>) => {
    const next = settings.update(patch);
    registerHotkey();
    if (patch.followNotion !== undefined) {
      resetFrontmostSupport();
      startFrontmostWatcher();
    }
    applyVisibility();
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
  ipcMain.handle("oracle:page-hint", async () => {
    const [window, selection] = await Promise.all([
      getNotionWindow(),
      settings.get().readSelection ? getNotionSelection() : Promise.resolve(null),
    ]);
    return { notionWindowTitle: window.title, windowStatus: window.status, selection };
  });
  ipcMain.handle("oracle:platform", () => process.platform);
  ipcMain.handle("oracle:chat-send", (_e, request: ChatRequest) => void runChat(request));
  ipcMain.handle("oracle:chat-abort", () => activeRun?.abort());
  ipcMain.handle("oracle:get-changes", () => readChanges(journalPath()));
  ipcMain.handle("oracle:clear-changes", () => rewriteChanges(journalPath(), () => null));
  ipcMain.handle("oracle:list-conversations", () => store().list());
  ipcMain.handle("oracle:get-conversation", (_e, id: string) => store().get(id));
  ipcMain.handle("oracle:delete-conversation", (_e, id: string) => store().remove(id));
  ipcMain.handle("oracle:undo-change", async (_e, id: string) => {
    const change = readChanges(journalPath()).find((c) => c.id === id);
    if (!change) return { ok: false, message: "That change is no longer in the list." };
    if (change.undone) return { ok: false, message: "Already undone." };
    const token = settings.get().notionToken;
    try {
      const result = await undoChange(change, token ? new NotionClient(token) : null);
      // Marked only on success, so a failed undo stays available to retry.
      if (result.ok) rewriteChanges(journalPath(), (c) => (c.id === id ? { ...c, undone: true } : c));
      return result;
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
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
    startFrontmostWatcher();
  });
  // Keep running in the tray when the overlay window is closed.
  app.on("window-all-closed", () => undefined);
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    watcher?.stop();
  });
}
