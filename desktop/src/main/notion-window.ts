/** Best-effort detection of which page the Notion desktop app is showing, from its window title. */

import { runCapture } from "./process.ts";

/** Strip the app name from a Notion window title; returns null when it is not a page title. */
export function cleanTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let title = raw.trim();
  title = title.replace(/\s*[-–—|]\s*Notion\s*$/i, "").trim();
  if (!title || /^notion$/i.test(title)) return null;
  return title;
}

export async function getNotionWindowTitle(): Promise<string | null> {
  try {
    if (process.platform === "darwin") {
      const running = await runCapture("osascript", ["-e", 'tell application "System Events" to (name of processes) contains "Notion"'], { timeoutMs: 5000 });
      if (!/true/i.test(running.stdout)) return null;
      // Plain app scripting works without the Accessibility permission for most Electron apps.
      const direct = await runCapture("osascript", ["-e", 'tell application "Notion" to get name of window 1'], { timeoutMs: 5000 });
      if (direct.code === 0 && direct.stdout.trim()) return cleanTitle(direct.stdout);
      const viaEvents = await runCapture("osascript", ["-e", 'tell application "System Events" to get name of window 1 of process "Notion"'], { timeoutMs: 5000 });
      return viaEvents.code === 0 ? cleanTitle(viaEvents.stdout) : null;
    }
    if (process.platform === "win32") {
      const res = await runCapture(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "Get-Process -Name Notion -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1 -ExpandProperty MainWindowTitle"],
        { timeoutMs: 8000 },
      );
      return cleanTitle(res.stdout);
    }
    const res = await runCapture("bash", ["-c", "xdotool search --classname notion getwindowname %@ 2>/dev/null | head -1"], { timeoutMs: 5000 });
    return cleanTitle(res.stdout);
  } catch {
    return null;
  }
}
