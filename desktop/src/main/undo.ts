/**
 * Reverses a change from the journal.
 *
 * Undo runs in the main process rather than through the model: it is a fixed set of API calls
 * derived from what was recorded, so there is nothing to decide and no reason to spend a turn on
 * it. Each step is the exact inverse of the tool that made the change.
 */

import type { NotionClient } from "../../../extension/src/lib/notion.ts";
import { isNotionUndoStep, undoNotionChange, type UndoResult } from "../../../extension/src/lib/undo.ts";
import type { Change, UndoStep } from "../shared/journal.ts";
import type { CalendarEvent, CreateEventInput, UpdateEventInput } from "../mcp/calendar-record.ts";

export { undoNotionChange } from "../../../extension/src/lib/undo.ts";
export type { UndoResult } from "../../../extension/src/lib/undo.ts";

/**
 * Reverses a calendar change through the same backend the MCP server used: Calendar.app over
 * AppleScript on macOS, Outlook over PowerShell on Windows.
 *
 * Imported lazily: each backend refuses to run off its platform, and the main process runs
 * everywhere.
 */
export async function undoCalendarChange(step: UndoStep): Promise<UndoResult> {
  const backend = await calendarBackend();
  if (!backend) return { ok: false, message: "Calendar changes can only be undone on macOS or Windows." };
  if (step.type === "delete-event") {
    await backend.deleteEvent(step.uid, step.calendar);
    return { ok: true, message: "Event removed." };
  }
  if (step.type === "move-event-back") {
    const moved = await backend.moveEvent(step.uid, step.calendar, step.toCalendar);
    return { ok: true, message: `Event moved back to "${moved.calendar}".` };
  }
  if (step.type === "restore-event") {
    const f = step.fields as { title?: string; start?: string; end?: string; allDay?: boolean; location?: string; notes?: string; recurrence?: string };
    const existing = await backend.findEvent(step.uid, step.calendar);
    if (existing) {
      await backend.updateEvent({
        uid: step.uid,
        calendar: step.calendar,
        title: f.title,
        start: f.start,
        end: f.end,
        allDay: f.allDay,
        location: f.location,
        notes: f.notes,
        // Entries written before repeat rules were recorded have no recurrence field; leave the
        // rule alone for those rather than clearing a series the user set up themselves.
        recurrence: typeof f.recurrence === "string" ? f.recurrence : undefined,
      });
      return { ok: true, message: "Event restored to how it was." };
    }
    // Deleted rather than edited: Calendar.app has no trash, so it is recreated from the fields
    // and comes back with a new uid.
    const created = await backend.createEvent({ title: f.title ?? "Untitled", start: f.start ?? "", end: f.end, allDay: f.allDay, calendar: step.calendar, location: f.location, notes: f.notes, recurrence: f.recurrence || undefined });
    return { ok: true, message: `Event recreated in "${created.calendar}" with a new id.` };
  }
  return { ok: false, message: "That change cannot be undone from here." };
}

interface CalendarBackend {
  findEvent(uid: string, calendar: string): Promise<CalendarEvent | null>;
  updateEvent(input: UpdateEventInput): Promise<void>;
  createEvent(input: CreateEventInput): Promise<{ uid: string; calendar: string }>;
  deleteEvent(uid: string, calendar: string): Promise<void>;
  moveEvent(uid: string, from: string, to: string): Promise<{ uid: string; calendar: string }>;
}

async function calendarBackend(): Promise<CalendarBackend | null> {
  if (process.platform === "darwin") {
    const mac = await import("../mcp/mac-calendar.ts");
    return { findEvent: mac.findEvent, updateEvent: mac.updateEvent, createEvent: mac.createEvent, deleteEvent: mac.deleteEvent, moveEvent: mac.moveEvent };
  }
  if (process.platform === "win32") {
    const win = await import("../mcp/win-calendar.ts");
    const mac = await import("../mcp/mac-calendar.ts");
    return {
      findEvent: (uid) => win.findEvent(uid),
      updateEvent: (input) => win.updateEvent(input),
      createEvent: async (input) => win.createEvent({ ...input, calendar: await win.resolveCalendar(input.calendar, mac.readDefaultCalendar()) }),
      deleteEvent: (uid) => win.deleteEvent(uid),
      moveEvent: (uid, _from, to) => win.moveEvent(uid, to),
    };
  }
  return null;
}

/** Routes a journal entry to whichever backend made it. */
export async function undoChange(change: Change, notion: NotionClient | null): Promise<UndoResult> {
  const step = change.undo;
  if (!step) return { ok: false, message: "This change was not recorded in a way that can be reversed." };
  if (change.kind === "event") return undoCalendarChange(step);
  if (!notion) return { ok: false, message: "Add your Notion integration secret in setup before undoing Notion changes." };
  if (!isNotionUndoStep(step)) return { ok: false, message: "That change cannot be undone from here." };
  return undoNotionChange(notion, step);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
