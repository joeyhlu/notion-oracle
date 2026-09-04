/** Content script entry: mounts the panel and serves page tools to the service worker. */

import type { PageToolResponse, RuntimeMessage } from "../shared/types.ts";
import { getSelectionText, insertText, readPage, replaceSelection, trackSelection } from "./page.ts";
import { OraclePanel } from "./panel.ts";

declare global {
  interface Window {
    __notionOraclePanel?: OraclePanel;
  }
}

function runPageTool(name: string, input: Record<string, unknown>): PageToolResponse {
  try {
    switch (name) {
      case "read_current_page": {
        const page = readPage();
        return { ok: true, content: JSON.stringify(page, null, 2) };
      }
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

function main(): void {
  if (window.__notionOraclePanel) return;
  trackSelection();
  const panel = new OraclePanel();
  window.__notionOraclePanel = panel;

  chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
    if (message.type === "toggle-panel") {
      panel.toggle();
      sendResponse(true);
    } else if (message.type === "page-tool") {
      sendResponse(runPageTool(message.name, message.input ?? {}));
    }
    return false;
  });

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "Space") {
      e.preventDefault();
      panel.toggle();
    }
  });
}

main();
