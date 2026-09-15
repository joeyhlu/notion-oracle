/**
 * The shapes every calendar backend speaks, and the record format they answer in.
 *
 * macOS drives Calendar.app through AppleScript and Windows drives Outlook through PowerShell;
 * both print the same separator-delimited records so the parsing — and the tools above them —
 * stay identical. Unit separator and record separator because an event title can contain commas,
 * tabs and newlines, but not a C0 control character.
 */

export const FIELD_SEP = String.fromCharCode(31);
export const RECORD_SEP = String.fromCharCode(30);

export interface CalendarInfo {
  name: string;
  writable: boolean;
  description: string;
}

export interface CalendarEvent {
  uid: string;
  calendar: string;
  title: string;
  /** Local ISO 8601 without a zone, e.g. 2026-09-12T14:00:00. */
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  notes: string;
  /** RFC 5545 recurrence rule, empty for a one-off event. */
  recurrence: string;
  /**
   * Set on an occurrence produced by expanding a series: `start`/`end` are the occurrence's,
   * and these are the series' own (its first occurrence), which is what an edit applies to.
   */
  seriesStart?: string;
  seriesEnd?: string;
}

export interface CreateEventInput {
  title: string;
  start: string;
  end?: string;
  allDay?: boolean;
  calendar?: string;
  location?: string;
  notes?: string;
  /** RFC 5545 rule body, e.g. FREQ=WEEKLY;BYDAY=MO. */
  recurrence?: string;
}

export interface UpdateEventInput {
  uid: string;
  calendar: string;
  title?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  location?: string;
  notes?: string;
  /** New rule, or "" to stop the event repeating. */
  recurrence?: string;
}

// ---------- dates ----------

export function isDateOnly(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso.trim());
}

export function parseIso(iso: string, label: string): Date {
  const trimmed = iso.trim();
  const date = new Date(isDateOnly(trimmed) ? `${trimmed}T00:00:00` : trimmed);
  if (Number.isNaN(date.getTime())) throw new Error(`Could not parse ${label} "${iso}". Use ISO 8601, e.g. 2026-09-12T14:00:00, or 2026-09-12 for all day.`);
  return date;
}

/** The record format's date text: local wall-clock time, no zone, seconds included. */
export function localIso(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** The YYYY-MM-DD part of a record date. */
export function dayOf(iso: string): string {
  return iso.trim().slice(0, 10);
}

export function records(stdout: string): string[][] {
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
    notes: blank(f[7]),
    recurrence: blank(f[8]),
  }));
}

/** AppleScript renders an unset property as the words "missing value"; that is not content. */
function blank(field: string | undefined): string {
  const text = (field ?? "").trim();
  return text === "missing value" ? "" : text;
}
