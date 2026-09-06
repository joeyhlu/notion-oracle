/** DOM helpers for reading from and writing into the Notion editor. */

import type { PageSnapshot } from "../shared/types.ts";

const CONTENT_SELECTOR = ".notion-page-content";

export function getPageIdFromUrl(href: string): string | null {
  try {
    const url = new URL(href);
    const peek = url.searchParams.get("p");
    const source = peek ?? url.pathname;
    const match = /([0-9a-f]{32})(?![0-9a-f])/i.exec(source.replace(/-/g, ""));
    if (!match) return null;
    const h = (match[1] ?? "").toLowerCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  } catch {
    return null;
  }
}

export function getPageTitle(): string {
  const titleEl = document.querySelector<HTMLElement>('.notion-page-block > [contenteditable="true"], [placeholder="Untitled"]');
  const fromDom = titleEl?.innerText.trim();
  return fromDom || document.title.replace(/\s*\|\s*Notion$/i, "").trim() || "Untitled";
}

const BLOCK_PREFIX: Array<[string, string]> = [
  ["notion-header-block", "# "],
  ["notion-sub_header-block", "## "],
  ["notion-sub_sub_header-block", "### "],
  ["notion-bulleted_list-block", "- "],
  ["notion-numbered_list-block", "1. "],
  ["notion-to_do-block", "- [ ] "],
  ["notion-quote-block", "> "],
  ["notion-callout-block", "> "],
  ["notion-toggle-block", "▸ "],
];

function blockToMarkdown(el: HTMLElement): string {
  if (el.classList.contains("notion-divider-block")) return "---";
  if (el.classList.contains("notion-code-block")) return "```\n" + el.innerText.trim() + "\n```";
  if (el.classList.contains("notion-image-block")) return "[image]";
  if (el.classList.contains("notion-collection_view-block") || el.classList.contains("notion-collection_view_page-block")) {
    return `[embedded database: ${el.innerText.split("\n")[0]?.trim() ?? ""}]`;
  }
  const text = el.innerText.replace(/ /g, " ").trim();
  if (!text) return "";
  for (const [cls, prefix] of BLOCK_PREFIX) {
    if (el.classList.contains(cls)) {
      if (cls === "notion-to_do-block") {
        const checked = el.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked;
        return `- [${checked ? "x" : " "}] ${text}`;
      }
      return prefix + text;
    }
  }
  return text;
}

export function readPage(): PageSnapshot {
  const root = document.querySelector<HTMLElement>(CONTENT_SELECTOR);
  let markdown: string;
  if (root) {
    const blocks = Array.from(root.children).filter((c): c is HTMLElement => c instanceof HTMLElement && c.hasAttribute("data-block-id"));
    markdown = blocks.map(blockToMarkdown).filter(Boolean).join("\n");
    if (!markdown) markdown = root.innerText.trim();
  } else {
    // Database views, settings, etc.: fall back to the main frame text.
    markdown = (document.querySelector<HTMLElement>(".notion-frame") ?? document.body).innerText.trim().slice(0, 40000);
  }
  return { url: location.href, title: getPageTitle(), pageId: getPageIdFromUrl(location.href), markdown };
}

// ---------- Selection tracking ----------

let lastRange: Range | null = null;

function isInsideEditor(node: Node | null): boolean {
  if (!node) return false;
  const el = node instanceof Element ? node : node.parentElement;
  return Boolean(el?.closest(`${CONTENT_SELECTOR}, .notion-page-block`));
}

export function trackSelection(): void {
  document.addEventListener("selectionchange", () => {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (isInsideEditor(range.startContainer)) lastRange = range.cloneRange();
  });
}

export function getSelectionText(): string {
  const sel = document.getSelection();
  if (sel && sel.rangeCount > 0 && !sel.isCollapsed && isInsideEditor(sel.getRangeAt(0).startContainer)) return sel.toString();
  if (lastRange && !lastRange.collapsed) return lastRange.toString();
  return "";
}

// ---------- Writing ----------

function editableFor(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : node?.parentElement ?? null;
  return el?.closest<HTMLElement>('[contenteditable="true"]') ?? null;
}

function restoreRange(range: Range): HTMLElement | null {
  const editable = editableFor(range.startContainer);
  if (!editable || !document.contains(editable)) return null;
  editable.focus();
  const sel = document.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  return editable;
}

function caretAtEndOfPage(): HTMLElement | null {
  const root = document.querySelector<HTMLElement>(CONTENT_SELECTOR);
  const editables = root ? Array.from(root.querySelectorAll<HTMLElement>('[contenteditable="true"]')) : [];
  const last = editables[editables.length - 1];
  if (!last) return null;
  last.focus();
  const range = document.createRange();
  range.selectNodeContents(last);
  range.collapse(false);
  const sel = document.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  return last;
}

/** Feed text to Notion the way a paste would, so Markdown is parsed into blocks. Falls back to plain insertion. */
function typeInto(editable: HTMLElement, text: string): void {
  const data = new DataTransfer();
  data.setData("text/plain", text);
  const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
  const handledByNotion = !editable.dispatchEvent(event);
  if (!handledByNotion) document.execCommand("insertText", false, text);
}

export function insertText(text: string, position: "cursor" | "end"): string {
  let target: HTMLElement | null = null;
  if (position === "cursor" && lastRange) {
    const collapsed = lastRange.cloneRange();
    collapsed.collapse(false);
    target = restoreRange(collapsed);
  }
  let prefix = "";
  if (!target) {
    target = caretAtEndOfPage();
    if (target && target.innerText.trim()) prefix = "\n";
  }
  if (!target) throw new Error("Could not find an editable block on this page. Is a page open in edit mode?");
  typeInto(target, prefix + text);
  return `Inserted ${text.length} characters ${position === "cursor" && !prefix ? "at the cursor" : "at the end of the page"}.`;
}

export function replaceSelection(text: string): string {
  const sel = document.getSelection();
  const live = sel && sel.rangeCount > 0 && !sel.isCollapsed && isInsideEditor(sel.getRangeAt(0).startContainer) ? sel.getRangeAt(0).cloneRange() : null;
  const range = live ?? (lastRange && !lastRange.collapsed ? lastRange.cloneRange() : null);
  if (!range) throw new Error("Nothing is selected in the page.");
  const editable = restoreRange(range);
  if (!editable) throw new Error("The selected text is no longer in the editor.");
  const original = range.toString();
  document.execCommand("delete");
  typeInto(editable, text);
  return `Replaced ${original.length} characters with ${text.length} characters.`;
}
