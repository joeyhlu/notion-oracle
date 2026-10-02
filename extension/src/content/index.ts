/**
 * Content script entry: mounts Oracle in the Notion page (floating button, chat window, AI menu,
 * selection button), serves page tools to the service worker, and wires up the shortcuts.
 */

import type { PageToolResponse, RuntimeMessage, Status } from "../shared/types.ts";
import { ChatWindow } from "./chat.ts";
import { AiMenu, SelectionBubble } from "./inline.ts";
import { editorCaret, editorSelection, getSelectionText, insertText, rangeRect, readPage, replaceSelection, trackSelection } from "./page.ts";
import { ask } from "./port.ts";
import { el, mark } from "./ui.ts";
import css from "./panel.css";

declare global {
  interface Window {
    __notionOracle?: boolean;
  }
}

const FALLBACK_STATUS: Status = {
  configured: false,
  provider: "anthropic",
  providerLabel: "",
  hasNotion: false,
  webSearch: false,
  aiShortcut: true,
  selectionButton: true,
  floatingButton: true,
  version: chrome.runtime.getManifest().version,
};

function runPageTool(name: string, input: Record<string, unknown>): PageToolResponse {
  try {
    switch (name) {
      case "read_current_page":
        return { ok: true, content: JSON.stringify(readPage(), null, 2) };
      case "get_selection":
        return { ok: true, content: getSelectionText() };
      case "insert_at_cursor":
        return { ok: true, content: insertText(String(input.text ?? ""), input.position === "end" ? "end" : "cursor") };
      case "replace_selection":
        return { ok: true, content: replaceSelection(String(input.text ?? "")) };
      default:
        return { ok: false, content: `Unknown page tool ${name}` };
    }
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }
}

/** Notion marks its dark theme with a class on <body>; follow it rather than the OS. */
function notionIsDark(): boolean {
  const body = document.body;
  if (!body) return matchMedia("(prefers-color-scheme: dark)").matches;
  return body.classList.contains("dark") || body.classList.contains("notion-dark-theme") || document.documentElement.classList.contains("dark");
}

async function main(): Promise<void> {
  if (window.__notionOracle) return;
  window.__notionOracle = true;
  // A previous version's panel, orphaned by an update, would otherwise sit beside this one.
  document.getElementById("notion-oracle-host")?.remove();
  trackSelection();

  const host = el("div");
  host.id = "notion-oracle-host";
  const root = host.attachShadow({ mode: "open" });
  const style = el("style");
  style.textContent = css;
  root.append(style);

  let status = (await ask<Status>({ type: "get-status" })) ?? FALLBACK_STATUS;

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const toastEl = el("div", "toast");
  toastEl.hidden = true;
  toastEl.setAttribute("role", "status");
  const toast = (message: string) => {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 3200);
  };

  const fab = el("button", "fab");
  fab.type = "button";
  fab.setAttribute("aria-label", "Open Oracle");
  fab.dataset.tip = "Oracle";
  fab.append(mark(40));

  const chat = new ChatWindow(status, toast);
  const menu = new AiMenu(status, toast);
  const openMenuOnSelection = () => {
    const sel = editorSelection();
    bubble.hide();
    if (!sel) return;
    menu.open({ scope: "selection", range: sel.range, selection: sel.text, anchor: rangeRect(sel.range) });
  };
  const bubble = new SelectionBubble(openMenuOnSelection);

  const syncFab = () => {
    fab.hidden = !status.floatingButton || chat.isOpen();
  };
  fab.addEventListener("click", () => {
    chat.open();
    syncFab();
  });
  chat.onClose = syncFab;

  root.append(fab, chat.el, menu.el, bubble.el, toastEl);
  document.documentElement.append(host);

  const syncTheme = () => host.classList.toggle("dark", notionIsDark());
  syncTheme();
  new MutationObserver(syncTheme).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncTheme);

  const applyStatus = (next: Status) => {
    status = next;
    chat.applyStatus(next);
    menu.applyStatus(next);
    syncFab();
    if (!next.selectionButton) bubble.hide();
  };
  applyStatus(status);
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.settings) void ask<Status>({ type: "get-status" }).then((s) => s && applyStatus(s));
  });

  const toggleChat = () => {
    chat.toggle();
    syncFab();
  };

  chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
    if (message.type === "toggle-panel") {
      toggleChat();
      sendResponse(true);
    } else if (message.type === "page-tool") {
      sendResponse(runPageTool(message.name, message.input ?? {}));
    }
    return false;
  });

  // ---- the selection button ----
  const maybeShowBubble = () => {
    if (!status.selectionButton || menu.isOpen()) return bubble.hide();
    const sel = editorSelection();
    if (sel) bubble.show(rangeRect(sel.range));
    else bubble.hide();
  };
  document.addEventListener("mouseup", (e) => {
    if (e.composedPath().includes(host)) return;
    setTimeout(maybeShowBubble, 10);
  });
  document.addEventListener("keyup", (e) => {
    if (e.shiftKey || e.key === "Shift") setTimeout(maybeShowBubble, 10);
  });
  document.addEventListener("selectionchange", () => {
    if (!bubble.el.hidden && !editorSelection()) bubble.hide();
  });
  document.addEventListener("scroll", () => bubble.hide(), true);

  // An outside click closes the menu, unless it holds a result the user has not dealt with.
  document.addEventListener("mousedown", (e) => {
    if (e.composedPath().includes(host)) return;
    if (menu.isOpen() && !menu.isHolding()) menu.close();
  });

  // ---- shortcuts ----
  // Capture phase on window so Notion's own Cmd+J handler (its AI upsell) does not see it first.
  window.addEventListener(
    "keydown",
    (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.code === "Space") {
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleChat();
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && e.code === "KeyJ" && status.aiShortcut && !e.composedPath().includes(host)) {
        const sel = editorSelection();
        const caret = sel?.range ?? editorCaret();
        if (!caret) return; // Not in the editor: leave the key alone.
        e.preventDefault();
        e.stopImmediatePropagation();
        bubble.hide();
        menu.open({ scope: sel ? "selection" : "cursor", range: caret, selection: sel?.text ?? "", anchor: rangeRect(caret) });
      }
    },
    true,
  );
}

void main();
