/** Overlay UI: a collapsed pill, the chat panel, and the setup/settings view. */

import { markdownToHtml } from "../../../extension/src/lib/markdown.ts";
import { BRAIN_LABELS, INSTALL_COMMANDS, INSTALL_DOCS, type BrainId, type ChatEvent, type Settings } from "../shared/types.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const QUICK_ACTIONS = [
  "Summarize the page I'm looking at",
  "What\u2019s on my calendar this week?",
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

function showView(view: "chat" | "setup" | "help"): void {
  $("view-chat").hidden = view !== "chat";
  $("view-setup").hidden = view !== "setup";
  $("view-help").hidden = view !== "help";
  if (view === "setup") void loadSetupForm();
  else if (view === "chat") setTimeout(() => $("input").focus(), 50);
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
  void refreshSetupStatus();
  $<HTMLInputElement>("follow-notion").checked = settings.followNotion;
  $<HTMLInputElement>("calendar-automation").checked = settings.calendarAutomation;
  $<HTMLInputElement>("calendar-autosave").checked = settings.calendarAutoSave;
  $<HTMLSelectElement>("calendar-strategy").value = settings.calendarStrategy;
  $<HTMLSelectElement>("calendar-backend").value = settings.calendarBackend;
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
    followNotion: $<HTMLInputElement>("follow-notion").checked,
    calendarAutomation: $<HTMLInputElement>("calendar-automation").checked,
    calendarAutoSave: $<HTMLInputElement>("calendar-autosave").checked,
    calendarStrategy: $<HTMLSelectElement>("calendar-strategy").value === "command-bar" ? "command-bar" : "new-event-key",
    calendarBackend: $<HTMLSelectElement>("calendar-backend").value === "notion-app" ? "notion-app" : "system",
    setupComplete: true,
  };
  const cliPath = $<HTMLInputElement>("cli-path").value.trim();
  if (brain === "claude") patch.claudePath = cliPath;
  else patch.codexPath = cliPath;
  settings = await window.oracle.saveSettings(patch);
  $("brain-label").textContent = BRAIN_LABELS[settings.brain];
  $("save-status").textContent = "Saved.";
  threadId = null;
  void refreshSetupStatus();
  showView("chat");
}


/** Answers to what actually goes wrong, in the order people hit it. */
const FAQ: Array<{ q: string; a: string }> = [
  {
    q: "Nothing happens when I click the ◎ button",
    a: "<p>Press <strong>⌘⇧Space</strong> (Ctrl⇧Space on Windows) or click the ◎ icon in your menu bar — both open this panel and neither depends on the button.</p><p>If the button itself is dead on an older build, updating fixes it.</p>",
  },
  {
    q: "The ◎ button never appears",
    a: "<p>It only shows while Notion is the app in front, so it stays out of your way everywhere else. Switch to Notion and it should appear.</p><p>If it stays hidden even in Notion, turn off <strong>Only show the ◎ button while Notion is in front</strong> in Setup → Preferences.</p>",
  },
  {
    q: "macOS says the app is “damaged” or can’t be verified",
    a: "<p>The app is signed but not notarized by Apple, which needs a paid developer account. It is not damaged.</p><p>Go to <strong>System Settings → Privacy &amp; Security</strong>, scroll down, and click <strong>Open Anyway</strong>. On older macOS, right-click the app → <strong>Open</strong>.</p><p>If it still refuses, run <code>xattr -cr \"/Applications/Notion Oracle.app\"</code> in Terminal.</p>",
  },
  {
    q: "Oracle can’t find my Notion pages",
    a: "<p>Creating the integration is not enough — each page has to be shared with it.</p><p>In Notion open a top-level page → <strong>•••</strong> → <strong>Connections</strong> → add your integration. Everything nested under that page comes along.</p><p>Ask <em>“what can you see?”</em> to get the full list of what it currently reaches.</p>",
  },
  {
    q: "Oracle can’t find my calendar",
    a: "<p>The Notion Calendar app shows your Google, iCloud or Outlook account — those are not Notion pages, so sharing a Notion integration will never reveal them.</p><p>Instead add that account to macOS: <strong>System Settings → General → Internet Accounts</strong>, tick <strong>Calendars</strong>. Then ask <em>“what calendars do I have?”</em> and approve the permission prompt.</p>",
  },
  {
    q: "My event went to the wrong calendar",
    a: "<p>Say <em>“use my Gmail calendar by default”</em> and Oracle remembers it from then on.</p><p>To fix one that already landed wrong: <em>“move my birthday to my Gmail calendar”</em>.</p><p>Subscribed calendars like holidays are read-only, so Oracle will refuse to write to them rather than putting the event somewhere unexpected.</p>",
  },
  {
    q: "It says macOS blocked access to Calendar",
    a: "<p>Open <strong>System Settings → Privacy &amp; Security → Automation</strong>, find Notion Oracle, and allow it to control <strong>Calendar</strong>.</p><p>If it also asks about Calendars access, choose <strong>Full Access</strong> — “Add Only” blocks reading and deleting.</p><p>This can reappear after an app update, because macOS ties the permission to each build.</p>",
  },
  {
    q: "Does this cost money?",
    a: "<p>No API billing. Oracle runs on the Claude Code or Codex CLI you are already signed in to, so the work counts against your existing Claude or ChatGPT subscription exactly like chatting in those apps.</p>",
  },
  {
    q: "Where does my data go?",
    a: "<p>Your Notion token and settings stay on this machine. Page content goes to whichever AI you signed in to, and calendar changes go through the macOS Calendar app to your own account.</p><p>Nothing is sent anywhere else and there is no telemetry.</p>",
  },
  {
    q: "The keyboard shortcut does nothing",
    a: "<p>Another app has probably claimed it. Use the menu bar icon, or set a different shortcut in Setup → Preferences.</p>",
  },
];

function renderFaq(): void {
  const host = $("faq");
  host.replaceChildren();
  for (const entry of FAQ) {
    const item = el("div", "faq-item");
    const q = el("button", "faq-q") as HTMLButtonElement;
    q.append(document.createTextNode(entry.q), el("span", "chev", "\u203a"));
    const a = el("div", "faq-a");
    a.innerHTML = entry.a;
    q.addEventListener("click", () => item.classList.toggle("open"));
    item.append(q, a);
    host.appendChild(item);
  }
}


/** Opens one setup step and closes the others, so the screen never becomes a wall of forms. */
function openStep(name: string): void {
  for (const step of document.querySelectorAll<HTMLElement>(".step")) {
    step.classList.toggle("open", step.id === `step-${name}`);
  }
}

function setBadge(id: string, state: "ok" | "warn" | "optional" | "pending", note: string): void {
  const badge = $(`badge-${id}`);
  badge.className = `step-badge ${state === "pending" ? "" : state}`.trim();
  badge.textContent = state === "ok" ? "\u2713" : state === "warn" ? "!" : state === "optional" ? "\u2013" : "\u2026";
  $(`note-${id}`).textContent = note;
}

/** Recomputes the badges and the "n of 3 ready" summary, and shows a banner in chat if setup is incomplete. */
async function refreshSetupStatus(): Promise<void> {
  const notionReady = Boolean(settings.notionToken.trim());
  setBadge("notion", notionReady ? "ok" : "warn", notionReady ? "Connected" : "Needed to read your pages");

  if (!settings.calendarAutomation) setBadge("calendar", "optional", "Turned off");
  else if (platform === "darwin" && settings.calendarBackend === "system") setBadge("calendar", "ok", "macOS Calendar");
  else setBadge("calendar", "optional", "Notion Calendar fallback");

  let aiReady = false;
  try {
    const brain = await window.oracle.checkBrain(settings.brain, (settings.brain === "claude" ? settings.claudePath : settings.codexPath) || undefined);
    aiReady = brain.installed && brain.loggedIn === true;
    setBadge("ai", aiReady ? "ok" : "warn", aiReady ? `${BRAIN_LABELS[settings.brain].split(" ")[0]} signed in` : brain.installed ? "Installed, not signed in" : "Not installed");
  } catch {
    setBadge("ai", "warn", "Could not check");
  }

  const ready = [aiReady, notionReady].filter(Boolean).length;
  $("setup-summary").textContent = aiReady && notionReady ? "Everything is ready." : `${ready} of 2 required steps done.`;

  const banner = $("setup-banner");
  banner.hidden = aiReady;
  $("setup-banner-text").textContent = aiReady ? "" : "Oracle needs an AI account before it can answer.";
  // Open the first thing that still needs attention.
  if (!aiReady) openStep("ai");
  else if (!notionReady) openStep("notion");
}

// ---------- Wiring ----------

/**
 * Attaches every control synchronously. This runs before any IPC: when the pill's listener was
 * registered after awaiting settings, a slow or failed round-trip left the button doing nothing
 * while the rest of the window looked fine.
 */
function wireControls(): void {
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
  const pill = $("pill");
  const openPanel = () => void window.oracle.setMode("expanded");
  pill.addEventListener("click", openPanel);
  // mousedown too: it fires earlier, so the panel still opens if anything swallows the click.
  pill.addEventListener("mousedown", openPanel);
  $("btn-collapse").addEventListener("click", () => void window.oracle.setMode("collapsed"));
  $("btn-new").addEventListener("click", resetConversation);
  $("btn-settings").addEventListener("click", () => showView($("view-setup").hidden ? "setup" : "chat"));
  $("btn-help").addEventListener("click", () => showView($("view-help").hidden ? "help" : "chat"));
  $("btn-help-setup").addEventListener("click", () => showView("setup"));
  $("banner-setup").addEventListener("click", () => showView("setup"));
  for (const head of document.querySelectorAll<HTMLElement>(".step-head")) {
    head.addEventListener("click", () => {
      const step = head.closest<HTMLElement>(".step");
      if (step) step.classList.contains("open") ? step.classList.remove("open") : openStep(head.dataset.step ?? "");
    });
  }
  renderFaq();

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
}

/** Everything that needs the main process. Kept separate so a failure here cannot disable the UI. */
async function loadState(): Promise<void> {
  platform = await window.oracle.platform();
  settings = await window.oracle.getSettings();
  $("brain-label").textContent = BRAIN_LABELS[settings.brain];
  showView(settings.setupComplete ? "chat" : "setup");
  void refreshSetupStatus();
}

wireControls();
void loadState().catch((error) => {
  console.error("Oracle: could not load settings", error);
  $("brain-label").textContent = "Settings unavailable";
});
