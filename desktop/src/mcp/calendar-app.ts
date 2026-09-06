/**
 * Drives the Notion Calendar desktop app. Notion Calendar shows the user's Google, iCloud and
 * Outlook calendars but exposes no API for creating events: no REST surface, no AppleScript
 * dictionary, and its only deep link (cron://showEvent) opens events that already exist. So
 * creating an event means operating the app the way a person does - bring it to the front,
 * jump to the day, press the new-event key, type the title, confirm.
 *
 * Everything is expressed as a plan of steps first (pure, testable) and then executed per
 * platform, so what the automation *will* do is inspectable before it touches the keyboard.
 *
 * Kept free of Electron imports so it runs inside the MCP server process.
 */

import { spawn } from "node:child_process";

export const APP_NAME = "Notion Calendar";
/** Notion Calendar kept its pre-rebrand URL scheme. */
export const URL_SCHEME = "cron";

export type Strategy = "new-event-key" | "command-bar";

export interface CreateEventInput {
  title: string;
  /** ISO 8601. Date-only means all-day. */
  start: string;
  end?: string;
  allDay?: boolean;
}

export type Step =
  | { type: "activate" }
  | { type: "open-url"; url: string }
  | { type: "keys"; combo: "c" | "cmd+k" | "enter" | "escape" }
  | { type: "type"; text: string }
  | { type: "delay"; ms: number };

export interface CalendarAppStatus {
  running: boolean;
  platform: NodeJS.Platform;
  method: "applescript" | "powershell" | "unsupported";
  detail: string;
}

// ---------- pure helpers ----------

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Deep link that opens Notion Calendar to a day. The ?t= cache-buster is required; the app ignores repeated identical links. */
export function dateUrl(date: Date): string {
  return `${URL_SCHEME}://./${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}?t=${Math.floor(Date.now() / 1000)}`;
}

export function isDateOnly(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso.trim());
}

export function parseWhen(input: CreateEventInput): { start: Date; end: Date | null; allDay: boolean } {
  const allDay = Boolean(input.allDay) || isDateOnly(input.start);
  const start = new Date(isDateOnly(input.start) ? `${input.start}T00:00:00` : input.start);
  if (Number.isNaN(start.getTime())) throw new Error(`Could not parse start "${input.start}". Use ISO 8601, e.g. 2026-09-07T14:00:00 or 2026-09-07 for all day.`);
  let end: Date | null = null;
  if (input.end) {
    end = new Date(isDateOnly(input.end) ? `${input.end}T00:00:00` : input.end);
    if (Number.isNaN(end.getTime())) throw new Error(`Could not parse end "${input.end}".`);
  }
  return { start, end, allDay };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function clock(d: Date): string {
  const h = d.getHours();
  const suffix = h >= 12 ? "pm" : "am";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return d.getMinutes() === 0 ? `${hour12}${suffix}` : `${hour12}:${pad(d.getMinutes())}${suffix}`;
}

/**
 * The natural-language phrase typed into the command bar. Written the way calendar parsers most
 * reliably read: "<title> Sep 7 2026 2pm-3pm", or just the date for all-day events.
 */
export function naturalPhrase(input: CreateEventInput): string {
  const { start, end, allDay } = parseWhen(input);
  const day = `${MONTHS[start.getMonth()]} ${start.getDate()} ${start.getFullYear()}`;
  if (allDay) return `${input.title} ${day}`;
  const time = end ? `${clock(start)}-${clock(end)}` : clock(start);
  return `${input.title} ${day} ${time}`;
}

export interface PlanOptions {
  strategy: Strategy;
  /** Press Enter to save. When false the composer is left open for the user to confirm. */
  save: boolean;
}

/** Builds the keystroke plan for creating an event. Pure: what it returns is exactly what runs. */
export function buildCreateEventPlan(input: CreateEventInput, options: PlanOptions): Step[] {
  if (!input.title.trim()) throw new Error("The event needs a title.");
  const { start } = parseWhen(input);
  const steps: Step[] = [{ type: "activate" }, { type: "delay", ms: 700 }];

  if (options.strategy === "command-bar") {
    // Cmd+K opens a command bar that parses natural language, so one typed line carries the
    // title, date and time together.
    steps.push({ type: "keys", combo: "cmd+k" }, { type: "delay", ms: 500 }, { type: "type", text: naturalPhrase(input) }, { type: "delay", ms: 900 });
  } else {
    // Jump to the day first so "new event" lands on the right date, then only the title is typed.
    steps.push({ type: "open-url", url: dateUrl(start) }, { type: "delay", ms: 1200 }, { type: "keys", combo: "c" }, { type: "delay", ms: 600 }, { type: "type", text: input.title.trim() }, { type: "delay", ms: 300 });
  }
  if (options.save) steps.push({ type: "keys", combo: "enter" });
  return steps;
}

/** Human-readable trace of a plan, returned to the model so the user can see what happened. */
export function describePlan(steps: Step[]): string[] {
  return steps
    .filter((s) => s.type !== "delay")
    .map((s) => {
      switch (s.type) {
        case "activate":
          return `Brought ${APP_NAME} to the front`;
        case "open-url":
          return `Opened ${s.url.replace(/\?t=\d+$/, "")} (jumped to the day)`;
        case "keys":
          return s.combo === "c" ? "Pressed C (new event)" : s.combo === "cmd+k" ? "Opened the command bar (Cmd+K)" : s.combo === "enter" ? "Pressed Enter (saved)" : "Pressed Escape";
        case "type":
          return `Typed "${s.text}"`;
        default:
          return "";
      }
    })
    .filter(Boolean);
}

/** Escapes a string for use inside an AppleScript double-quoted literal. */
export function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Escapes text for .NET SendKeys, whose grammar gives +^%~(){}[] special meaning. */
export function sendKeysEscape(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`);
}

// ---------- process helpers ----------

function run(command: string, args: string[], timeoutMs = 20000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export function osascript(lines: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return run("osascript", lines.flatMap((l) => ["-e", l]));
}

function powershell(script: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script]);
}

// ---------- status / activation ----------

export async function calendarAppStatus(): Promise<CalendarAppStatus> {
  if (process.platform === "darwin") {
    const res = await osascript([`tell application "System Events" to (name of processes) contains "${APP_NAME}"`]);
    const running = /true/i.test(res.stdout);
    return { running, platform: "darwin", method: "applescript", detail: running ? `${APP_NAME} is running.` : `${APP_NAME} is not running. Ask the user to open it; it must be open for calendar changes.` };
  }
  if (process.platform === "win32") {
    const res = await powershell("if (Get-Process -Name 'Notion Calendar' -ErrorAction SilentlyContinue) { 'true' } else { 'false' }");
    const running = /true/i.test(res.stdout);
    return { running, platform: "win32", method: "powershell", detail: running ? `${APP_NAME} is running.` : `${APP_NAME} is not running. Ask the user to open it.` };
  }
  return { running: false, platform: process.platform, method: "unsupported", detail: `Controlling ${APP_NAME} is only supported on macOS and Windows.` };
}

// ---------- plan execution ----------

const ACCESSIBILITY_HELP = `macOS blocked the keystrokes: Notion Oracle needs Accessibility permission. Tell the user to open System Settings → Privacy & Security → Accessibility, enable Notion Oracle, then try again.`;

/** Turns a plan into one AppleScript so the delays between steps are precise. */
export function planToAppleScript(steps: Step[]): string[] {
  const lines: string[] = [];
  for (const step of steps) {
    switch (step.type) {
      case "activate":
        lines.push(`tell application "${APP_NAME}" to activate`);
        break;
      case "delay":
        lines.push(`delay ${(step.ms / 1000).toFixed(2)}`);
        break;
      case "open-url":
        lines.push(`do shell script "open " & quoted form of ${appleScriptString(step.url)}`);
        break;
      case "keys":
        if (step.combo === "c") lines.push(`tell application "System Events" to keystroke "c"`);
        else if (step.combo === "cmd+k") lines.push(`tell application "System Events" to keystroke "k" using command down`);
        else if (step.combo === "enter") lines.push(`tell application "System Events" to key code 36`);
        else lines.push(`tell application "System Events" to key code 53`);
        break;
      case "type":
        // keystroke handles ASCII; anything else goes through the clipboard so accents and emoji survive.
        if (/^[\x20-\x7e]*$/.test(step.text)) lines.push(`tell application "System Events" to keystroke ${appleScriptString(step.text)}`);
        else lines.push(`set the clipboard to ${appleScriptString(step.text)}`, `tell application "System Events" to keystroke "v" using command down`);
        break;
    }
  }
  return lines;
}

/** Turns a plan into one PowerShell script using SendKeys. */
export function planToPowerShell(steps: Step[]): string {
  const lines: string[] = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$sig = '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);'",
    "$fg = Add-Type -MemberDefinition $sig -Name W -Namespace N -PassThru",
  ];
  for (const step of steps) {
    switch (step.type) {
      case "activate":
        lines.push(`$p = Get-Process -Name '${APP_NAME}' -ErrorAction SilentlyContinue | Select-Object -First 1`, `if (-not $p) { throw '${APP_NAME} is not running' }`, "[void]$fg::SetForegroundWindow($p.MainWindowHandle)");
        break;
      case "delay":
        lines.push(`Start-Sleep -Milliseconds ${step.ms}`);
        break;
      case "open-url":
        lines.push(`Start-Process '${step.url.replace(/'/g, "''")}'`);
        break;
      case "keys":
        lines.push(`[System.Windows.Forms.SendKeys]::SendWait('${step.combo === "c" ? "c" : step.combo === "cmd+k" ? "^k" : step.combo === "enter" ? "{ENTER}" : "{ESC}"}')`);
        break;
      case "type":
        lines.push(`[System.Windows.Forms.SendKeys]::SendWait('${sendKeysEscape(step.text).replace(/'/g, "''")}')`);
        break;
    }
  }
  return lines.join("\n");
}

export async function executePlan(steps: Step[]): Promise<void> {
  if (process.platform === "darwin") {
    const res = await osascript(planToAppleScript(steps));
    if (res.code !== 0) {
      const err = res.stderr.trim();
      if (/assistive access|not allowed to send keystrokes|-1719|1002/i.test(err)) throw new Error(ACCESSIBILITY_HELP);
      throw new Error(`Controlling ${APP_NAME} failed: ${err || "unknown error"}`);
    }
    return;
  }
  if (process.platform === "win32") {
    const res = await powershell(planToPowerShell(steps));
    if (res.code !== 0) throw new Error(`Controlling ${APP_NAME} failed: ${res.stderr.trim() || "unknown error"}`);
    return;
  }
  throw new Error(`Controlling ${APP_NAME} is only supported on macOS and Windows.`);
}

export async function activateCalendarApp(): Promise<void> {
  await executePlan([{ type: "activate" }]);
}

export async function openCalendarDate(date: Date): Promise<void> {
  await executePlan([{ type: "activate" }, { type: "delay", ms: 500 }, { type: "open-url", url: dateUrl(date) }]);
}

export interface CreateEventResult {
  steps: string[];
  saved: boolean;
  note: string;
}

export async function createCalendarEvent(input: CreateEventInput, options: PlanOptions): Promise<CreateEventResult> {
  // Validate the request before touching the app, so a bad date is reported as a bad date
  // rather than being hidden behind "the app is not running".
  const plan = buildCreateEventPlan(input, options);
  const status = await calendarAppStatus();
  if (!status.running) throw new Error(status.detail);
  await executePlan(plan);
  return {
    steps: describePlan(plan),
    saved: options.save,
    note: options.save
      ? `Pressed Enter to save. Ask the user to glance at ${APP_NAME} to confirm the event landed on the right day and time; keystroke automation cannot read the result back.`
      : `The new event is open in ${APP_NAME} with the title filled in. The user needs to check the day and time, then press Enter (or click Save) to keep it, or Escape to discard it.`,
  };
}
