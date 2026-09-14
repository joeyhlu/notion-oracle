/**
 * Which page the Notion desktop app is showing, from its window title — and, when that cannot be
 * read, *why*.
 *
 * The reason matters. Reading another app's window title needs the Automation permission, which
 * is a different grant from the one the overlay uses to know Notion is in front (that goes
 * through lsappinfo and needs nothing). So the common failure is: the pill appears correctly, the
 * title comes back empty, and Oracle tells the user "Notion isn't showing up on my end" while
 * Notion is plainly open in front of them. Returning a bare null made that indistinguishable from
 * Notion genuinely not running, and left no way to diagnose it.
 */

import { runCapture } from "./process.ts";
import { getFrontmostApp, isNotionApp } from "./frontmost.ts";

export type WindowStatus =
  /** Title read successfully. */
  | "ok"
  /** The Notion desktop app is not running. */
  | "not-running"
  /** Notion is running but the OS refused to let Oracle read its window. */
  | "no-permission"
  /** Notion is running and readable, but the window has no page title (an empty or new window). */
  | "no-title";

export interface NotionWindow {
  title: string | null;
  status: WindowStatus;
}

/** Strip the app name from a Notion window title; returns null when it is not a page title. */
export function cleanTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let title = raw.trim();
  title = title.replace(/\s*[-–—|]\s*Notion\s*$/i, "").trim();
  if (!title || /^notion$/i.test(title)) return null;
  return title;
}

/**
 * Classifies an osascript failure.
 *
 * -1743 is "not authorized to send Apple events", which is the denied-Automation case, and -600
 * is "application isn't running". Anything else is treated as unreadable rather than denied, so a
 * quirk in one Notion build does not send the user to a permissions pane that is already correct.
 */
export function classifyOsascriptError(stderr: string): WindowStatus {
  const err = stderr.trim();
  if (/-1743|not authoriz|not allowed|assistive access|-25211/i.test(err)) return "no-permission";
  if (/-600|isn.t running|-10814|application.{0,20}not running/i.test(err)) return "not-running";
  return "no-title";
}

async function readMacTitle(): Promise<NotionWindow> {
  // lsappinfo needs no permission, so it can answer "is Notion even open?" honestly even when
  // every Apple Event is being refused.
  const front = await getFrontmostApp();
  const notionInFront = isNotionApp(front.name);

  // Plain app scripting first: most Electron apps answer it, and it avoids System Events.
  const direct = await runCapture("osascript", ["-e", 'tell application "Notion" to get name of window 1'], { timeoutMs: 5000 });
  if (direct.code === 0) {
    const title = cleanTitle(direct.stdout);
    return title ? { title, status: "ok" } : { title: null, status: "no-title" };
  }
  const directReason = classifyOsascriptError(direct.stderr);

  const viaEvents = await runCapture("osascript", ["-e", 'tell application "System Events" to get name of window 1 of process "Notion"'], { timeoutMs: 5000 });
  if (viaEvents.code === 0) {
    const title = cleanTitle(viaEvents.stdout);
    return title ? { title, status: "ok" } : { title: null, status: "no-title" };
  }
  const eventsReason = classifyOsascriptError(viaEvents.stderr);

  // If lsappinfo can see Notion in front, "not running" is provably wrong whatever osascript said.
  if (notionInFront && (directReason === "not-running" || eventsReason === "not-running")) {
    return { title: null, status: "no-permission" };
  }
  if (directReason === "no-permission" || eventsReason === "no-permission") return { title: null, status: "no-permission" };
  if (directReason === "not-running" && eventsReason === "not-running") return { title: null, status: "not-running" };
  return { title: null, status: notionInFront ? "no-permission" : "not-running" };
}

export async function getNotionWindow(): Promise<NotionWindow> {
  try {
    if (process.platform === "darwin") return await readMacTitle();

    if (process.platform === "win32") {
      const res = await runCapture(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "Get-Process -Name Notion -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1 -ExpandProperty MainWindowTitle"],
        { timeoutMs: 8000 },
      );
      const title = cleanTitle(res.stdout);
      if (title) return { title, status: "ok" };
      // Windows needs no permission for this, so an empty result means no Notion window.
      return { title: null, status: res.stdout.trim() ? "no-title" : "not-running" };
    }

    const res = await runCapture("bash", ["-c", "xdotool search --classname notion getwindowname %@ 2>/dev/null | head -1"], { timeoutMs: 5000 });
    const title = cleanTitle(res.stdout);
    return title ? { title, status: "ok" } : { title: null, status: "not-running" };
  } catch {
    return { title: null, status: "not-running" };
  }
}

/** Back-compatible shim for callers that only want the title. */
export async function getNotionWindowTitle(): Promise<string | null> {
  return (await getNotionWindow()).title;
}
