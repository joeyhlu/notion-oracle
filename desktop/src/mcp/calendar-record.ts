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
  }));
}
