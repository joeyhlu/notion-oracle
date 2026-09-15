/** Overlay UI: a collapsed pill, the chat panel, and the setup/settings view. */

import { markdownToHtml } from "../../../extension/src/lib/markdown.ts";
import { BRAIN_LABELS, INSTALL_COMMANDS, INSTALL_DOCS, asTheme, type BrainId, type Change, type ChatEvent, type Settings, type Theme } from "../shared/types.ts";
import { summarise } from "../shared/journal.ts";
import { titleFrom, type Conversation } from "../shared/conversations.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

type View = "chat" | "setup" | "help" | "changes" | "history";

/** Baked in by the build from package.json, so it cannot drift from what was released. */
const VERSION = __APP_VERSION__;

const QUICK_ACTIONS = [
  "Summarize the page I'm looking at",
  "What\u2019s on my calendar this week?",
  "Turn this page into a to-do list and add it to the end",
  "Create a page under this one with an outline for…",
];

let settings: Settings;
let threadId: string | null = null;
/** Which saved conversation the current chat is; null until the first message creates one. */
let conversationId: string | null = null;
/**
 * The run whose events this panel is still interested in.
 *
 * Aborting does not un-start the run already going in the main process, so its events keep
 * arriving. Without this, starting a new chat and sending again let the old run's "done" land on
 * the new turn — handing back the thread id the new chat had just been told to forget, and ending
 * its spinner while it was still working.
 */
let currentRunId: string | null = null;
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

function showView(view: View): void {
  $("view-chat").hidden = view !== "chat";
  $("view-setup").hidden = view !== "setup";
  $("view-help").hidden = view !== "help";
  $("view-changes").hidden = view !== "changes";
  $("view-history").hidden = view !== "history";
  if (view === "changes") void renderChanges();
  if (view === "history") void renderHistory();
  if (view === "setup") void loadSetupForm();
  else if (view === "chat") {
    // Re-read on the way back in: the user may have just granted the permission in setup, or
    // switched to a different Notion page while the panel was on another screen.
    void refreshLookingAt();
    setTimeout(() => $("input").focus(), 50);
  }
}

async function refreshLookingAt(): Promise<void> {
  const line = $("looking-at");
  try {
    const hint = await window.oracle.getPageHint();
    const blocked = hint.windowStatus === "no-permission";
    if (!hint.notionWindowTitle && !hint.selection && !blocked) {
      line.hidden = true;
      return;
    }
    line.hidden = false;
    line.replaceChildren();
    if (hint.notionWindowTitle) {
      line.append("Looking at ", el2("strong", hint.notionWindowTitle));
    } else if (blocked) {
      // Notion is open and Oracle cannot read the title. Say so here rather than leaving the user
      // to discover it from a reply claiming Notion is not running.
      line.append(el2("span", "Can\u2019t read the open page \u2014 ", "warn"));
      const fix = el("button", "link-btn", "how to fix") as HTMLButtonElement;
      fix.addEventListener("click", () => {
        showView("help");
        openFaq("window-permission");
      });
      line.appendChild(fix);
    }
    // Say so when a selection is in play: the user should know what Oracle can see before
    // sending, not discover it from the answer.
    if (hint.selection) {
      if (hint.notionWindowTitle) line.append(" · ");
      line.append(el2("span", `${countWords(hint.selection)} selected`, "selected"));
    }
  } catch {
    line.hidden = true;
  }
}

// ---------- Chat ----------

const messages = () => $("messages");

/** A small element with optional text and class, for building the looking-at line. */
function el2(tag: string, text: string, className = ""): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function countWords(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words === 1 ? "1 word" : `${words} words`;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderEmpty(): void {
  messages().replaceChildren();
  showSuggestions(true);
  const empty = el("div", "empty");
  empty.innerHTML = "<strong>Hi, I'm Oracle.</strong>Ask about the page you have open in Notion, draft content, or add events to a calendar. Everything I change shows up in Notion right away.";
  messages().appendChild(empty);
}

/** The suggestion row is part of the empty state: an opener, not a permanent toolbar. */
function showSuggestions(show: boolean): void {
  $("quick").hidden = !show;
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
  showSuggestions(false);
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
  currentRunId = `r${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await window.oracle.chatSend({ text: trimmed, runId: currentRunId, threadId, conversationId });
}

function handleEvent(event: ChatEvent): void {
  // A run the user has moved on from. Its events are history, not this conversation's.
  if (event.runId && event.runId !== currentRunId) return;
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
    case "done": {
      threadId = event.threadId;
      conversationId = event.conversationId ?? conversationId;
      finishTurn();
      if (turn.raw.trim()) addActions(turn.container, turn.raw);
      // What actually changed, from the journal rather than from the model's own account of it:
      // a reply that says "done!" after a tool failed should not claim an edit happened.
      const line = summarise(event.changes ?? []);
      if (line) turn.container.appendChild(changeFootnote(line));
      break;
    }
    case "error":
      finishTurn();
      if (!turn.raw.trim()) turn.body.remove();
      showError(event.message);
      break;
  }
}

/** The "changed 3 blocks" line under a reply, with a way through to the list. */
function changeFootnote(line: string): HTMLElement {
  const node = el("div", "change-note");
  node.appendChild(el("span", "change-note-text", line));
  const review = el("button", "link-btn", "Review") as HTMLButtonElement;
  review.addEventListener("click", () => showView("changes"));
  node.appendChild(review);
  return node;
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
  // Without this, "new conversation" keeps appending to the saved one it just left.
  conversationId = null;
  // Stop listening to the run being aborted, which may still report back.
  currentRunId = null;
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
  $<HTMLInputElement>("read-selection").checked = settings.readSelection;
  $<HTMLInputElement>("content-search").checked = settings.contentSearch;
  $<HTMLInputElement>("bulk-edit").checked = settings.bulkEdit;
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
    readSelection: $<HTMLInputElement>("read-selection").checked,
    contentSearch: $<HTMLInputElement>("content-search").checked,
    bulkEdit: $<HTMLInputElement>("bulk-edit").checked,
    calendarAutomation: $<HTMLInputElement>("calendar-automation").checked,
    calendarAutoSave: $<HTMLInputElement>("calendar-autosave").checked,
    calendarStrategy: $<HTMLSelectElement>("calendar-strategy").value === "command-bar" ? "command-bar" : "new-event-key",
    calendarBackend: $<HTMLSelectElement>("calendar-backend").value === "notion-app" ? "notion-app" : "system",
    theme: asTheme(document.documentElement.dataset.theme ?? "system"),
    setupComplete: true,
  };
  const cliPath = $<HTMLInputElement>("cli-path").value.trim();
  if (brain === "claude") patch.claudePath = cliPath;
  else patch.codexPath = cliPath;
  settings = await window.oracle.saveSettings(patch);
  $("brain-label").textContent = BRAIN_LABELS[settings.brain];
  $("save-status").textContent = "Saved.";
  // Changing brain or model means the CLI session no longer applies.
  threadId = null;
  conversationId = null;
  void refreshSetupStatus();
  showView("chat");
}


/** Answers to what actually goes wrong, in the order people hit it. */
/** `id` lets a link elsewhere in the app open one entry without matching on its wording. */
const FAQ: Array<{ q: string; a: string; id?: string }> = [
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
    id: "window-permission",
    q: "Oracle says it can\u2019t see the page I have open",
    a: "<p>Reading the Notion window\u2019s title needs the macOS <strong>Automation</strong> permission, which is a different grant from the one that makes the \u25ce button appear \u2014 so the button can work perfectly while this does not.</p><p>Open <strong>System Settings \u2192 Privacy &amp; Security \u2192 Automation</strong>, find <strong>Notion Oracle</strong>, and switch on <strong>Notion</strong> (and <strong>System Events</strong> if it is listed). Then quit Oracle and reopen it \u2014 a running app keeps the answer it was given at launch.</p><p>If Notion Oracle is not listed at all, macOS has not asked yet: send Oracle a message mentioning \u201cthis page\u201d and the prompt should appear.</p><p>Until then Oracle still works \u2014 name the page in your message, or let it list your recently edited pages and pick one.</p>",
  },
  {
    id: "selection-permission",
    q: "Oracle cannot see what I have highlighted",
    a: "<p>Reading your selection needs the macOS <strong>Accessibility</strong> permission, which is a different one from the calendar and automation prompts. Open <strong>System Settings → Privacy &amp; Security → Accessibility</strong> and switch on <strong>Notion Oracle</strong>, then quit and reopen it.</p><p>When it is working, the line above the message box says how many words are selected. If you would rather Oracle never read it, turn off <strong>Use the text I have highlighted in Notion</strong> in Setup → Preferences; everything else keeps working.</p>",
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
    if (entry.id) item.dataset.faq = entry.id;
    const q = el("button", "faq-q") as HTMLButtonElement;
    q.append(document.createTextNode(entry.q), el("span", "chev", "\u203a"));
    const a = el("div", "faq-a");
    a.innerHTML = entry.a;
    q.addEventListener("click", () => item.classList.toggle("open"));
    item.append(q, a);
    host.appendChild(item);
  }
}


/**
 * Paints the chosen appearance and marks the segmented control.
 *
 * "system" deliberately removes the attribute rather than resolving it here: the stylesheet
 * already follows prefers-color-scheme, so leaving it unstamped keeps the OS in charge and the
 * window repaints when the OS flips without the renderer having to watch for it.
 */
function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  for (const seg of document.querySelectorAll<HTMLButtonElement>("#theme-toggle .seg")) {
    const chosen = seg.dataset.themeValue === theme;
    seg.classList.toggle("active", chosen);
    seg.setAttribute("aria-checked", String(chosen));
  }
}

/** Short relative time: a change list is read in the minutes after the change. */
function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function renderHistory(): Promise<void> {
  const host = $("history");
  const saved = await window.oracle.listConversations();
  host.replaceChildren();
  if (!saved.length) {
    host.appendChild(el("div", "empty", "No saved conversations yet. They are kept on this machine once you send a message."));
    return;
  }
  for (const item of saved) {
    const row = el("div", `change${item.id === conversationId ? " current" : ""}`);
    const main = el("div", "change-main");
    main.append(el("div", "change-label", item.title), el("div", "change-when", `${ago(item.updatedAt)} · ${item.messageCount} message${item.messageCount === 1 ? "" : "s"}`));
    main.addEventListener("click", () => void openConversation(item.id));
    row.appendChild(main);

    const remove = el("button", "chip", "Delete") as HTMLButtonElement;
    remove.addEventListener("click", async () => {
      await window.oracle.deleteConversation(item.id);
      // Deleting the open conversation leaves the panel showing a thread that no longer exists.
      if (item.id === conversationId) startNewConversation();
      void renderHistory();
    });
    row.appendChild(remove);
    host.appendChild(row);
  }
}

/** Redraws a saved conversation and points the next turn at the CLI session that produced it. */
async function openConversation(id: string): Promise<void> {
  const conversation = await window.oracle.getConversation(id);
  if (!conversation) {
    void renderHistory();
    return;
  }
  if (busy) void window.oracle.chatAbort();
  currentRunId = null;
  currentTurn = null;
  setBusy(false);
  conversationId = conversation.id;
  threadId = conversation.threadId;
  messages().replaceChildren();
  showSuggestions(conversation.messages.length === 0);
  for (const message of conversation.messages) {
    if (message.role === "user") messages().appendChild(el("div", "msg user", message.text));
    else renderSavedReply(message.text);
  }
  showView("chat");
  scrollToBottom();
}

/** A saved assistant turn: the Markdown is re-rendered, but its tool log is not kept. */
function renderSavedReply(text: string): void {
  const container = el("div", "msg assistant");
  const body = el("div", "body");
  body.innerHTML = markdownToHtml(text);
  container.appendChild(body);
  addActions(container, text);
  messages().appendChild(container);
}

function startNewConversation(): void {
  resetConversation();
}

async function renderChanges(): Promise<void> {
  const host = $("changes");
  const changes = await window.oracle.getChanges();
  host.replaceChildren();
  $("changes-note").textContent = changes.length ? `${changes.length} recorded` : "";
  if (!changes.length) {
    host.appendChild(el("div", "empty", "Nothing yet. Anything Oracle changes in Notion or your calendar shows up here."));
    return;
  }
  for (const change of changes) host.appendChild(changeRow(change));
}

function changeRow(change: Change): HTMLElement {
  const row = el("div", `change${change.undone ? " undone" : ""}`);
  const main = el("div", "change-main");
  main.append(el("div", "change-label", change.label), el("div", "change-when", ago(change.at)));
  row.appendChild(main);

  if (change.url) {
    const open = el("button", "chip", "Open") as HTMLButtonElement;
    open.addEventListener("click", () => void window.oracle.openExternal(change.url!));
    row.appendChild(open);
  }

  if (change.undone) {
    row.appendChild(el("span", "change-state", "undone"));
    return row;
  }
  if (!change.undo) {
    // Better to say why than to show a button that will fail.
    row.appendChild(el("span", "change-state", "cannot undo"));
    return row;
  }
  const undo = el("button", "chip", "Undo") as HTMLButtonElement;
  undo.addEventListener("click", async () => {
    undo.disabled = true;
    undo.textContent = "Undoing…";
    const result = await window.oracle.undoChange(change.id);
    if (result.ok) {
      void renderChanges();
    } else {
      undo.disabled = false;
      undo.textContent = "Undo";
      row.appendChild(el("div", "change-error", result.message));
    }
  });
  row.appendChild(undo);
  return row;
}

/** Opens one setup step and closes the others, so the screen never becomes a wall of forms. */
/** Opens one FAQ entry by id and scrolls to it. Matching on wording would break on a reword. */
function openFaq(id: string): void {
  for (const item of document.querySelectorAll<HTMLElement>("#faq .faq-item")) {
    const match = item.dataset.faq === id;
    item.classList.toggle("open", match);
    if (match) item.scrollIntoView({ block: "start" });
  }
}

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

  const power = [settings.contentSearch && "deep search", settings.bulkEdit && "bulk edits"].filter(Boolean) as string[];
  setBadge("power", power.length ? "ok" : "optional", power.length ? power.join(" · ") : "Off");

  if (!settings.calendarAutomation) setBadge("calendar", "optional", "Turned off");
  else if (settings.calendarBackend === "system" && (platform === "darwin" || platform === "win32")) setBadge("calendar", "ok", platform === "win32" ? "Outlook" : "macOS Calendar");
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
/** Stamps the version wherever the markup asks for it. */
function showVersion(): void {
  for (const slot of document.querySelectorAll<HTMLElement>("[data-version]")) {
    slot.textContent = `Version ${VERSION}`;
    slot.title = `Notion Oracle ${VERSION}`;
  }
}

function wireControls(): void {
  showVersion();
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
  $("btn-changes").addEventListener("click", () => showView($("view-changes").hidden ? "changes" : "chat"));
  $("btn-history").addEventListener("click", () => showView($("view-history").hidden ? "history" : "chat"));
  $("btn-new-from-history").addEventListener("click", () => {
    startNewConversation();
    showView("chat");
  });
  $("btn-clear-changes").addEventListener("click", async () => {
    await window.oracle.clearChanges();
    void renderChanges();
  });
  $("btn-help-setup").addEventListener("click", () => showView("setup"));

  $("theme-toggle").addEventListener("click", (event) => {
    const seg = (event.target as HTMLElement).closest<HTMLButtonElement>(".seg");
    if (!seg) return;
    const theme = asTheme(seg.dataset.themeValue);
    applyTheme(theme);
    // Persisted straight away rather than on Save, so the choice survives a restart even if the
    // user just came to change the colour and closed the panel.
    void window.oracle.saveSettings({ theme }).then((next) => { settings = next; });
  });
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
  applyTheme(settings.theme);
  $("brain-label").textContent = BRAIN_LABELS[settings.brain];
  showView(settings.setupComplete ? "chat" : "setup");
  void refreshSetupStatus();
}

wireControls();
void loadState().catch((error) => {
  console.error("Oracle: could not load settings", error);
  $("brain-label").textContent = "Settings unavailable";
});
