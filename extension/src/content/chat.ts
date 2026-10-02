/** The chat window: Oracle's equivalent of the Notion AI chat. */

import { markdownToHtml } from "../lib/markdown.ts";
import { describeTool, isWriteTool } from "../lib/activity.ts";
import { ageGroup, newConversationId, titleFrom, type Conversation, type ToolLine, type TranscriptEntry } from "../lib/conversations.ts";
import type { BackgroundToPanel, PageContext, Source, Status, StoredChange } from "../shared/types.ts";
import { getPageIdFromUrl, getPageTitle, getSelectionText, insertText } from "./page.ts";
import { ask, run, type RunHandle } from "./port.ts";
import { deleteConversation, listChanges, listConversations, loadConversation, readUiState, saveConversation, writeUiState } from "./storage.ts";
import { el, icon, iconButton, mark, plural, textButton, wordCount } from "./ui.ts";

interface Suggestion {
  icon: string;
  label: string;
  prompt: string;
  /** Put the text in the box for the user to finish instead of sending it. */
  draft?: boolean;
  needsNotion?: boolean;
}

const SUGGESTIONS: Suggestion[] = [
  { icon: "summarize", label: "Summarize this page", prompt: "Summarize this page in a few bullet points." },
  { icon: "todo", label: "Find action items", prompt: "List the action items and open questions on this page as a to-do list." },
  { icon: "question", label: "Ask about this page", prompt: "", draft: true },
  { icon: "page", label: "Search my workspace", prompt: "Find what my workspace says about ", draft: true, needsNotion: true },
  { icon: "pen", label: "Draft a follow-up email", prompt: "Draft a short follow-up email based on this page." },
];

interface PageHit {
  id: string;
  title: string;
  url: string;
  kind: "page" | "database";
}

/** A reply as it streams in. */
class Turn {
  readonly root = el("div", "msg assistant");
  private readonly activity = el("details", "activity");
  private readonly summary = el("summary");
  private readonly summaryLabel = el("span", "label");
  private readonly list = el("ul");
  private readonly body = el("div", "body");
  private readonly working = el("div", "working");
  private readonly tools = new Map<string, { line: ToolLine; li: HTMLElement }>();
  text = "";
  sources: Source[] = [];
  changes: StoredChange[] = [];

  constructor() {
    this.activity.hidden = true;
    this.summary.append(icon("chevron", 12), this.summaryLabel);
    this.activity.append(this.summary, this.list);
    this.working.append(el("span", "spinner"), el("span", "", "Thinking"));
    this.root.append(this.activity, this.working, this.body);
  }

  appendText(delta: string): void {
    this.text += delta;
    this.working.hidden = true;
    this.body.innerHTML = markdownToHtml(this.text);
  }

  toolStarted(id: string, name: string, input: unknown): void {
    const line: ToolLine = { label: describeTool(name, input), ok: true, write: isWriteTool(name) };
    const li = el("li");
    li.append(el("span", "spinner"), el("span", "", line.label));
    this.list.append(li);
    this.tools.set(id, { line, li });
    this.activity.hidden = false;
    this.summaryLabel.textContent = `${line.label}…`;
    // While it works, the line under the reply says what it is doing.
    this.working.hidden = false;
    this.working.lastElementChild!.textContent = line.label;
  }

  toolEnded(id: string, ok: boolean): void {
    const entry = this.tools.get(id);
    if (!entry) return;
    entry.line.ok = ok;
    entry.li.replaceChildren(icon(ok ? "check" : "close", 12), el("span", "", entry.line.label));
    entry.li.classList.toggle("fail", !ok);
    entry.li.classList.toggle("write", ok && entry.line.write);
    this.working.lastElementChild!.textContent = "Thinking";
    this.refreshSummary();
  }

  private refreshSummary(): void {
    const lines = [...this.tools.values()].map((t) => t.line);
    const head = lines.slice(0, 2).map((l) => l.label).join(" · ");
    this.summaryLabel.textContent = lines.length > 2 ? `${head} · ${lines.length - 2} more` : head;
  }

  showSources(sources: Source[]): void {
    this.sources = sources;
    const box = el("div", "sources");
    box.append(el("div", "label", "Sources"));
    const ol = el("ol");
    for (const s of sources) {
      const li = el("li");
      const a = el("a", "", s.title);
      a.href = s.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.title = s.url;
      li.append(a);
      ol.append(li);
    }
    box.append(ol);
    this.root.append(box);
  }

  finish(): void {
    this.working.remove();
    for (const { li, line } of this.tools.values()) {
      if (li.querySelector(".spinner")) li.replaceChildren(icon("check", 12), el("span", "", line.label));
    }
    this.refreshSummary();
    if (!this.text.trim() && !this.tools.size) this.body.remove();
  }

  fail(message: string, onSetup?: () => void): void {
    this.finish();
    const err = el("div", "error", message);
    if (onSetup) {
      const link = el("button", "link", "Open setup");
      link.addEventListener("click", onSetup);
      err.append(link);
    }
    this.root.append(err);
  }

  toolLines(): ToolLine[] {
    return [...this.tools.values()].map((t) => t.line);
  }

  /** Rebuilds a finished reply from a saved transcript. */
  static restore(entry: Extract<TranscriptEntry, { role: "assistant" }>): Turn {
    const turn = new Turn();
    entry.tools.forEach((line, i) => {
      turn.tools.set(String(i), { line, li: el("li") });
      const li = turn.tools.get(String(i))!.li;
      li.append(icon(line.ok ? "check" : "close", 12), el("span", "", line.label));
      li.classList.toggle("fail", !line.ok);
      li.classList.toggle("write", line.ok && line.write);
      turn.list.append(li);
    });
    turn.activity.hidden = !entry.tools.length;
    if (entry.text) turn.appendText(entry.text);
    turn.finish();
    if (entry.sources?.length) turn.showSources(entry.sources);
    if (entry.error) turn.root.append(el("div", "error", entry.error));
    return turn;
  }
}

export class ChatWindow {
  readonly el = el("div", "chat");
  private readonly modelChip = el("button", "model");
  private readonly expandButton: HTMLButtonElement;
  private readonly historyButton: HTMLButtonElement;
  private readonly chatView = el("div", "view");
  private readonly messages = el("div", "messages");
  private readonly historyView = el("div", "view");
  private readonly contextRow = el("div", "context");
  private readonly input = el("textarea");
  private readonly webToggle: HTMLButtonElement;
  private readonly sendButton = el("button", "send");
  private readonly picker = el("div", "picker");
  private readonly composerWrap = el("div", "composer-wrap");

  private status: Status;
  private conversation: Conversation | null = null;
  private history: unknown[] | null = null;
  /** Provider history before the last turn, for "Try again". */
  private historyBeforeLast: unknown[] | null = null;
  private running: RunHandle | null = null;
  private mentions: Array<{ id: string; title: string }> = [];
  private includePage = true;
  private webOn = true;
  private historyTab: "chats" | "changes" = "chats";
  private pickerItems: PageHit[] = [];
  private pickerIndex = 0;
  private pickerTimer: ReturnType<typeof setTimeout> | undefined;
  private lastTurn: Turn | null = null;

  constructor(
    status: Status,
    private readonly toast: (message: string) => void,
  ) {
    this.status = status;
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-label", "Oracle");

    // ---- header ----
    const head = el("div", "head");
    const title = el("div", "title");
    title.append(mark(18), el("span", "", "Oracle"));
    this.modelChip.type = "button";
    this.modelChip.dataset.tip = "Change model in settings";
    this.modelChip.addEventListener("click", () => void ask({ type: "open-options" }));
    this.historyButton = iconButton("history", "Chats and changes", () => this.toggleHistory());
    this.expandButton = iconButton("expand", "Dock to the side", () => this.toggleSide());
    head.append(
      title,
      this.modelChip,
      el("span", "spacer"),
      iconButton("plus", "New chat", () => this.newChat()),
      this.historyButton,
      this.expandButton,
      iconButton("sliders", "Settings", () => void ask({ type: "open-options" })),
      iconButton("close", "Close", () => this.close()),
    );

    // ---- views ----
    this.chatView.append(this.messages);
    this.historyView.hidden = true;

    // ---- composer ----
    const composer = el("div", "composer");
    this.input.rows = 1;
    this.input.placeholder = "Ask anything, or @ to mention a page";
    this.input.setAttribute("aria-label", "Message Oracle");
    this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.input.addEventListener("input", () => {
      this.autosize();
      this.updateSendState();
      this.checkMention();
    });
    const bar = el("div", "bar");
    const atButton = iconButton("at", "Mention a page", () => this.startMention());
    this.webToggle = el("button", "toggle");
    this.webToggle.type = "button";
    this.webToggle.append(icon("globe", 14), el("span", "", "Web"));
    this.webToggle.dataset.tip = "Let Oracle search the web";
    this.webToggle.addEventListener("click", () => {
      this.webOn = !this.webOn;
      this.webToggle.classList.toggle("on", this.webOn);
    });
    this.sendButton.type = "button";
    this.sendButton.setAttribute("aria-label", "Send");
    this.sendButton.append(icon("send"));
    this.sendButton.addEventListener("click", () => (this.running ? this.running.abort() : void this.send(this.input.value)));
    bar.append(atButton, this.webToggle, el("span", "spacer"), this.sendButton);
    composer.append(this.input, bar);
    this.picker.hidden = true;
    this.composerWrap.append(this.picker, this.contextRow, composer);

    this.el.append(head, this.chatView, this.historyView, this.composerWrap);
    // Keep Notion's shortcuts from firing while typing here.
    for (const type of ["keydown", "keyup", "keypress", "copy", "paste", "cut"] as const) this.el.addEventListener(type, (e) => e.stopPropagation());

    this.applyStatus(status);
    this.renderWelcome();
    this.renderContext();
    this.updateSendState();
    void readUiState().then((ui) => this.setSide(ui.side));
    document.addEventListener("selectionchange", () => {
      if (this.isOpen()) this.renderContext();
    });
  }

  // ---------- open, close, layout ----------

  isOpen(): boolean {
    return this.el.classList.contains("open");
  }

  open(prefill?: string): void {
    this.el.classList.add("open");
    this.renderContext();
    if (prefill !== undefined) {
      this.input.value = prefill;
      this.autosize();
      this.updateSendState();
    }
    setTimeout(() => {
      this.input.focus();
      this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    }, 60);
  }

  close(): void {
    this.el.classList.remove("open");
    this.closePicker();
    this.onClose?.();
  }

  /** Lets the page show the floating button again. */
  onClose?: () => void;

  toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }

  private toggleSide(): void {
    const side = !this.el.classList.contains("side");
    this.setSide(side);
    void writeUiState({ side });
  }

  private setSide(side: boolean): void {
    this.el.classList.toggle("side", side);
    this.expandButton.replaceChildren(icon(side ? "collapse" : "expand"));
    const label = side ? "Float the window" : "Dock to the side";
    this.expandButton.dataset.tip = label;
    this.expandButton.setAttribute("aria-label", label);
  }

  applyStatus(status: Status): void {
    this.status = status;
    this.modelChip.textContent = status.providerLabel;
    this.modelChip.hidden = !status.configured;
    this.webToggle.hidden = !status.webSearch;
    if (!status.webSearch) this.webOn = false;
    else if (!this.running && !this.conversation) this.webOn = true;
    this.webToggle.classList.toggle("on", this.webOn);
    if (!this.conversation && this.chatView.contains(this.messages) && this.messages.querySelector(".welcome")) this.renderWelcome();
  }

  // ---------- welcome ----------

  private renderWelcome(): void {
    this.messages.replaceChildren();
    const welcome = el("div", "welcome");
    welcome.append(mark(28), el("p", "ask", "How can I help?"));
    if (!this.status.configured) {
      const card = el("div", "setup-card");
      const text = el("div");
      text.append(el("p", "", "Oracle needs a Claude or ChatGPT API key before it can answer. Setup takes about a minute."));
      text.append(textButton("arrowRight", "Open setup", () => void ask({ type: "open-options" }), "btn primary"));
      card.append(text);
      welcome.append(card);
    } else {
      welcome.append(el("p", "", "Ask about this page or your workspace, or tell me what to write or change. Select text for quick edits."));
    }
    const list = el("div", "suggestions");
    for (const s of SUGGESTIONS) {
      if (s.needsNotion && !this.status.hasNotion) continue;
      const button = el("button", "suggestion");
      button.type = "button";
      button.append(icon(s.icon), el("span", "", s.label));
      button.addEventListener("click", () => {
        if (s.draft) this.open(s.prompt);
        else void this.send(s.prompt);
      });
      list.append(button);
    }
    welcome.append(list, el("div", "version", `Oracle ${this.status.version}`));
    this.messages.append(welcome);
  }

  private newChat(): void {
    this.running?.abort();
    this.running = null;
    this.conversation = null;
    this.history = null;
    this.historyBeforeLast = null;
    this.mentions = [];
    this.includePage = true;
    this.lastTurn = null;
    this.webOn = this.status.webSearch;
    this.webToggle.classList.toggle("on", this.webOn);
    this.showChat();
    this.renderWelcome();
    this.renderContext();
    this.setRunning(false);
    this.input.value = "";
    this.autosize();
    this.input.focus();
  }

  // ---------- context row ----------

  private renderContext(): void {
    this.contextRow.replaceChildren();
    const title = getPageTitle();
    const page = el("span", `chip${this.includePage ? "" : " off"}`);
    page.title = this.includePage ? "Oracle can read this page" : "This page is left out of the next message";
    page.append(icon("page", 12), el("span", "", title));
    const pageToggle = el("button");
    pageToggle.type = "button";
    pageToggle.setAttribute("aria-label", this.includePage ? "Leave this page out" : "Include this page");
    pageToggle.append(icon(this.includePage ? "close" : "plus", 12));
    pageToggle.addEventListener("click", () => {
      this.includePage = !this.includePage;
      this.renderContext();
    });
    page.append(pageToggle);
    this.contextRow.append(page);

    const selected = getSelectionText();
    if (selected.trim() && this.includePage) {
      const chip = el("span", "chip");
      chip.title = selected.slice(0, 300);
      chip.append(icon("edit", 12), el("span", "", `${plural(wordCount(selected), "word")} selected`));
      this.contextRow.append(chip);
    }
    for (const m of this.mentions) {
      const chip = el("span", "chip");
      chip.append(icon("page", 12), el("span", "", m.title));
      const remove = el("button");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${m.title}`);
      remove.append(icon("close", 12));
      remove.addEventListener("click", () => {
        this.mentions = this.mentions.filter((x) => x.id !== m.id);
        this.renderContext();
      });
      chip.append(remove);
      this.contextRow.append(chip);
    }
  }

  private context(): PageContext {
    return {
      url: location.href,
      title: getPageTitle(),
      pageId: getPageIdFromUrl(location.href),
      selection: this.includePage ? getSelectionText() : "",
      mentions: this.mentions.length ? [...this.mentions] : undefined,
      includePage: this.includePage,
    };
  }

  // ---------- composer ----------

  private autosize(): void {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(200, this.input.scrollHeight)}px`;
  }

  private updateSendState(): void {
    this.sendButton.disabled = !this.running && !this.input.value.trim();
  }

  private setRunning(running: boolean): void {
    this.sendButton.classList.toggle("stop", running);
    this.sendButton.replaceChildren(icon(running ? "stop" : "send", running ? 12 : 16));
    this.sendButton.setAttribute("aria-label", running ? "Stop" : "Send");
    if (!running) this.running = null;
    this.updateSendState();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.picker.hidden) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        this.movePicker(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && this.pickerItems.length) {
        e.preventDefault();
        this.choosePage(this.pickerItems[this.pickerIndex]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.closePicker();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void this.send(this.input.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    }
  }

  // ---------- @-mentions ----------

  private mentionQuery(): string | null {
    const before = this.input.value.slice(0, this.input.selectionStart ?? this.input.value.length);
    const match = /(^|\s)@([^\s@]{0,40})$/.exec(before);
    return match ? match[2]! : null;
  }

  private startMention(): void {
    const pos = this.input.selectionStart ?? this.input.value.length;
    const before = this.input.value.slice(0, pos);
    const insert = before && !/\s$/.test(before) ? " @" : "@";
    this.input.value = before + insert + this.input.value.slice(pos);
    this.input.focus();
    this.input.setSelectionRange(pos + insert.length, pos + insert.length);
    this.checkMention();
  }

  private checkMention(): void {
    const query = this.mentionQuery();
    if (query === null) {
      this.closePicker();
      return;
    }
    clearTimeout(this.pickerTimer);
    if (!this.status.hasNotion) {
      this.showPickerMessage("Connect Notion in settings to mention other pages.", true);
      return;
    }
    if (this.picker.hidden) this.showPickerMessage("Searching…");
    this.pickerTimer = setTimeout(async () => {
      const res = await ask<{ ok: boolean; pages?: PageHit[]; message?: string }>({ type: "search-pages", query });
      if (this.mentionQuery() !== query) return;
      if (!res?.ok) return this.showPickerMessage(res?.message ?? "Could not search Notion.");
      this.pickerItems = (res.pages ?? []).filter((p) => !this.mentions.some((m) => m.id === p.id));
      this.pickerIndex = 0;
      this.renderPicker();
    }, 180);
  }

  private showPickerMessage(text: string, withSetup = false): void {
    this.pickerItems = [];
    this.picker.replaceChildren(el("div", "hint", text));
    if (withSetup) {
      const link = el("button", "link", "Open settings");
      link.addEventListener("click", () => void ask({ type: "open-options" }));
      this.picker.firstElementChild!.append(" ", link);
    }
    this.picker.hidden = false;
  }

  private renderPicker(): void {
    if (!this.pickerItems.length) return this.showPickerMessage("No pages match. Only pages shared with your integration show up.");
    this.picker.replaceChildren();
    this.pickerItems.forEach((p, i) => {
      const item = el("button", `picker-item${i === this.pickerIndex ? " active" : ""}`);
      item.type = "button";
      item.append(icon(p.kind === "database" ? "database" : "page"), el("span", "", p.title || "Untitled"));
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.choosePage(p);
      });
      this.picker.append(item);
    });
    this.picker.hidden = false;
  }

  private movePicker(step: number): void {
    if (!this.pickerItems.length) return;
    this.pickerIndex = (this.pickerIndex + step + this.pickerItems.length) % this.pickerItems.length;
    this.renderPicker();
  }

  private choosePage(page: PageHit): void {
    const pos = this.input.selectionStart ?? this.input.value.length;
    const before = this.input.value.slice(0, pos).replace(/@([^\s@]{0,40})$/, "");
    this.input.value = before + this.input.value.slice(pos);
    this.input.setSelectionRange(before.length, before.length);
    this.mentions.push({ id: page.id, title: page.title || "Untitled" });
    this.closePicker();
    this.renderContext();
    this.updateSendState();
  }

  private closePicker(): void {
    clearTimeout(this.pickerTimer);
    this.picker.hidden = true;
    this.pickerItems = [];
  }

  // ---------- sending ----------

  async send(text: string, options: { retry?: boolean } = {}): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.running) return;
    this.showChat();
    this.closePicker();
    if (!this.status.configured) {
      this.status = (await ask<Status>({ type: "get-status" })) ?? this.status;
      if (!this.status.configured) {
        this.renderWelcome();
        this.toast("Add an API key in setup first.");
        return;
      }
    }
    const context = this.context();
    this.input.value = "";
    this.autosize();
    this.messages.querySelector(".welcome")?.remove();
    this.lastTurn?.root.classList.remove("last");

    if (!this.conversation) {
      const now = new Date().toISOString();
      this.conversation = { id: newConversationId(), title: titleFrom(trimmed), createdAt: now, updatedAt: now, provider: this.status.provider, history: null, transcript: [], pageTitle: context.title };
    }
    const userEntry: TranscriptEntry = { role: "user", text: trimmed };
    if (!options.retry) this.conversation.transcript.push(userEntry);
    this.messages.append(this.renderUser(trimmed, context.mentions));

    const turn = new Turn();
    turn.root.classList.add("last");
    this.lastTurn = turn;
    this.messages.append(turn.root);
    this.scrollToBottom(true);
    this.historyBeforeLast = this.history;
    this.mentions = [];
    this.renderContext();
    this.setRunning(true);

    const conversation = this.conversation;
    this.running = run(
      { type: "chat", text: trimmed, context, history: this.history, conversationId: conversation.id, webSearch: this.webOn },
      (event) => this.onEvent(event, turn, conversation, trimmed),
    );
    this.updateSendState();
  }

  private onEvent(event: BackgroundToPanel, turn: Turn, conversation: Conversation, text: string): void {
    // A reply for a chat the user has since left: keep it saved, but do not draw it here.
    const current = this.conversation?.id === conversation.id;
    switch (event.type) {
      case "text":
        turn.appendText(event.delta);
        break;
      case "tool-start":
        turn.toolStarted(event.id, event.name, event.input);
        break;
      case "tool-end":
        turn.toolEnded(event.id, event.ok);
        break;
      case "sources":
        turn.showSources(event.sources);
        break;
      case "change":
        turn.changes.push(event.change);
        break;
      case "done":
      case "error": {
        const failed = event.type === "error";
        if (failed) turn.fail(event.message, event.needsSetup ? () => void ask({ type: "open-options" }) : undefined);
        else turn.finish();
        if (event.history) this.history = event.history;
        if (event.type === "done") this.modelChip.textContent = event.providerLabel;
        conversation.history = event.history ?? conversation.history;
        conversation.transcript.push({ role: "assistant", text: turn.text, tools: turn.toolLines(), sources: turn.sources.length ? turn.sources : undefined, error: failed ? event.message : undefined });
        conversation.updatedAt = new Date().toISOString();
        void saveConversation(conversation);
        if (current) {
          this.addActions(turn, text);
          this.setRunning(false);
        }
        break;
      }
    }
    if (current) this.scrollToBottom();
  }

  private renderUser(text: string, mentions?: Array<{ id: string; title: string }>): HTMLElement {
    const node = el("div", "msg user", text);
    if (mentions?.length) {
      const refs = el("div", "refs");
      for (const m of mentions) {
        const chip = el("span", "chip");
        chip.append(icon("page", 12), el("span", "", m.title));
        refs.append(chip);
      }
      node.append(refs);
    }
    return node;
  }

  private addActions(turn: Turn, userText: string): void {
    if (turn.changes.length) {
      const changed = el("div", "changed");
      changed.append(el("span", "", `Changed ${plural(turn.changes.length, "thing")} in Notion`));
      const view = el("button", "link", "Review or undo");
      view.addEventListener("click", () => this.showHistory("changes"));
      changed.append(view);
      turn.root.append(changed);
    }
    if (!turn.text.trim()) return;
    const actions = el("div", "msg-actions");
    const copy = iconButton("copy", "Copy", async () => {
      await navigator.clipboard.writeText(turn.text);
      this.toast("Copied");
    });
    const insert = iconButton("insert", "Insert into the page", () => {
      try {
        insertText(turn.text, "cursor");
        this.toast("Added to the page");
      } catch (error) {
        this.toast((error as Error).message);
      }
    });
    const retry = iconButton("retry", "Try again", () => {
      if (this.running || this.lastTurn !== turn) return;
      // Drop the last exchange and ask again from the history before it.
      turn.root.previousElementSibling?.remove();
      turn.root.remove();
      this.history = this.historyBeforeLast;
      this.conversation?.transcript.splice(-1, 1);
      void this.send(userText, { retry: true });
    });
    actions.append(copy, insert, retry);
    turn.root.append(actions);
  }

  private scrollToBottom(force = false): void {
    const view = this.chatView;
    const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 120;
    if (force || nearBottom) view.scrollTop = view.scrollHeight;
  }

  // ---------- chats and changes ----------

  private showChat(): void {
    this.historyView.hidden = true;
    this.chatView.hidden = false;
    this.composerWrap.hidden = false;
    this.historyButton.classList.remove("on");
  }

  private toggleHistory(): void {
    if (this.historyView.hidden) this.showHistory(this.historyTab);
    else this.showChat();
  }

  async showHistory(tab: "chats" | "changes"): Promise<void> {
    this.historyTab = tab;
    this.chatView.hidden = true;
    this.composerWrap.hidden = true;
    this.historyView.hidden = false;
    this.historyButton.classList.add("on");
    const tabs = el("div", "tabs");
    for (const [id, label] of [["chats", "Chats"], ["changes", "Changes"]] as const) {
      const t = el("button", `tab${tab === id ? " on" : ""}`, label);
      t.type = "button";
      t.addEventListener("click", () => void this.showHistory(id));
      tabs.append(t);
    }
    const list = el("div", "list");
    this.historyView.replaceChildren(tabs, list);
    if (tab === "chats") await this.renderChats(list);
    else await this.renderChanges(list);
  }

  private async renderChats(list: HTMLElement): Promise<void> {
    const chats = await listConversations();
    if (!chats.length) {
      list.append(el("div", "empty-list", "No chats yet. Conversations are saved here as you go."));
      return;
    }
    let group = "";
    for (const c of chats) {
      const g = ageGroup(c.updatedAt);
      if (g !== group) {
        group = g;
        list.append(el("div", "group-label", g));
      }
      const row = el("div", "row");
      const main = el("button", "main");
      main.type = "button";
      main.append(el("span", "t", c.title), el("span", "s", [c.pageTitle, formatTime(c.updatedAt)].filter(Boolean).join(" · ")));
      main.addEventListener("click", () => void this.openConversation(c.id));
      const remove = iconButton("trash", "Delete chat", async () => {
        await deleteConversation(c.id);
        if (this.conversation?.id === c.id) this.newChat();
        void this.showHistory("chats");
      });
      row.append(main, remove);
      list.append(row);
    }
  }

  private async renderChanges(list: HTMLElement): Promise<void> {
    const changes = await listChanges();
    if (!changes.length) {
      list.append(el("div", "empty-list", "Nothing yet. Anything Oracle changes in Notion through your integration is listed here, with an Undo."));
      return;
    }
    let group = "";
    for (const c of changes) {
      const g = ageGroup(c.at);
      if (g !== group) {
        group = g;
        list.append(el("div", "group-label", g));
      }
      const row = el("div", `row${c.undone ? " undone" : ""}`);
      const main = el("div", "main");
      main.append(el("span", "t", c.label), el("span", "s", c.error ? c.error : formatTime(c.at)));
      row.append(main);
      if (c.undone) row.append(el("span", "state", "Undone"));
      else if (c.undo) {
        const undo = textButton("undo", "Undo", async () => {
          undo.disabled = true;
          const res = await ask<{ ok: boolean; message: string }>({ type: "undo-change", id: c.id });
          this.toast(res?.message ?? "Could not reach Oracle.");
          void this.showHistory("changes");
        });
        row.append(undo);
      } else row.append(el("span", "state", "Can't undo"));
      list.append(row);
    }
  }

  private async openConversation(id: string): Promise<void> {
    const saved = await loadConversation(id);
    if (!saved) {
      this.toast("That chat could not be found.");
      return;
    }
    this.running?.abort();
    this.setRunning(false);
    this.conversation = saved;
    // Each provider keeps history in its own format; a chat from the other one continues
    // from its visible transcript only.
    this.history = saved.provider === this.status.provider ? saved.history : null;
    if (saved.provider !== this.status.provider) saved.provider = this.status.provider;
    this.historyBeforeLast = null;
    this.mentions = [];
    this.showChat();
    this.messages.replaceChildren();
    for (const entry of saved.transcript) {
      if (entry.role === "user") this.messages.append(this.renderUser(entry.text));
      else {
        const turn = Turn.restore(entry);
        this.messages.append(turn.root);
        this.lastTurn = turn;
      }
    }
    this.renderContext();
    this.scrollToBottom(true);
    this.input.focus();
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
