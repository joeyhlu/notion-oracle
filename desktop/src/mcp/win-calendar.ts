/**
 * Calendar on Windows, through Outlook's COM automation.
 *
 * Windows has no system-wide scriptable calendar the way macOS does. The Mail and Calendar apps
 * expose their store only to packaged UWP apps, which an Electron build is not. Outlook desktop
 * is the one calendar on Windows that any local program can read and write, and it is where a
 * work Microsoft 365 account already lives — and a Google or iCloud account added to Outlook
 * shows up here too.
 *
 * So: real read/write where Outlook is installed, and the create-only Notion Calendar keystroke
 * fallback everywhere else. calendar-server decides which, and says which one is in effect.
 *
 * Everything here prints the same separator-delimited records the macOS backend does, so the
 * tools above the two are identical.
 */

import { records, parseCalendars, parseEvents, type CalendarEvent, type CalendarInfo, type CreateEventInput, type UpdateEventInput } from "./calendar-record.ts";
import { runCapture } from "../main/process.ts";
import { parseRRule, WEEKDAYS, type Rule } from "./rrule.ts";

/** olFolderCalendar. The default calendar of a mail store. */
const OL_FOLDER_CALENDAR = 9;
/** olAppointmentItem. */
const OL_APPOINTMENT = 1;
/** OlRecurrenceType: daily, weekly, monthly, yearly. (3 and 6 are the "nth weekday" variants.) */
const OL_RECURS: Record<Rule["freq"], number> = { DAILY: 0, WEEKLY: 1, MONTHLY: 2, YEARLY: 5 };

export function assertWindows(): void {
  if (process.platform !== "win32") throw new Error("The Outlook calendar backend only runs on Windows.");
}

/**
 * Escapes a string into a PowerShell single-quoted literal.
 *
 * Single quotes because PowerShell does no interpolation inside them: a title containing `$(...)`
 * or a backtick is data, not code. Doubling the quote is the only escape they need.
 */
export function psLiteral(text: string): string {
  return `'${String(text).replace(/'/g, "''")}'`;
}

/**
 * Outlook's Restrict() parses dates with the *user's* short-date setting, not the invariant one,
 * so a filter string built as ISO silently matches nothing on a machine set to dd/MM/yyyy. The
 * documented workaround is the US format with an explicit AM/PM, which Outlook accepts whatever
 * the locale — hence formatting it by hand rather than through ToString().
 */
export function outlookDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const hours24 = date.getHours();
  const suffix = hours24 < 12 ? "AM" : "PM";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()} ${pad(hours12)}:${pad(date.getMinutes())} ${suffix}`;
}

/** Shared preamble: connect to Outlook and fail with a sentence the user can act on. */
function preamble(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "try { $outlook = New-Object -ComObject Outlook.Application } catch { Write-Error 'OUTLOOK_MISSING'; exit 1 }",
    "$ns = $outlook.GetNamespace('MAPI')",
  ].join("\n");
}

/** Emits one record, joining fields with the separators the parsers expect. */
function emit(fields: string[]): string {
  return `Write-Output ((@(${fields.join(", ")}) -join [char]31) + [char]30)`;
}

/**
 * Every calendar folder across every store, so a person with a personal and a work account sees
 * both — matching what the macOS backend lists.
 */
export function listCalendarsScript(): string {
  return [
    preamble(),
    "$seen = @{}",
    "foreach ($store in $ns.Folders) {",
    // Store.GetDefaultFolder is locale-independent; the folder is called Kalender, Calendrier and
    // so on, so looking it up by the English name finds nothing outside an English install. The
    // name lookup stays as a fallback for stores that do not expose a Store object.
    `  try { $cal = $store.Store.GetDefaultFolder(${OL_FOLDER_CALENDAR}) } catch { $cal = $null }`,
    "  if ($null -eq $cal) { try { $cal = $store.Folders.Item('Calendar') } catch { $cal = $null } }",
    "  if ($null -eq $cal) { continue }",
    "  $name = $store.Name",
    "  if ($seen.ContainsKey($name)) { continue }",
    "  $seen[$name] = $true",
    // Outlook has no per-folder read-only flag worth trusting; a calendar you can open you can
    // usually write. Reported writable, and a failed write says so plainly.
    `  ${emit(["$name", "'true'", "$cal.FolderPath"])}`,
    "}",
  ].join("\n");
}

/** Resolves a calendar name to its folder, falling back to the default store's calendar. */
function folderLookup(calendar?: string): string {
  if (!calendar) return `$folder = $ns.GetDefaultFolder(${OL_FOLDER_CALENDAR})`;
  return [
    "$folder = $null",
    "foreach ($store in $ns.Folders) {",
    `  if ($store.Name -eq ${psLiteral(calendar)}) {`,
    `    try { $folder = $store.Store.GetDefaultFolder(${OL_FOLDER_CALENDAR}) } catch { }`,
    "    if ($null -eq $folder) { try { $folder = $store.Folders.Item('Calendar') } catch { } }",
    "  }",
    "}",
    `if ($null -eq $folder) { $folder = $ns.GetDefaultFolder(${OL_FOLDER_CALENDAR}) }`,
  ].join("\n");
}

/**
 * Lines that print one event as a record, `$item` being the appointment and `$calName` the
 * calendar it belongs to. The repeat rule is rebuilt as RFC 5545 text from Outlook's pattern
 * object so both backends describe a series the same way.
 */
function eventRecord(): string {
  return [
    "$isAllDay = if ($item.AllDayEvent) { 'true' } else { 'false' }",
    "$rr = ''",
    "if ($item.IsRecurring) {",
    "  try {",
    "    $p = $item.GetRecurrencePattern()",
    "    $freq = switch ($p.RecurrenceType) { 0 {'DAILY'} 1 {'WEEKLY'} 2 {'MONTHLY'} 3 {'MONTHLY'} 5 {'YEARLY'} 6 {'YEARLY'} default {'DAILY'} }",
    "    $rr = \"FREQ=$freq\"",
    "    if ($p.Interval -gt 1) { $rr += \";INTERVAL=$($p.Interval)\" }",
    "    if ($p.RecurrenceType -eq 1) {",
    "      $days = @()",
    ...WEEKDAYS.map((day, i) => `      if ($p.DayOfWeekMask -band ${1 << i}) { $days += '${day}' }`),
    "      if ($days.Count -gt 0) { $rr += ';BYDAY=' + ($days -join ',') }",
    "    }",
    "    if (-not $p.NoEndDate) { $rr += ';UNTIL=' + $p.PatternEndDate.ToString('yyyyMMdd') }",
    "  } catch { $rr = 'FREQ=DAILY' }",
    "}",
    "$notes = ''",
    "try { $notes = [string]$item.Body } catch { }",
    emit([
      "$item.EntryID",
      "$calName",
      "$item.Subject",
      "$item.Start.ToString('yyyy-MM-ddTHH:mm:ss')",
      "$item.End.ToString('yyyy-MM-ddTHH:mm:ss')",
      "$isAllDay",
      "$item.Location",
      "$notes",
      "$rr",
    ]),
  ].join("\n");
}

/**
 * PowerShell that makes `$item` repeat per an RFC 5545 rule, or stops it repeating for "".
 * RecurrenceType has to be set before anything else on the pattern or Outlook rejects it.
 */
export function recurrenceStatements(recurrence: string): string[] {
  if (!recurrence) return ["$item.ClearRecurrencePattern()"];
  const rule = parseRRule(recurrence);
  if (!rule) throw new Error(`Could not read the repeat rule "${recurrence}".`);
  const lines = ["$rp = $item.GetRecurrencePattern()", `$rp.RecurrenceType = ${OL_RECURS[rule.freq]}`, `$rp.Interval = ${rule.interval}`];
  if (rule.freq === "WEEKLY" && rule.byDay?.length) {
    const mask = rule.byDay.reduce((m, day) => m | (1 << WEEKDAYS.indexOf(day)), 0);
    lines.push(`$rp.DayOfWeekMask = ${mask}`);
  }
  if (rule.count) lines.push(`$rp.Occurrences = ${rule.count}`);
  else if (rule.until) lines.push(`$rp.PatternEndDate = [datetime]::Parse(${psLiteral(rule.until.toISOString().slice(0, 10))})`);
  else lines.push("$rp.NoEndDate = $true");
  return lines;
}

export function listEventsScript(from: Date, to: Date, calendar?: string): string {
  return [
    preamble(),
    folderLookup(calendar),
    "$items = $folder.Items",
    // Both are required, in this order, for a recurring series to be expanded into occurrences;
    // without them a weekly standup appears once, on the day it was first created.
    "$items.IncludeRecurrences = $true",
    "$items.Sort('[Start]')",
    `$filter = "[Start] >= '${outlookDate(from)}' AND [Start] <= '${outlookDate(to)}'"`,
    "$found = $items.Restrict($filter)",
    "$calName = $folder.Parent.Name",
    "foreach ($item in $found) {",
    "  if ($null -eq $item.Start) { continue }",
    eventRecord(),
    "}",
  ].join("\n");
}

export function createEventScript(input: CreateEventInput, calendar?: string): string {
  const lines = [
    preamble(),
    folderLookup(calendar),
    `$item = $folder.Items.Add(${OL_APPOINTMENT})`,
    `$item.Subject = ${psLiteral(input.title)}`,
    `$item.Start = [datetime]::Parse(${psLiteral(input.start)})`,
  ];
  if (input.allDay) lines.push("$item.AllDayEvent = $true");
  if (input.end) lines.push(`$item.End = [datetime]::Parse(${psLiteral(input.end)})`);
  if (input.location) lines.push(`$item.Location = ${psLiteral(input.location)}`);
  if (input.notes) lines.push(`$item.Body = ${psLiteral(input.notes)}`);
  if (input.recurrence) lines.push(...recurrenceStatements(input.recurrence));
  lines.push("$item.Save()", emit(["$item.EntryID", "$folder.Parent.Name"]));
  return lines.join("\n");
}

/** Fetches by EntryID, which is what list and create hand back as the uid. */
function itemLookup(uid: string): string {
  return [
    `$item = $null`,
    `try { $item = $ns.GetItemFromID(${psLiteral(uid)}) } catch { }`,
    `if ($null -eq $item) { Write-Error 'EVENT_NOT_FOUND'; exit 1 }`,
  ].join("\n");
}

export function updateEventScript(input: UpdateEventInput): string {
  const lines = [preamble(), itemLookup(input.uid)];
  if (input.title !== undefined) lines.push(`$item.Subject = ${psLiteral(input.title)}`);
  if (input.allDay !== undefined) lines.push(`$item.AllDayEvent = ${input.allDay ? "$true" : "$false"}`);
  if (input.start) lines.push(`$item.Start = [datetime]::Parse(${psLiteral(input.start)})`);
  if (input.end) lines.push(`$item.End = [datetime]::Parse(${psLiteral(input.end)})`);
  if (input.location !== undefined) lines.push(`$item.Location = ${psLiteral(input.location)}`);
  if (input.notes !== undefined) lines.push(`$item.Body = ${psLiteral(input.notes)}`);
  if (input.recurrence !== undefined) lines.push(...recurrenceStatements(input.recurrence));
  lines.push("$item.Save()", "Write-Output 'ok'");
  return lines.join("\n");
}

export function findEventScript(uid: string): string {
  return [preamble(), itemLookup(uid), "$calName = $item.Parent.Parent.Name", eventRecord()].join("\n");
}

export function deleteEventScript(uid: string): string {
  return [preamble(), itemLookup(uid), "$item.Delete()", "Write-Output 'ok'"].join("\n");
}

// ---------- execution ----------

const NO_OUTLOOK =
  "Outlook is not installed on this PC, so Oracle cannot read or change the calendar directly. " +
  "It can still create events by typing into the Notion Calendar app: tell the user to switch the calendar mode to " +
  '"Type into Notion Calendar" in Oracle\'s setup, or install Outlook and add their account to it.';

export function describePowerShellError(stderr: string): string {
  const err = stderr.trim();
  if (/OUTLOOK_MISSING|Retrieving the COM class factory|80040154/i.test(err)) return NO_OUTLOOK;
  if (/EVENT_NOT_FOUND/i.test(err)) return "Outlook has no event with that id. List the events again to get a current one.";
  if (/operation aborted|denied|0x80070005/i.test(err)) return "Outlook refused the request. It may be showing a security prompt, or be running as administrator while Oracle is not.";
  return err || "The Outlook calendar command failed without saying why.";
}

export async function runPowerShell(script: string, timeoutMs = 30000): Promise<string> {
  const res = await runCapture(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeoutMs },
  );
  if (res.code !== 0) throw new Error(describePowerShellError(res.stderr || res.stdout));
  return res.stdout;
}

/** True when Outlook automation is actually reachable, not merely when the platform is Windows. */
export async function isAvailable(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    await runPowerShell(`${preamble()}\nWrite-Output 'ok'`, 12000);
    return true;
  } catch {
    return false;
  }
}

export async function listCalendars(): Promise<CalendarInfo[]> {
  assertWindows();
  return parseCalendars(await runPowerShell(listCalendarsScript()));
}

export async function listEvents(from: string, to: string, calendar?: string): Promise<CalendarEvent[]> {
  assertWindows();
  return parseEvents(await runPowerShell(listEventsScript(new Date(from), new Date(to), calendar)));
}

export async function createEvent(input: CreateEventInput): Promise<{ uid: string; calendar: string }> {
  assertWindows();
  // The create script emits one two-field record: the new EntryID and the store it landed in.
  const [uid, calendar] = records(await runPowerShell(createEventScript(input, input.calendar)))[0] ?? [];
  if (!uid) throw new Error("Outlook accepted the event but did not report its id.");
  return { uid, calendar: calendar || "Calendar" };
}

export async function updateEvent(input: UpdateEventInput): Promise<void> {
  assertWindows();
  await runPowerShell(updateEventScript(input));
}

export async function findEvent(uid: string): Promise<CalendarEvent | null> {
  assertWindows();
  try {
    return parseEvents(await runPowerShell(findEventScript(uid)))[0] ?? null;
  } catch {
    return null;
  }
}

export async function deleteEvent(uid: string): Promise<void> {
  assertWindows();
  await runPowerShell(deleteEventScript(uid));
}

/**
 * Moves an event to another calendar.
 *
 * Outlook can genuinely move an item between folders, so unlike the macOS path this is not a
 * copy-then-delete and the event keeps its identity — though Move() returns a new EntryID.
 */
export function moveEventScript(uid: string, toCalendar: string): string {
  return [
    preamble(),
    itemLookup(uid),
    folderLookup(toCalendar),
    "$moved = $item.Move($folder)",
    emit(["$moved.EntryID", "$folder.Parent.Name"]),
  ].join("\n");
}

export async function moveEvent(uid: string, toCalendar: string): Promise<{ uid: string; calendar: string }> {
  assertWindows();
  const [movedUid, calendar] = records(await runPowerShell(moveEventScript(uid, toCalendar)))[0] ?? [];
  if (!movedUid) throw new Error("Outlook did not report where the event went.");
  return { uid: movedUid, calendar: calendar || toCalendar };
}

/**
 * Picks the calendar to write to: the one asked for, else the saved default, else the first.
 *
 * Deliberately simpler than the macOS ranking, which exists to skip the empty local "Untitled"
 * calendar macOS lists first. Outlook lists mail stores, and the first is the primary account.
 */
export async function resolveCalendar(requested: string | undefined, savedDefault: string): Promise<string> {
  const all = await listCalendars();
  if (!all.length) throw new Error(NO_OUTLOOK);
  const wanted = requested?.trim() || savedDefault;
  if (wanted) {
    const exact = all.find((c) => c.name === wanted) ?? all.find((c) => c.name.toLowerCase() === wanted.toLowerCase());
    if (exact) return exact.name;
    // A saved default that has gone away should not block the user; only an explicit ask errors.
    if (requested?.trim()) throw new Error(`No Outlook calendar named "${wanted}". Available: ${all.map((c) => c.name).join(", ")}`);
  }
  return all[0]!.name;
}
