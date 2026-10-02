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

/** The selection inside the editor right now, if it covers any text. */
export function editorSelection(): { range: Range; text: string } | null {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!isInsideEditor(range.startContainer)) return null;
  const text = sel.toString();
  return text.trim() ? { range: range.cloneRange(), text } : null;
}

/** The caret inside the editor, collapsed or not. */
export function editorCaret(): Range | null {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  return isInsideEditor(range.startContainer) ? range.cloneRange() : null;
}

/** Where to anchor a popup for a range. A collapsed caret often has no rect of its own. */
export function rangeRect(range: Range): DOMRect {
  const rects = range.getClientRects();
  const last = rects[rects.length - 1];
  if (last && (last.width || last.height)) return range.collapsed ? last : range.getBoundingClientRect();
  const host = (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)?.closest<HTMLElement>("[data-block-id], [contenteditable]");
  return host?.getBoundingClientRect() ?? new DOMRect(window.innerWidth / 2, window.innerHeight / 3, 0, 0);
}

/** The Notion block a node sits in: the innermost element carrying a block id. */
export function blockFor(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : node?.parentElement ?? null;
  return el?.closest<HTMLElement>("[data-block-id]") ?? null;
}

/** Notion's block ids in the DOM are the API's ids, dashed or not. */
export function blockIdOf(block: HTMLElement | null): string | null {
  const raw = block?.getAttribute("data-block-id")?.replace(/-/g, "") ?? "";
  return /^[0-9a-f]{32}$/i.test(raw) ? raw : null;
}

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

function blockCount(): number {
  return document.querySelectorAll(`${CONTENT_SELECTOR} [data-block-id]`).length;
}

/** Waits for Notion to re-render after a paste. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 250));

/**
 * Puts text in a new block below the one `range` ends in, the way "Insert below" works in Notion
 * AI. An empty block (the line the user pressed the AI shortcut on) is written into instead.
 * Resolves true when the page visibly changed, so the caller can fall back to the API.
 */
export async function insertBelow(range: Range, text: string): Promise<boolean> {
  const block = blockFor(range.endContainer);
  const editables = block ? Array.from(block.querySelectorAll<HTMLElement>('[contenteditable="true"]')) : [];
  const editable = editables[editables.length - 1] ?? editableFor(range.endContainer);
  if (!editable || !document.contains(editable)) return false;
  const before = blockCount();
  const beforeText = editable.innerText;
  const empty = !editable.innerText.trim();
  editable.focus();
  const caret = document.createRange();
  caret.selectNodeContents(editable);
  caret.collapse(false);
  const sel = document.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(caret);
  typeInto(editable, empty ? text : `\n${text}`);
  await settle();
  return blockCount() > before || editable.innerText !== beforeText;
}

/** The first words of what was written, with Markdown markers stripped, to look for afterwards. */
function fingerprint(markdown: string): string {
  const line = markdown.split("\n").map((l) => l.replace(/^\s*(#{1,3}\s|[-*]\s(\[[ x]\]\s)?|\d+\.\s|>\s)?/, "").replace(/[*_`]/g, "").trim()).find(Boolean) ?? "";
  return line.slice(0, 24);
}

/**
 * Replaces the text a saved range covers. Resolves true only when the replacement can be seen
 * in the page, so a delete that happened without the paste is reported as a failure.
 */
export async function replaceRange(range: Range, text: string): Promise<boolean> {
  const editable = restoreRange(range);
  if (!editable) return false;
  const root = (editable.closest(CONTENT_SELECTOR) as HTMLElement | null) ?? editable;
  document.execCommand("delete");
  typeInto(editable, text);
  await settle();
  const probe = fingerprint(text);
  return !probe || root.innerText.includes(probe);
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
