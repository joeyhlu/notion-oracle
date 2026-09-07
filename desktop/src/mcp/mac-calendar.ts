/**
 * Reads and writes the user's real calendar through macOS Calendar.app over AppleScript.
 *
 * Why this and not an API: Notion Calendar has none, and Google's requires the user to stand up
 * an OAuth client. Calendar.app is scriptable, and a Google account added in System Settings →
 * Internet Accounts syncs both ways - so an event created here reaches Google, and Notion
 * Calendar displays it. It also gives us reads, updates and deletes, which keystroke automation
 * never could.
 *
 * Every script is built as a string here and executed with execFile (never a shell), and all
 * user text is escaped into AppleScript literals.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Field and record separators: control characters that cannot appear in calendar text. */
const FIELD_SEP = String.fromCharCode(31);
const RECORD_SEP = String.fromCharCode(30);

export interface CalendarInfo {
  name: string;
  writable: boolean;
  description: string;
}

export interface CalendarEvent {
  uid: string;
  calendar: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
}

export interface CreateEventInput {
  title: string;
  start: string;
  end?: string;
  allDay?: boolean;
  calendar?: string;
  location?: string;
  notes?: string;
}

export interface UpdateEventInput {
  uid: string;
  calendar: string;
  title?: string;
  start?: string;
  end?: string;
  location?: string;
  notes?: string;
}

// ---------- escaping and dates ----------

/** Escapes a string into an AppleScript double-quoted literal. */
export function asString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function isDateOnly(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso.trim());
}

export function parseIso(iso: string, label: string): Date {
  const trimmed = iso.trim();
  const date = new Date(isDateOnly(trimmed) ? `${trimmed}T00:00:00` : trimmed);
  if (Number.isNaN(date.getTime())) throw new Error(`Could not parse ${label} "${iso}". Use ISO 8601, e.g. 2026-09-12T14:00:00, or 2026-09-12 for all day.`);
  return date;
}

/**
 * AppleScript statements that set `varName` to a date built from components. Never coerce a
 * date string: that goes through the user's locale and silently misreads. `day` is set to 1
 * first so changing month cannot overflow (Jan 31 with month set to 2 would roll into March).
 */
export function dateStatements(varName: string, date: Date): string[] {
  return [
    `set ${varName} to current date`,
    `set day of ${varName} to 1`,
    `set year of ${varName} to ${date.getFullYear()}`,
    `set month of ${varName} to ${date.getMonth() + 1}`,
    `set day of ${varName} to ${date.getDate()}`,
    `set hours of ${varName} to ${date.getHours()}`,
    `set minutes of ${varName} to ${date.getMinutes()}`,
    `set seconds of ${varName} to 0`,
  ];
}

/** ISO-8601 text for a date value, which AppleScript produces locale-independently. */
function isoOf(expr: string): string {
  return `((${expr}) as «class isot» as string)`;
}

// ---------- script builders (pure, so they are unit-testable) ----------

export function listCalendarsScript(): string {
  return [
    `set out to ""`,
    `set sep to (character id 31)`,
    `set rec to (character id 30)`,
    `tell application "Calendar"`,
    `  repeat with c in every calendar`,
    `    set d to ""`,
    `    try`,
    `      set d to (description of c) as string`,
    `    end try`,
    `    set out to out & (name of c) & sep & ((writable of c) as string) & sep & d & rec`,
    `  end repeat`,
    `end tell`,
    `return out`,
  ].join("\n");
}

export function listEventsScript(from: Date, to: Date, calendar?: string): string {
  const target = calendar ? `calendar ${asString(calendar)}` : `every calendar`;
  return [
    ...dateStatements("d0", from),
    ...dateStatements("d1", to),
    `set out to ""`,
    `set sep to (character id 31)`,
    `set rec to (character id 30)`,
    `tell application "Calendar"`,
    `  repeat with c in (${target})`,
    // Filtering with `whose` inside one calendar is far faster than scanning every event.
    `    set evs to (every event of c whose start date ≥ d0 and start date < d1)`,
    `    repeat with ev in evs`,
    `      set loc to ""`,
    `      try`,
    `        set loc to (location of ev) as string`,
    `      end try`,
    `      set out to out & (uid of ev) & sep & (name of c) & sep & (summary of ev) & sep & ${isoOf("start date of ev")} & sep & ${isoOf("end date of ev")} & sep & ((allday event of ev) as string) & sep & loc & rec`,
    `    end repeat`,
    `  end repeat`,
    `end tell`,
    `return out`,
  ].join("\n");
}

export function createEventScript(input: CreateEventInput, calendarName: string): string {
  const start = parseIso(input.start, "start");
  const allDay = Boolean(input.allDay) || isDateOnly(input.start);
  let end: Date;
  if (input.end) {
    end = parseIso(input.end, "end");
  } else if (allDay) {
    end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  } else {
    end = new Date(start.getTime() + 60 * 60 * 1000);
  }
  if (end.getTime() <= start.getTime()) throw new Error("The event's end must be after its start.");

  const props = [`summary:${asString(input.title)}`, `start date:s`, `end date:e`];
  if (allDay) props.push(`allday event:true`);
  if (input.location) props.push(`location:${asString(input.location)}`);
  if (input.notes) props.push(`description:${asString(input.notes)}`);

  return [
    ...dateStatements("s", start),
    ...dateStatements("e", end),
    `tell application "Calendar"`,
    `  tell calendar ${asString(calendarName)}`,
    `    set newEvent to make new event with properties {${props.join(", ")}}`,
    `    set theUid to uid of newEvent`,
    `  end tell`,
    // Pushes the change to the account now instead of waiting for the next sync.
    `  reload calendars`,
    `end tell`,
    `return theUid`,
  ].join("\n");
}

export function updateEventScript(input: UpdateEventInput): string {
  const lines: string[] = [];
  if (input.start) lines.push(...dateStatements("s", parseIso(input.start, "start")));
  if (input.end) lines.push(...dateStatements("e", parseIso(input.end, "end")));
  const sets: string[] = [];
  if (input.title !== undefined) sets.push(`set summary of ev to ${asString(input.title)}`);
  if (input.start) sets.push(`set start date of ev to s`);
  if (input.end) sets.push(`set end date of ev to e`);
  if (input.location !== undefined) sets.push(`set location of ev to ${asString(input.location)}`);
  if (input.notes !== undefined) sets.push(`set description of ev to ${asString(input.notes)}`);
  if (!sets.length) throw new Error("Nothing to change: pass at least one of title, start, end, location or notes.");

  return [
    ...lines,
    `tell application "Calendar"`,
    `  tell calendar ${asString(input.calendar)}`,
    `    set ev to first event whose uid = ${asString(input.uid)}`,
    ...sets.map((s) => `    ${s}`),
    `  end tell`,
    `  reload calendars`,
    `end tell`,
    `return "ok"`,
  ].join("\n");
}

/** One event by uid, in the same record shape listEventsScript produces. */
export function findEventScript(uid: string, calendar: string): string {
  return [
    `set out to ""`,
    `set sep to (character id 31)`,
    `set rec to (character id 30)`,
    `tell application "Calendar"`,
    `  tell calendar ${asString(calendar)}`,
    `    set ev to first event whose uid = ${asString(uid)}`,
    `    set loc to ""`,
    `    try`,
    `      set loc to (location of ev) as string`,
    `    end try`,
    `    set out to (uid of ev) & sep & ${asString(calendar)} & sep & (summary of ev) & sep & ${isoOf("start date of ev")} & sep & ${isoOf("end date of ev")} & sep & ((allday event of ev) as string) & sep & loc & rec`,
    `  end tell`,
    `end tell`,
    `return out`,
  ].join("\n");
}

export function deleteEventScript(uid: string, calendar: string): string {
  return [
    `tell application "Calendar"`,
    `  tell calendar ${asString(calendar)}`,
    `    delete (first event whose uid = ${asString(uid)})`,
    `  end tell`,
    `  reload calendars`,
    `end tell`,
    `return "ok"`,
  ].join("\n");
}

// ---------- output parsing ----------

function records(stdout: string): string[][] {
  return stdout
    .split(RECORD_SEP)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => r.split(FIELD_SEP));
}

export function parseCalendars(stdout: string): CalendarInfo[] {
  return records(stdout).map((f) => ({ name: f[0] ?? "", writable: (f[1] ?? "").toLowerCase() === "true", description: f[2] ?? "" }));
}

export function parseEvents(stdout: string): CalendarEvent[] {
  return records(stdout).map((f) => ({
    uid: f[0] ?? "",
    calendar: f[1] ?? "",
    title: f[2] ?? "",
    start: f[3] ?? "",
    end: f[4] ?? "",
    allDay: (f[5] ?? "").toLowerCase() === "true",
    location: f[6] ?? "",
  }));
}

// ---------- execution ----------

const PERMISSION_HELP =
  "macOS blocked access to Calendar. Tell the user to open System Settings → Privacy & Security → Automation and allow Notion Oracle to control Calendar, and to check Privacy & Security → Calendars grants it Full Access. Then ask again.";
const NO_CALENDAR_APP = "Could not reach the macOS Calendar app. The user needs to add their calendar account in System Settings → Internet Accounts.";

export function describeAppleScriptError(stderr: string): string {
  const err = stderr.trim();
  if (/-1743|not authoriz|not allowed|assistive access/i.test(err)) return PERMISSION_HELP;
  if (/-600|isn.t running|-10814/i.test(err)) return NO_CALENDAR_APP;
  if (/-1728|Can.t get/i.test(err)) return `Calendar could not find that item: ${err}`;
  return `Calendar scripting failed: ${err || "unknown error"}`;
}

export function runAppleScript(script: string, timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/osascript", ["-"], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(describeAppleScriptError(stderr || String(error))));
      resolve(stdout);
    });
    child.stdin?.end(script);
  });
}

export function assertMac(): void {
  if (process.platform !== "darwin") throw new Error("Reading and writing the system calendar is only supported on macOS. On Windows, Oracle can still create events by driving the Notion Calendar app.");
}

export async function listCalendars(): Promise<CalendarInfo[]> {
  assertMac();
  return parseCalendars(await runAppleScript(listCalendarsScript()));
}

/**
 * Ranks calendars for the automatic default. A Google or iCloud account's primary calendar is
 * named after the account address, which is almost always what someone means by "my calendar";
 * a bare local calendar (macOS creates one called "Untitled" or "Calendar" with no account
 * behind it) is the worst choice, because nothing there ever syncs to a phone or to Notion
 * Calendar. Preferring the first writable one put an event somewhere the user could not see.
 */
export function scoreCalendar(name: string): number {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name.trim())) return 100;
  if (/^(untitled|calendar)$/i.test(name.trim()) || !name.trim()) return -100;
  return 0;
}

export function pickDefaultCalendar(calendars: CalendarInfo[]): CalendarInfo | undefined {
  const writable = calendars.filter((c) => c.writable);
  if (!writable.length) return undefined;
  return [...writable].sort((a, b) => scoreCalendar(b.name) - scoreCalendar(a.name))[0];
}

/**
 * Picks the calendar to write to: an explicit request, else the user's saved default, else the
 * best guess. Subscriptions such as "Holidays in Canada" are read-only and must never be
 * targeted, so an explicit request for one is refused rather than silently redirected.
 */
export async function resolveCalendar(requested?: string): Promise<string> {
  const all = await listCalendars();
  if (!all.length) throw new Error(NO_CALENDAR_APP);
  const wanted = requested?.trim() || readDefaultCalendar();
  if (wanted) {
    const exact = all.find((c) => c.name === wanted) ?? all.find((c) => c.name.toLowerCase() === wanted.toLowerCase());
    if (!exact) {
      // A saved default that no longer exists should not block the user; fall through to the guess.
      if (requested?.trim()) throw new Error(`No calendar named "${wanted}". Available: ${all.map((c) => `${c.name}${c.writable ? "" : " (read-only)"}`).join(", ")}`);
    } else if (!exact.writable) {
      throw new Error(`"${exact.name}" is read-only (a subscribed calendar). Pick a writable one: ${all.filter((c) => c.writable).map((c) => c.name).join(", ")}`);
    } else {
      return exact.name;
    }
  }
  const picked = pickDefaultCalendar(all);
  if (!picked) throw new Error("No writable calendars are set up in the macOS Calendar app. The user needs to add their account in System Settings → Internet Accounts.");
  return picked.name;
}

// ---------- remembered default ----------

/**
 * The chosen default lives beside the app's settings so it survives restarts. The MCP server is
 * a separate short-lived process, so it reads the file on each call rather than caching it.
 */
function defaultCalendarFile(): string | null {
  const dir = process.env.CALENDAR_STATE_DIR;
  return dir ? join(dir, "calendar-default.json") : null;
}

export function readDefaultCalendar(): string {
  const file = defaultCalendarFile();
  if (!file) return "";
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { calendar?: string };
    return typeof parsed.calendar === "string" ? parsed.calendar : "";
  } catch {
    return "";
  }
}

export async function setDefaultCalendar(name: string): Promise<string> {
  assertMac();
  const resolved = await resolveCalendar(name);
  const file = defaultCalendarFile();
  if (!file) throw new Error("Nowhere to save the default calendar; restart Notion Oracle and try again.");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ calendar: resolved }, null, 2));
  return resolved;
}

export async function listEvents(from: string, to: string, calendar?: string): Promise<CalendarEvent[]> {
  assertMac();
  const start = parseIso(from, "from");
  const end = parseIso(to, "to");
  const name = calendar ? await resolveCalendar(calendar) : undefined;
  const events = parseEvents(await runAppleScript(listEventsScript(start, end, name)));
  return events.sort((a, b) => a.start.localeCompare(b.start));
}

export async function createEvent(input: CreateEventInput): Promise<{ uid: string; calendar: string }> {
  assertMac();
  if (!input.title.trim()) throw new Error("The event needs a title.");
  const calendar = await resolveCalendar(input.calendar);
  const uid = (await runAppleScript(createEventScript(input, calendar))).trim();
  return { uid, calendar };
}

export async function updateEvent(input: UpdateEventInput): Promise<void> {
  assertMac();
  await runAppleScript(updateEventScript({ ...input, calendar: await resolveCalendar(input.calendar) }));
}

/**
 * Moves an event between calendars. AppleScript cannot reassign an event's calendar, so this
 * copies it across and deletes the original - which means a new uid.
 */
export async function moveEvent(uid: string, fromCalendar: string, toCalendar: string): Promise<{ uid: string; calendar: string }> {
  assertMac();
  const source = await resolveCalendar(fromCalendar);
  const target = await resolveCalendar(toCalendar);
  if (source === target) throw new Error(`The event is already in "${target}".`);
  const found = parseEvents(await runAppleScript(findEventScript(uid, source)))[0];
  if (!found) throw new Error(`No event with uid "${uid}" in "${source}".`);
  const created = await createEvent({
    title: found.title,
    start: found.start,
    end: found.end,
    allDay: found.allDay,
    calendar: target,
    location: found.location || undefined,
  });
  // Only remove the original once the copy exists, so a failure cannot lose the event.
  await deleteEvent(uid, source);
  return created;
}

export async function deleteEvent(uid: string, calendar: string): Promise<void> {
  assertMac();
  await runAppleScript(deleteEventScript(uid, await resolveCalendar(calendar)));
}
