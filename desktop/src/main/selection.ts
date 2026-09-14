/**
 * Reads the text selected in the Notion desktop app, so "fix this paragraph" means the one the
 * user is looking at rather than one they have to describe.
 *
 * macOS exposes a focused element's selection through the accessibility API, which AppleScript can
 * reach via System Events. Notion is an Electron app, so the whole page is one AXWebArea and the
 * selection is read from whichever element holds focus. This needs the Accessibility permission,
 * which is a different grant from the Automation one the window-title reader uses, so it can fail
 * on a machine where everything else works.
 *
 * The clipboard is deliberately untouched. Sending Cmd+C and reading the pasteboard is the other
 * way to do this and it works more often, but it destroys whatever the user had copied, and a
 * background overlay silently overwriting your clipboard is a worse bug than not seeing the
 * selection.
 */

import { runCapture } from "./process.ts";

/** Longer than this and the model does not need it verbatim to know what is being pointed at. */
export const MAX_SELECTION = 4000;

/**
 * AppleScript that returns the focused element's selected text, or an empty string.
 *
 * Every lookup is wrapped: asking for AXSelectedText on an element that has no such attribute
 * raises rather than returning missing value, and an unhandled raise here would surface as a
 * scary permission-shaped error for what is really just "nothing is selected".
 */
export function selectionScript(appName = "Notion"): string {
  return [
    'tell application "System Events"',
    `  if not (exists process "${appName}") then return ""`,
    `  tell process "${appName}"`,
    "    try",
    "      set focused to value of attribute \"AXFocusedUIElement\"",
    "    on error",
    "      return \"\"",
    "    end try",
    "    try",
    "      set picked to value of attribute \"AXSelectedText\" of focused",
    "    on error",
    "      return \"\"",
    "    end try",
    "    if picked is missing value then return \"\"",
    "    return picked as text",
    "  end tell",
    "end tell",
  ].join("\n");
}

/**
 * Trims a raw selection to something worth sending.
 *
 * A click with no drag reports an empty or whitespace-only selection, and treating that as "the
 * user pointed at something" would attach a stray fragment to every unrelated question.
 */
export function normalizeSelection(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  if (text.length <= MAX_SELECTION) return text;
  return `${text.slice(0, MAX_SELECTION).trimEnd()}\n…(selection truncated)`;
}

/** Null on any failure: a missing selection must never block the message being sent. */
export async function getNotionSelection(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const res = await runCapture("osascript", ["-e", selectionScript()], { timeoutMs: 4000 });
    return res.code === 0 ? normalizeSelection(res.stdout) : null;
  } catch {
    return null;
  }
}
