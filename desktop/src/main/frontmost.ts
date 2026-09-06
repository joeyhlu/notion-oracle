/**
 * Reports which application is in the foreground, so the overlay can show itself only while
 * the user is actually in Notion.
 *
 * Every detection path can fail (missing permission, missing tool, an OS that will not say),
 * and an overlay that wrongly believes Notion is never in front would be invisible and
 * unusable. So detection failure is sticky and *fails open*: `supported` flips to false and
 * the caller falls back to always showing.
 */

import { runCapture } from "./process.ts";

export interface FrontmostSample {
  /** Foreground application name, or null when it could not be read this time. */
  name: string | null;
  /** False once this platform has proven it cannot report the foreground app at all. */
  supported: boolean;
}

/** Our own app is called "Notion Oracle", so a bare /notion/ test would always match it. */
export function isOracleApp(name: string | null | undefined): boolean {
  return Boolean(name && /oracle/i.test(name));
}

/** True for the Notion desktop app (and siblings like Notion Calendar), but never for Oracle. */
export function isNotionApp(name: string | null | undefined): boolean {
  return Boolean(name && /notion/i.test(name) && !isOracleApp(name));
}

/** Pulls the display name out of `lsappinfo info -only name` output: `"LSDisplayName"="Notion"`. */
export function parseLsappinfoName(stdout: string): string | null {
  const match = /"LSDisplayName"\s*=\s*"([^"]*)"/.exec(stdout);
  const name = match?.[1]?.trim();
  return name ? name : null;
}

// PowerShell note: $pid is a reserved automatic variable, so the process id goes in $procId.
const WINDOWS_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class OracleFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr handle, out int processId);
}
"@ -ErrorAction Stop
$handle = [OracleFg]::GetForegroundWindow()
$procId = 0
[void][OracleFg]::GetWindowThreadProcessId($handle, [ref]$procId)
if ($procId -ne 0) { (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName }
`;

const MAC_EVENTS_SCRIPT = 'tell application "System Events" to get name of first application process whose frontmost is true';

let supported = true;

/** Lets tests and settings changes retry detection after a failure. */
export function resetFrontmostSupport(): void {
  supported = true;
}

export async function getFrontmostApp(): Promise<FrontmostSample> {
  if (!supported) return { name: null, supported: false };
  try {
    if (process.platform === "darwin") {
      // lsappinfo needs no Accessibility permission, so try it before System Events.
      const front = await runCapture("lsappinfo", ["front"], { timeoutMs: 4000 });
      const asn = front.stdout.trim();
      if (front.code === 0 && asn) {
        const info = await runCapture("lsappinfo", ["info", "-only", "name", asn], { timeoutMs: 4000 });
        const name = parseLsappinfoName(info.stdout);
        if (name) return { name, supported: true };
      }
      // Fall back to System Events, which does require Accessibility permission.
      const events = await runCapture("osascript", ["-e", MAC_EVENTS_SCRIPT], { timeoutMs: 5000 });
      const name = events.stdout.trim();
      if (events.code === 0 && name) return { name, supported: true };
      supported = false;
      return { name: null, supported: false };
    }

    if (process.platform === "win32") {
      const res = await runCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT], { timeoutMs: 8000 });
      const name = res.stdout.trim().split(/\r?\n/).pop()?.trim();
      if (res.code === 0 && name) return { name, supported: true };
      supported = false;
      return { name: null, supported: false };
    }

    const res = await runCapture("bash", ["-c", "xdotool getactivewindow getwindowclassname 2>/dev/null"], { timeoutMs: 4000 });
    const name = res.stdout.trim();
    if (res.code === 0 && name) return { name, supported: true };
    supported = false;
    return { name: null, supported: false };
  } catch {
    supported = false;
    return { name: null, supported: false };
  }
}

export interface OverlayVisibilityInput {
  /** The `followNotion` setting: when off, the overlay is always on screen. */
  followNotion: boolean;
  /** False when the platform cannot report the foreground app. */
  detectionSupported: boolean;
  frontmostApp: string | null;
  /** True while one of Oracle's own windows holds focus. */
  oracleFocused: boolean;
}

/**
 * Decides whether the overlay belongs on screen. Pure, so the rules are testable without a
 * desktop: the only way to hide is an explicit, working detection that says another app is in
 * front while the user is not interacting with Oracle.
 */
export function shouldShowOverlay(input: OverlayVisibilityInput): boolean {
  if (!input.followNotion) return true;
  if (!input.detectionSupported) return true;
  if (input.oracleFocused) return true;
  if (isNotionApp(input.frontmostApp)) return true;
  // A null reading is a transient failure, not evidence that Notion is gone.
  if (input.frontmostApp === null) return true;
  return false;
}

export interface FrontmostWatcherOptions {
  intervalMs?: number;
  onChange: (sample: FrontmostSample) => void;
  /** Injectable for tests. */
  probe?: () => Promise<FrontmostSample>;
}

/** Polls the foreground app and reports every change; stops polling once detection is unsupported. */
export class FrontmostWatcher {
  private timer: NodeJS.Timeout | null = null;
  private last: FrontmostSample = { name: null, supported: true };
  private running = false;
  private readonly intervalMs: number;
  private readonly probe: () => Promise<FrontmostSample>;
  private readonly options: FrontmostWatcherOptions;

  constructor(options: FrontmostWatcherOptions) {
    this.options = options;
    this.intervalMs = options.intervalMs ?? 900;
    this.probe = options.probe ?? getFrontmostApp;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return; // a slow probe must not pile up
    this.running = true;
    try {
      const sample = await this.probe();
      if (sample.name !== this.last.name || sample.supported !== this.last.supported) {
        this.last = sample;
        this.options.onChange(sample);
      }
      if (!sample.supported) this.stop();
    } finally {
      this.running = false;
    }
  }
}
