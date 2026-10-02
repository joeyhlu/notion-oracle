/** One request to the service worker over a port, with its stream of events. */

import { CHAT_PORT_NAME, type BackgroundToPanel, type PanelToBackground } from "../shared/types.ts";

export interface RunHandle {
  abort(): void;
}

/**
 * Sends one chat or AI-menu request and feeds every event to `onEvent`. The port closes when the
 * request finishes. A worker that dies mid-request is reported as an error event, so callers
 * have one place to handle failure.
 */
export function run(request: Exclude<PanelToBackground, { type: "abort" }>, onEvent: (event: BackgroundToPanel) => void): RunHandle {
  let finished = false;
  let port: chrome.runtime.Port;
  const finish = () => {
    finished = true;
    try {
      port.disconnect();
    } catch {
      // already closed
    }
  };
  try {
    port = chrome.runtime.connect({ name: CHAT_PORT_NAME });
  } catch {
    // The extension was reloaded or updated under this tab: the old content script is orphaned.
    queueMicrotask(() => onEvent({ type: "error", message: "Oracle was updated. Reload this Notion tab to keep going.", history: request.history }));
    return { abort() {} };
  }
  port.onMessage.addListener((event: BackgroundToPanel) => {
    if (finished) return;
    if (event.type === "done" || event.type === "error") finish();
    onEvent(event);
  });
  port.onDisconnect.addListener(() => {
    if (finished) return;
    finished = true;
    onEvent({ type: "error", message: "Lost the connection to Oracle. Try again.", history: request.history });
  });
  port.postMessage(request);
  return {
    abort() {
      if (finished) return;
      try {
        port.postMessage({ type: "abort" } satisfies PanelToBackground);
      } catch {
        // Port already gone.
      }
    },
  };
}

/** A one-off message to the worker that tolerates an orphaned content script. */
export async function ask<T>(message: unknown): Promise<T | null> {
  try {
    return (await chrome.runtime.sendMessage(message)) as T;
  } catch {
    return null;
  }
}
