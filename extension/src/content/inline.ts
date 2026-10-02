/**
 * The AI menu and the "Ask AI" button under a selection: Oracle's version of Notion AI's inline
 * experience. Opened on a selection it edits that text; opened at the cursor (Cmd/Ctrl+J) it
 * writes from there.
 */

import { markdownToHtml } from "../lib/markdown.ts";
import {
  GROUP_LABELS,
  buildInlinePrompt,
  buildRefinement,
  filterCommands,
  filterOptions,
  primaryAction,
  type AiCommand,
  type CommandOption,
  type CommandScope,
} from "../lib/commands.ts";
import type { BackgroundToPanel, Status } from "../shared/types.ts";
import { blockFor, blockIdOf, getPageTitle, insertBelow, readPage, replaceRange } from "./page.ts";
import { ask, run, type RunHandle } from "./port.ts";
import { COMMAND_ICONS, el, icon, mark } from "./ui.ts";

type State = "menu" | "options" | "topic" | "running" | "done" | "error";
type ActionId = "replace" | "insert" | "copy" | "retry" | "discard" | "done" | "setup";

type Item =
  | { kind: "free"; text: string }
  | { kind: "command"; command: AiCommand }
  | { kind: "back" }
  | { kind: "option"; command: AiCommand; option: CommandOption }
  | { kind: "action"; id: ActionId; label: string; icon: string };

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Keeps the selected text visibly marked while the menu has focus; the browser hides a
 * selection in an unfocused editor, and the user should see what is about to change. The
 * highlight style has to live in the page, not the shadow root, because it paints page text.
 */
const HIGHLIGHT = "oracle-selection";
function markRange(range: Range | null): void {
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const HighlightCtor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!registry || !HighlightCtor) return;
  if (!document.getElementById("oracle-highlight-style")) {
    const style = document.createElement("style");
    style.id = "oracle-highlight-style";
    style.textContent = `::highlight(${HIGHLIGHT}) { background-color: rgba(35, 131, 226, 0.28); }`;
    document.head.append(style);
  }
  if (range && !range.collapsed) registry.set(HIGHLIGHT, new HighlightCtor(range));
  else registry.delete(HIGHLIGHT);
}
export const SHORTCUT_LABEL = isMac ? "⌘J" : "Ctrl+J";

export interface OpenOptions {
  scope: CommandScope;
  /** The selection, or the caret, to write back to. */
  range: Range | null;
  selection: string;
  anchor: DOMRect;
}

export class AiMenu {
  readonly el = el("div", "ai");
  private readonly result = el("div", "ai-result");
  private readonly resultBody = el("div", "body");
  private readonly working = el("div", "working");
  private readonly bar = el("div", "ai-bar");
  private readonly input = el("input");
  private readonly send = el("button", "send");
  private readonly menu = el("div", "ai-menu");

  private state: State = "menu";
  private scope: CommandScope = "cursor";
  private range: Range | null = null;
  private selection = "";
  private anchor = new DOMRect();
  private items: Item[] = [];
  private active = 0;
  private optionsFor: AiCommand | null = null;
  private command: AiCommand | null = null;
  private text = "";
  private error = "";
  private needsSetup = false;
  private handle: RunHandle | null = null;
  private history: unknown[] | null = null;
  /** The last request, so Try again repeats exactly that. */
  private lastExec: { prompt: string; history: unknown[] | null } | null = null;

  constructor(
    private status: Status,
    private readonly toast: (message: string) => void,
  ) {
    this.el.hidden = true;
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-label", "Oracle AI menu");
    this.working.append(el("span", "spinner"), el("span", "", "Writing"));
    this.result.append(this.resultBody, this.working);
    this.input.placeholder = "Ask AI to edit or generate…";
    this.input.setAttribute("aria-label", "Ask AI");
    this.input.addEventListener("input", () => this.onInput());
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    this.send.type = "button";
    this.send.setAttribute("aria-label", "Send");
    this.send.addEventListener("click", () => (this.state === "running" ? this.handle?.abort() : this.submit()));
    this.bar.append(mark(18), this.input, this.send);
    this.el.append(this.result, this.bar, this.menu);
    for (const type of ["keydown", "keyup", "keypress", "copy", "paste", "cut"] as const) this.el.addEventListener(type, (e) => e.stopPropagation());
  }

  isOpen(): boolean {
    return !this.el.hidden;
  }

  /** Busy or showing a result the user has not dealt with: an outside click should not lose it. */
  isHolding(): boolean {
    return this.state === "running" || this.state === "done";
  }

  applyStatus(status: Status): void {
    this.status = status;
  }

  open(options: OpenOptions): void {
    this.handle?.abort();
    this.scope = options.scope;
    this.range = options.range;
    this.selection = options.selection;
    this.anchor = options.anchor;
    this.optionsFor = null;
    this.command = null;
    this.text = "";
    this.history = null;
    this.input.value = "";
    this.el.hidden = false;
    markRange(options.selection.trim() ? options.range : null);
    this.setState("menu");
    setTimeout(() => this.input.focus(), 0);
  }

  close(): void {
    this.handle?.abort();
    this.handle = null;
    this.el.hidden = true;
    markRange(null);
  }

  // ---------- state and rendering ----------

  private setState(state: State): void {
    this.state = state;
    this.active = 0;
    const busy = state === "running";
    this.input.disabled = busy;
    this.input.placeholder =
      state === "running" ? "Oracle is writing…" :
      state === "done" ? "Tell AI what to do next…" :
      state === "options" ? `Search ${this.optionsFor?.id === "translate" ? "languages" : "tones"}…` :
      state === "topic" ? "Finish the sentence, then press Enter" :
      this.scope === "selection" ? "Ask AI to edit or explain the selection…" : "Ask AI to write anything…";
    this.send.classList.toggle("stop", busy);
    this.send.replaceChildren(icon(busy ? "stop" : "send", busy ? 12 : 16));
    this.send.setAttribute("aria-label", busy ? "Stop" : "Send");
    this.render();
  }

  private render(): void {
    const showResult = this.state === "running" || this.state === "done" || this.state === "error";
    this.result.hidden = !showResult;
    this.working.hidden = this.state !== "running";
    if (this.state === "error") {
      this.resultBody.replaceChildren(el("div", "error", this.error));
    } else if (showResult) {
      this.resultBody.innerHTML = this.text ? markdownToHtml(this.text) : "";
    }
    this.items = this.buildItems();
    this.menu.replaceChildren();
    this.menu.hidden = !this.items.length && this.state !== "topic";
    if (this.state === "topic") {
      this.menu.append(el("div", "ai-note", `${this.command?.label}: describe what you want and press Enter.`));
    }
    let group = "";
    this.items.forEach((item, i) => {
      if (item.kind === "command" && this.state === "menu") {
        const g = GROUP_LABELS[item.command.group];
        if (g !== group) {
          group = g;
          this.menu.append(el("div", "group-label", g));
        }
      }
      this.menu.append(this.renderItem(item, i));
    });
    this.position();
  }

  private buildItems(): Item[] {
    const typed = this.input.value.trim();
    switch (this.state) {
      case "menu": {
        const commands: Item[] = filterCommands(this.scope, typed).map((command) => ({ kind: "command", command }));
        return typed ? [{ kind: "free", text: typed }, ...commands] : commands;
      }
      case "options":
        return [{ kind: "back" }, ...filterOptions(this.optionsFor!, typed).map((option) => ({ kind: "option" as const, command: this.optionsFor!, option }))];
      case "done": {
        if (typed) return [{ kind: "free", text: typed }];
        const primary = primaryAction(this.command, Boolean(this.selection.trim()));
        const actions: Item[] = [];
        const canReplace = Boolean(this.range && this.selection.trim());
        if (primary === "done") actions.push({ kind: "action", id: "done", label: "Done", icon: "check" });
        if (canReplace && primary === "replace") actions.push({ kind: "action", id: "replace", label: "Replace selection", icon: "replace" });
        actions.push({ kind: "action", id: "insert", label: "Insert below", icon: "insert" });
        if (canReplace && primary !== "replace") actions.push({ kind: "action", id: "replace", label: "Replace selection", icon: "replace" });
        actions.push(
          { kind: "action", id: "copy", label: "Copy", icon: "copy" },
          { kind: "action", id: "retry", label: "Try again", icon: "retry" },
          { kind: "action", id: "discard", label: "Discard", icon: "trash" },
        );
        return actions;
      }
      case "error":
        return [
          ...(this.needsSetup ? [{ kind: "action" as const, id: "setup" as const, label: "Open setup", icon: "sliders" }] : []),
          { kind: "action", id: "retry", label: "Try again", icon: "retry" },
          { kind: "action", id: "discard", label: "Close", icon: "close" },
        ];
      default:
        return [];
    }
  }

  private renderItem(item: Item, index: number): HTMLElement {
    const row = el("button", `ai-item${index === this.active ? " active" : ""}`);
    row.type = "button";
    switch (item.kind) {
      case "free":
        row.append(icon(this.state === "done" ? "edit" : "send", 16), el("span", "grow", this.state === "done" ? `Revise: ${item.text}` : item.text), el("kbd", "", "↵"));
        break;
      case "command":
        row.append(icon(COMMAND_ICONS[item.command.id] ?? "sparkle"), el("span", "grow", item.command.label));
        if (item.command.options) row.append(icon("chevron", 14));
        break;
      case "back":
        row.append(icon("back"), el("span", "grow", this.optionsFor?.label ?? "Back"));
        break;
      case "option":
        row.append(el("span", "grow", item.option.label));
        break;
      case "action":
        row.append(icon(item.icon), el("span", "grow", item.label));
        if (index === 0) row.classList.add("primary");
        break;
    }
    row.addEventListener("mousemove", () => {
      if (this.active !== index) {
        this.active = index;
        this.highlight();
      }
    });
    // mousedown, not click: the editor must not get a chance to take focus and drop the selection.
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.choose(item);
    });
    return row;
  }

  private highlight(): void {
    this.menu.querySelectorAll(".ai-item").forEach((node, i) => node.classList.toggle("active", i === this.active));
    this.menu.querySelector(".ai-item.active")?.scrollIntoView({ block: "nearest" });
  }

  /** Below the anchor when it fits, above it otherwise, always inside the viewport. */
  private position(): void {
    const width = this.el.offsetWidth || 540;
    const left = Math.max(12, Math.min(this.anchor.left, window.innerWidth - width - 12));
    this.el.style.left = `${left}px`;
    const height = this.el.offsetHeight || 360;
    const below = this.anchor.bottom + 8;
    const above = this.anchor.top - 8 - height;
    const top = below + height <= window.innerHeight - 12 || above < 12 ? Math.min(below, Math.max(12, window.innerHeight - height - 12)) : above;
    this.el.style.top = `${Math.max(12, top)}px`;
  }

  // ---------- input ----------

  private onInput(): void {
    if (this.state === "topic") return;
    this.render();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      if (this.state === "running") this.handle?.abort();
      else if (this.state === "options") this.leaveOptions();
      else this.close();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!this.items.length) return;
      this.active = (this.active + (e.key === "ArrowDown" ? 1 : -1) + this.items.length) % this.items.length;
      this.highlight();
      return;
    }
    if (e.key === "ArrowRight" && this.state === "menu") {
      const item = this.items[this.active];
      if (item?.kind === "command" && item.command.options) {
        e.preventDefault();
        this.enterOptions(item.command);
      }
      return;
    }
    if ((e.key === "ArrowLeft" || (e.key === "Backspace" && !this.input.value)) && this.state === "options") {
      e.preventDefault();
      this.leaveOptions();
      return;
    }
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      this.submit();
    }
  }

  private submit(): void {
    if (this.state === "topic") {
      if (this.input.value.trim()) this.start(this.command, this.input.value.trim());
      return;
    }
    const item = this.items[this.active];
    if (item) this.choose(item);
    else if (this.input.value.trim()) this.choose({ kind: "free", text: this.input.value.trim() });
  }

  private enterOptions(command: AiCommand): void {
    this.optionsFor = command;
    this.input.value = "";
    this.setState("options");
  }

  private leaveOptions(): void {
    this.optionsFor = null;
    this.input.value = "";
    this.setState("menu");
  }

  private choose(item: Item): void {
    switch (item.kind) {
      case "free":
        if (this.state === "done") this.refine(item.text);
        else this.start(null, item.text);
        return;
      case "command":
        if (item.command.options) return this.enterOptions(item.command);
        if (item.command.topicPrefix) {
          this.command = item.command;
          this.input.value = item.command.topicPrefix;
          this.setState("topic");
          this.input.focus();
          this.input.setSelectionRange(this.input.value.length, this.input.value.length);
          return;
        }
        return this.start(item.command);
      case "back":
        return this.leaveOptions();
      case "option":
        return this.start(item.command, undefined, item.option.value);
      case "action":
        void this.act(item.id);
    }
  }

  // ---------- running ----------

  private start(command: AiCommand | null, typed?: string, option?: string): void {
    if (!this.status.configured) {
      this.error = "Oracle needs an API key first. Setup takes about a minute.";
      this.needsSetup = true;
      this.input.value = "";
      this.setState("error");
      return;
    }
    this.command = command;
    this.history = null;
    const needsPage = !command || command.needsPage || !this.selection.trim() || Boolean(command.topicPrefix);
    const prompt = buildInlinePrompt({
      command,
      option,
      typed,
      selection: this.selection,
      pageTitle: getPageTitle(),
      pageMarkdown: needsPage ? readPage().markdown : undefined,
    });
    this.exec(prompt, null);
  }

  private refine(instruction: string): void {
    this.exec(buildRefinement(instruction), this.history);
  }

  private exec(prompt: string, history: unknown[] | null): void {
    this.lastExec = { prompt, history };
    this.text = "";
    this.error = "";
    this.needsSetup = false;
    this.input.value = "";
    this.setState("running");
    this.handle = run({ type: "inline", prompt, history }, (event) => this.onEvent(event));
  }

  private onEvent(event: BackgroundToPanel): void {
    if (this.el.hidden) return;
    switch (event.type) {
      case "text":
        this.text += event.delta;
        this.resultBody.innerHTML = markdownToHtml(this.text);
        this.result.scrollTop = this.result.scrollHeight;
        this.position();
        break;
      case "done":
        this.history = event.history;
        this.handle = null;
        this.text = this.text.trim();
        this.setState(this.text ? "done" : "error");
        if (!this.text) this.error = "Oracle returned nothing. Try again or rephrase.";
        if (!this.text) this.render();
        setTimeout(() => this.input.focus(), 0);
        break;
      case "error":
        this.handle = null;
        if (event.message === "Stopped." && this.text.trim()) {
          // Keep what was written so far: it can still be used.
          this.text = this.text.trim();
          this.setState("done");
        } else {
          this.error = event.message;
          this.needsSetup = Boolean(event.needsSetup);
          this.setState("error");
        }
        setTimeout(() => this.input.focus(), 0);
        break;
      default:
        break;
    }
  }

  private async act(id: ActionId): Promise<void> {
    switch (id) {
      case "discard":
      case "done":
        this.close();
        return;
      case "setup":
        void ask({ type: "open-options" });
        this.close();
        return;
      case "retry":
        if (this.lastExec) this.exec(this.lastExec.prompt, this.lastExec.history);
        return;
      case "copy":
        await navigator.clipboard.writeText(this.text);
        this.toast("Copied");
        this.close();
        return;
      case "replace": {
        const range = this.range;
        const text = this.text;
        this.close();
        if (range && (await replaceRange(range, text))) return;
        await this.fallback(text, "Couldn't edit the page directly, so the text is on your clipboard. Paste it over the selection.");
        return;
      }
      case "insert": {
        const range = this.range;
        const text = this.text;
        this.close();
        if (range && (await insertBelow(range, text))) return;
        // Typing into the editor did not take: write it through the API when connected.
        const blockId = range ? blockIdOf(blockFor(range.endContainer)) : null;
        if (blockId && this.status.hasNotion) {
          const res = await ask<{ ok: boolean; message: string }>({ type: "insert-after-block", blockId, markdown: text });
          if (res?.ok) {
            this.toast("Inserted below");
            return;
          }
        }
        await this.fallback(text, "Couldn't write into the page here, so the text is on your clipboard. Paste it where you want it.");
      }
    }
  }

  private async fallback(text: string, message: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.toast(message);
    } catch {
      this.toast("Couldn't write into the page. Open the chat to copy the result.");
    }
  }
}

/** The small "Ask AI" button that appears under selected text. */
export class SelectionBubble {
  readonly el = el("button", "bubble");

  constructor(onOpen: () => void) {
    this.el.type = "button";
    this.el.hidden = true;
    this.el.append(mark(16), el("span", "", "Ask AI"), el("kbd", "", SHORTCUT_LABEL));
    // mousedown keeps the editor's selection alive; a click would collapse it first.
    this.el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onOpen();
    });
  }

  show(rect: DOMRect): void {
    this.el.hidden = false;
    const width = this.el.offsetWidth || 110;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const below = rect.bottom + 8;
    const top = below + 36 > window.innerHeight ? rect.top - 36 : below;
    this.el.style.left = `${left}px`;
    this.el.style.top = `${Math.max(8, top)}px`;
  }

  hide(): void {
    this.el.hidden = true;
  }
}
