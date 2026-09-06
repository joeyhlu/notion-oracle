/** The chat panel UI, rendered inside a shadow root so Notion's styles do not leak in. */

import { markdownToHtml } from "../lib/markdown.ts";
import { CHAT_PORT_NAME, type BackgroundToPanel, type PageContext, type PanelToBackground } from "../shared/types.ts";
import { getPageIdFromUrl, getPageTitle, getSelectionText, insertText } from "./page.ts";
import css from "./panel.css";

interface QuickAction {
  label: string;
  prompt: string;
  needsSelection?: boolean;
}

const QUICK_ACTIONS: QuickAction[] = [
  { label: "Summarize page", prompt: "Summarize this page in a few bullet points." },
  { label: "Action items", prompt: "List the action items and open questions in this page as a to-do list." },
  { label: "Improve writing", prompt: "Improve the writing of the selected text: fix grammar, tighten wording, keep the meaning and tone. Replace the selection with the result.", needsSelection: true },
  { label: "Explain selection", prompt: "Explain the selected text in simple terms.", needsSelection: true },
  { label: "Continue writing", prompt: "Continue writing from where the page ends, matching its style. Insert the continuation at the end of the page." },
];

export class OraclePanel {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly panel: HTMLElement;
  private readonly fab: HTMLButtonElement;
  private readonly messages: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly modelLabel: HTMLElement;
  private history: unknown[] | null = null;
  private port: chrome.runtime.Port | null = null;
  private busy = false;

  constructor() {
    this.host = document.createElement("div");
    this.host.id = "notion-oracle-host";
    this.root = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = css;
    this.root.appendChild(style);

    this.fab = el("button", "fab", "◎") as HTMLButtonElement;
    this.fab.title = "Open Oracle (Ctrl/Cmd+Shift+Space)";
    this.fab.addEventListener("click", () => this.toggle());
    this.root.appendChild(this.fab);

    this.panel = el("div", "panel");
    const header = el("div", "header");
    const title = el("div", "title");
    title.append(el("span", "dot"), document.createTextNode("Oracle"));
    this.modelLabel = el("span", "model", "");
    const newChat = iconButton("✚", "New conversation", () => this.reset());
    const settings = iconButton("⚙", "Settings", () => chrome.runtime.sendMessage({ type: "open-options" }));
    const close = iconButton("✕", "Close", () => this.toggle(false));
    header.append(title, this.modelLabel, newChat, settings, close);

    this.messages = el("div", "messages");
    const quick = el("div", "quick");
    for (const action of QUICK_ACTIONS) {
      const chip = el("button", "chip", action.label) as HTMLButtonElement;
      chip.addEventListener("click", () => {
        if (action.needsSelection && !getSelectionText()) {
          this.showError("Select some text in the page first.");
          return;
        }
        void this.send(action.prompt);
      });
      quick.appendChild(chip);
    }

    const composer = el("div", "composer");
    this.input = document.createElement("textarea");
    this.input.placeholder = "Ask about this page, or tell Oracle what to do…";
    this.input.rows = 1;
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send(this.input.value);
      }
      if (e.key === "Escape") this.toggle(false);
      e.stopPropagation();
    });
    this.input.addEventListener("input", () => {
      this.input.style.height = "auto";
      this.input.style.height = `${Math.min(160, this.input.scrollHeight)}px`;
    });
    this.sendButton = el("button", "send", "Send") as HTMLButtonElement;
    this.sendButton.addEventListener("click", () => (this.busy ? this.abort() : void this.send(this.input.value)));
    composer.append(this.input, this.sendButton);
    const hint = el("div", "hint", "Enter to send · Shift+Enter for a new line · Esc to close");

    this.panel.append(header, this.messages, quick, composer, hint);
    this.root.appendChild(this.panel);
    // Keep Notion's global shortcuts from firing while typing in the panel.
    for (const type of ["keydown", "keyup", "keypress"] as const) this.panel.addEventListener(type, (e) => e.stopPropagation());
    document.documentElement.appendChild(this.host);

    this.renderEmpty();
    this.syncTheme();
    void this.refreshModelLabel();
    chrome.storage.onChanged.addListener(() => void this.refreshModelLabel());
  }

  toggle(force?: boolean): void {
    const open = force ?? !this.panel.classList.contains("open");
    this.panel.classList.toggle("open", open);
    this.fab.hidden = open;
    if (open) {
      this.syncTheme();
      setTimeout(() => this.input.focus(), 50);
    }
  }

  private syncTheme(): void {
    const dark = document.body.classList.contains("dark") || document.documentElement.classList.contains("dark") || getComputedStyle(document.body).colorScheme === "dark";
    this.host.classList.toggle("dark", dark);
    this.host.classList.toggle("light", !dark);
  }

  private async refreshModelLabel(): Promise<void> {
    try {
      const label = (await chrome.runtime.sendMessage({ type: "get-provider-label" })) as string;
      this.modelLabel.textContent = label;
    } catch {
      this.modelLabel.textContent = "";
    }
  }

  private renderEmpty(): void {
    this.messages.replaceChildren();
    const empty = el("div", "empty");
    empty.innerHTML =
      "<strong>Hi, I'm Oracle.</strong><br>Ask me about this page, have me rewrite a selection, draft content, or add events to a calendar database.<br><br>Try one of the quick actions below.";
    this.messages.appendChild(empty);
  }

  private reset(): void {
    this.abort();
    this.history = null;
    this.renderEmpty();
    this.input.focus();
  }

  private context(): PageContext {
    return { url: location.href, title: getPageTitle(), pageId: getPageIdFromUrl(location.href), selection: getSelectionText() };
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.sendButton.textContent = busy ? "Stop" : "Send";
    this.sendButton.classList.toggle("stop", busy);
  }

  private abort(): void {
    if (this.port && this.busy) this.port.postMessage({ type: "abort" } satisfies PanelToBackground);
  }

  private showError(message: string): void {
    const node = el("div", "msg assistant");
    const err = el("div", "error");
    err.textContent = message;
    if (/settings/i.test(message)) {
      err.appendChild(document.createTextNode(" "));
      const link = document.createElement("a");
      link.href = "#";
      link.textContent = "Open settings";
      link.addEventListener("click", (e) => {
        e.preventDefault();
        void chrome.runtime.sendMessage({ type: "open-options" });
      });
      err.appendChild(link);
    }
    node.appendChild(err);
    this.messages.appendChild(node);
    this.scrollToBottom();
  }

  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.busy) return;
    const context = this.context();
    this.input.value = "";
    this.input.style.height = "auto";
    this.messages.querySelector(".empty")?.remove();

    const user = el("div", "msg user", trimmed);
    this.messages.appendChild(user);

    const assistant = el("div", "msg assistant");
    const tools = el("div", "tools");
    const body = el("div", "body");
    const thinking = el("div", "thinking", "Thinking");
    assistant.append(tools, thinking, body);
    this.messages.appendChild(assistant);
    this.scrollToBottom();

    let raw = "";
    const toolNodes = new Map<string, HTMLElement>();
    this.setBusy(true);

    const port = chrome.runtime.connect({ name: CHAT_PORT_NAME });
    this.port = port;
    const finish = () => {
      thinking.remove();
      this.setBusy(false);
      if (this.port === port) this.port = null;
      try {
        port.disconnect();
      } catch {
        // already closed
      }
    };
    port.onMessage.addListener((message: BackgroundToPanel) => {
      switch (message.type) {
        case "text":
          thinking.remove();
          raw += message.delta;
          body.innerHTML = markdownToHtml(raw);
          this.scrollToBottom();
          break;
        case "tool-start": {
          const node = el("div", "tool running");
          node.append(el("span", "name", message.name), el("span", "status", "running"));
          tools.appendChild(node);
          toolNodes.set(message.id, node);
          this.scrollToBottom();
          break;
        }
        case "tool-end": {
          const node = toolNodes.get(message.id);
          if (node) {
            node.classList.remove("running");
            node.classList.toggle("error", !message.ok);
            node.querySelector(".status")!.textContent = message.ok ? "done" : "failed";
            node.appendChild(el("span", "summary", message.summary));
            node.title = message.summary;
          }
          break;
        }
        case "done":
          this.history = message.history;
          this.modelLabel.textContent = message.providerLabel;
          if (raw.trim()) this.addMessageActions(assistant, () => raw);
          finish();
          break;
        case "error":
          this.history = message.history;
          finish();
          if (!raw.trim()) body.remove();
          this.showError(message.message);
          break;
      }
    });
    port.onDisconnect.addListener(() => {
      if (this.busy && this.port === port) {
        finish();
        this.showError("Lost connection to the extension. Try again.");
      }
    });
    port.postMessage({ type: "chat", text: trimmed, context, history: this.history } satisfies PanelToBackground);
  }

  private addMessageActions(container: HTMLElement, getText: () => string): void {
    const actions = el("div", "actions");
    const insert = el("button", "chip", "Insert into page") as HTMLButtonElement;
    insert.addEventListener("click", () => {
      try {
        insertText(getText(), "cursor");
        insert.textContent = "Inserted ✓";
      } catch (error) {
        this.showError((error as Error).message);
      }
    });
    const copy = el("button", "chip", "Copy") as HTMLButtonElement;
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(getText()).then(() => (copy.textContent = "Copied ✓"));
    });
    actions.append(insert, copy);
    container.appendChild(actions);
  }

  private scrollToBottom(): void {
    this.messages.scrollTop = this.messages.scrollHeight;
  }
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconButton(glyph: string, title: string, onClick: () => unknown): HTMLButtonElement {
  const button = el("button", "icon-btn", glyph) as HTMLButtonElement;
  button.title = title;
  button.addEventListener("click", () => void onClick());
  return button;
}
