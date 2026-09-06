/** Overlay UI: a collapsed pill, the chat panel, and the setup/settings view. */

import { markdownToHtml } from "../../../extension/src/lib/markdown.ts";
import { BRAIN_LABELS, INSTALL_COMMANDS, INSTALL_DOCS, type BrainId, type ChatEvent, type Settings } from "../shared/types.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const QUICK_ACTIONS = [
  "Summarize the page I'm looking at",
  "What's on my calendar this week?",
  "Turn this page into a to-do list and add it to the end",
  "Create a page under this one with an outline for…",
];

let settings: Settings;
let threadId: string | null = null;
let busy = false;
let platform: NodeJS.Platform = "darwin";

// ---------- Mode ----------

function applyMode(mode: "collapsed" | "expanded"): void {
  document.body.classList.toggle("collapsed", mode === "collapsed");
  document.body.classList.toggle("expanded", mode === "expanded");
  if (mode === "expanded") {
    void refreshLookingAt();
    setTimeout(() => $("input").focus(), 50);
  }
}

// ---------- Views ----------

function showView(view: "chat" | "setup"): void {
  $("view-chat").hidden = view !== "chat";
  $("view-setup").hidden = view !== "setup";
  if (view === "setup") void loadSetupForm();
  else setTimeout(() => $("input").focus(), 50);
}

async function refreshLookingAt(): Promise<void> {
  const el = $("looking-at");
  try {
    const hint = await window.oracle.getPageHint();
    if (hint.notionWindowTitle) {
      el.hidden = false;
      el.innerHTML = `Looking at <strong></strong>`;
      el.querySelector("strong")!.textContent = hint.notionWindowTitle;
    } else el.hidden = true;
  } catch {
    el.hidden = true;
  }
}

// ---------- Chat ----------

const messages = () => $("messages");

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderEmpty(): void {
  messages().replaceChildren();
  const empty = el("div", "empty");
  empty.innerHTML = "<strong>Hi, I'm Oracle.</strong><br>Ask about the page you have open in Notion, draft content, or add events to a calendar. Everything I change shows up in Notion right away.";
  messages().appendChild(empty);
}

function scrollToBottom(): void {
  messages().scrollTop = messages().scrollHeight;
}

function setBusy(next: boolean): void {
  busy = next;
  const send = $<HTMLButtonElement>("send");
  send.textContent = next ? "Stop" : "Send";
  send.classList.toggle("stop", next);
}

function showError(message: string): void {
  const node = el("div", "msg assistant");
  const err = el("div", "error", message);
  if (/settings|install|sign in/i.test(message)) {
    err.appendChild(document.createTextNode(" "));
    const link = document.createElement("a");
    link.href = "#";
    link.textContent = "Open settings";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      showView("setup");
    });
    err.appendChild(link);
  }
  node.appendChild(err);
  messages().appendChild(node);
  scrollToBottom();
}

let currentTurn: { body: HTMLElement; tools: HTMLElement; thinking: HTMLElement; status: HTMLElement; raw: string; toolNodes: Map<string, HTMLElement>; container: HTMLElement } | null = null;

async function send(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed || busy) return;
  const input = $<HTMLTextAreaElement>("input");
  input.value = "";
  input.style.height = "auto";
  messages().querySelector(".empty")?.remove();
  messages().appendChild(el("div", "msg user", trimmed));

  const container = el("div", "msg assistant");
  const tools = el("div", "tools");
  const status = el("div", "thinking", "Starting");
  const thinking = el("div", "thinking", "Thinking");
  thinking.hidden = true;
  const body = el("div", "body");
  container.append(tools, status, thinking, body);
  messages().appendChild(container);
  scrollToBottom();
  currentTurn = { body, tools, thinking, status, raw: "", toolNodes: new Map(), container };
  setBusy(true);
  await window.oracle.chatSend({ text: trimmed, threadId });
}

function handleEvent(event: ChatEvent): void {
  const turn = currentTurn;
  if (!turn) return;
  switch (event.type) {
    case "status":
      turn.status.textContent = event.message;
      turn.status.hidden = false;
      turn.thinking.hidden = event.message.startsWith("Connected") ? false : true;
      if (event.message.startsWith("Connected")) turn.status.hidden = true;
      break;
    case "text":
      turn.status.hidden = true;
      turn.thinking.hidden = true;
      turn.raw += event.delta;
      turn.body.innerHTML = markdownToHtml(turn.raw);
      scrollToBottom();
      break;
    case "tool-start": {
      turn.status.hidden = true;
      turn.thinking.hidden = true;
      const node = el("div", "tool running");
      node.append(el("span", "name", event.name), el("span", "status", "running"));
      turn.tools.appendChild(node);
      turn.toolNodes.set(event.id, node);
      scrollToBottom();
      break;
    }
    case "tool-end": {
      const node = turn.toolNodes.get(event.id);
      if (node) {
        node.classList.remove("running");
        node.classList.toggle("error", !event.ok);
        node.querySelector(".status")!.textContent = event.ok ? "done" : "failed";
        node.appendChild(el("span", "summary", event.summary));
        node.title = event.summary;
      }
      turn.thinking.hidden = false;
      break;
    }
    case "done":
      threadId = event.threadId;
      finishTurn();
      if (turn.raw.trim()) addActions(turn.container, turn.raw);
      break;
    case "error":
      finishTurn();
      if (!turn.raw.trim()) turn.body.remove();
      showError(event.message);
      break;
  }
}

function finishTurn(): void {
  if (currentTurn) {
    currentTurn.status.remove();
    currentTurn.thinking.remove();
  }
  setBusy(false);
  currentTurn = null;
}

function addActions(container: HTMLElement, text: string): void {
  const actions = el("div", "actions");
  const copy = el("button", "chip", "Copy") as HTMLButtonElement;
  copy.addEventListener("click", () => void navigator.clipboard.writeText(text).then(() => (copy.textContent = "Copied ✓")));
  actions.append(copy);
  container.appendChild(actions);
}

function resetConversation(): void {
  if (busy) void window.oracle.chatAbort();
  threadId = null;
  currentTurn = null;
  setBusy(false);
  renderEmpty();
}

// ---------- Setup ----------

function selectedBrain(): BrainId {
  return (document.querySelector<HTMLInputElement>('input[name="brain"]:checked')?.value ?? "claude") as BrainId;
}

async function loadSetupForm(): Promise<void> {
  settings = await window.oracle.getSettings();
  document.querySelector<HTMLInputElement>(`input[name="brain"][value="${settings.brain}"]`)!.checked = true;
  $<HTMLInputElement>("cli-path").value = settings.brain === "claude" ? settings.claudePath : settings.codexPath;
  $<HTMLInputElement>("model").value = settings.model;
  $<HTMLInputElement>("notion-token").value = settings.notionToken;
  $<HTMLTextAreaElement>("custom-instructions").value = settings.customInstructions;
  $<HTMLInputElement>("hotkey").value = settings.hotkey;
  $("save-status").textContent = "";
  await checkBrain();
}

async function checkBrain(): Promise<void> {
  const brain = selectedBrain();
  const line = $("brain-status").querySelector<HTMLElement>(".status-line")!;
  line.className = "status-line";
  $("status-icon").textContent = "…";
  $("status-text").textContent = `Checking ${BRAIN_LABELS[brain]}…`;
  const status = await window.oracle.checkBrain(brain, $<HTMLInputElement>("cli-path").value.trim() || undefined);
  const ok = status.installed && status.loggedIn === true;
  line.classList.add(ok ? "ok" : "bad");
  $("status-icon").textContent = ok ? "✓" : "✗";
  $("status-text").textContent = status.installed ? `${BRAIN_LABELS[brain]}: ${status.version ?? "installed"} · ${status.detail}` : status.detail;
  $<HTMLButtonElement>("btn-signin").hidden = !status.installed;
  $("install-help").hidden = status.installed;
  const cmds = INSTALL_COMMANDS[brain];
  $("install-cmd-native").textContent = platform === "win32" ? cmds.win : cmds.mac;
  $("install-cmd-npm").textContent = cmds.npm;
}

async function saveSetup(): Promise<void> {
  const brain = selectedBrain();
  const patch: Partial<Settings> = {
    brain,
    model: $<HTMLInputElement>("model").value.trim(),
    notionToken: $<HTMLInputElement>("notion-token").value.trim(),
    customInstructions: $<HTMLTextAreaElement>("custom-instructions").value,
    hotkey: $<HTMLInputElement>("hotkey").value.trim() || "CommandOrControl+Shift+Space",
    setupComplete: true,
  };
  const cliPath = $<HTMLInputElement>("cli-path").value.trim();
  if (brain === "claude") patch.claudePath = cliPath;
  else patch.codexPath = cliPath;
  settings = await window.oracle.saveSettings(patch);
  $("brain-label").textContent = BRAIN_LABELS[settings.brain];
  $("save-status").textContent = "Saved.";
  threadId = null;
  showView("chat");
}

// ---------- Wiring ----------

async function main(): Promise<void> {
  platform = await window.oracle.platform();
  settings = await window.oracle.getSettings();
  $("brain-label").textContent = BRAIN_LABELS[settings.brain];
  renderEmpty();
  for (const action of QUICK_ACTIONS) {
    const chip = el("button", "chip", action) as HTMLButtonElement;
    chip.addEventListener("click", () => {
      if (action.endsWith("…")) {
        const input = $<HTMLTextAreaElement>("input");
        input.value = action.replace("…", " ");
        input.focus();
      } else void send(action);
    });
    $("quick").appendChild(chip);
  }

  const input = $<HTMLTextAreaElement>("input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send(input.value);
    }
    if (e.key === "Escape") void window.oracle.setMode("collapsed");
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(160, input.scrollHeight)}px`;
  });
  $("send").addEventListener("click", () => (busy ? void window.oracle.chatAbort() : void send(input.value)));
  $("pill").addEventListener("click", () => void window.oracle.setMode("expanded"));
  $("btn-collapse").addEventListener("click", () => void window.oracle.setMode("collapsed"));
  $("btn-new").addEventListener("click", resetConversation);
  $("btn-settings").addEventListener("click", () => showView($("view-setup").hidden ? "setup" : "chat"));

  for (const radio of document.querySelectorAll('input[name="brain"]')) {
    radio.addEventListener("change", () => {
      const brain = selectedBrain();
      $<HTMLInputElement>("cli-path").value = brain === "claude" ? settings.claudePath : settings.codexPath;
      void checkBrain();
    });
  }
  $("btn-recheck").addEventListener("click", () => void checkBrain());
  $("btn-install").addEventListener("click", () => {
    $("install-help").hidden = false;
    void window.oracle.openExternal(INSTALL_DOCS[selectedBrain()]);
  });
  $("btn-signin").addEventListener("click", () => void window.oracle.openSignIn(selectedBrain()));
  $("btn-test-notion").addEventListener("click", async () => {
    const status = $("notion-status");
    status.textContent = "Testing…";
    const result = await window.oracle.testNotion($<HTMLInputElement>("notion-token").value);
    status.textContent = result.message;
    status.style.color = result.ok ? "var(--ok)" : "var(--danger)";
  });
  $("btn-save").addEventListener("click", () => void saveSetup());
  $("btn-quit").addEventListener("click", () => void window.oracle.quit());
  document.addEventListener("click", (e) => {
    const anchor = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
    if (anchor && /^https?:/.test(anchor.href)) {
      e.preventDefault();
      void window.oracle.openExternal(anchor.href);
    }
  });

  window.oracle.onChatEvent(handleEvent);
  window.oracle.onMode(applyMode);
  applyMode("collapsed");
  showView(settings.setupComplete ? "chat" : "setup");
}

void main();
