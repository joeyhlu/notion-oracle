/**
 * Reverses a change from the journal.
 *
 * Undo runs in the main process rather than through the model: it is a fixed set of API calls
 * derived from what was recorded, so there is nothing to decide and no reason to spend a turn on
 * it. Each step is the exact inverse of the tool that made the change.
 */

import { NotionClient } from "../../../extension/src/lib/notion.ts";
import type { Change, UndoStep } from "../shared/journal.ts";

export interface UndoResult {
  ok: boolean;
  message: string;
}

/** An undo that is a conversion: the replacement goes, the original comes back out of the trash. */
type WithUnarchive = Extract<UndoStep, { type: "delete-blocks" }> & { thenUnarchive?: string };

export async function undoNotionChange(notion: NotionClient, step: UndoStep): Promise<UndoResult> {
  switch (step.type) {
    case "delete-blocks": {
      const { blockIds, thenUnarchive } = step as WithUnarchive;
      // Best-effort per block: one already-deleted block should not strand the rest.
      const failures: string[] = [];
      for (const id of blockIds) {
        try {
          await notion.deleteBlock(id);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (thenUnarchive) {
        try {
          await notion.unarchiveBlock(thenUnarchive);
        } catch (error) {
          return { ok: false, message: `Removed the new blocks, but could not restore the original: ${describe(error)}` };
        }
      }
      if (failures.length === blockIds.length && blockIds.length) {
        return { ok: false, message: `Could not remove the blocks: ${failures[0]}` };
      }
      const removed = blockIds.length - failures.length;
      return { ok: true, message: failures.length ? `Removed ${removed} of ${blockIds.length} blocks; the rest were already gone.` : "Removed." };
    }

    case "restore-block":
      await notion.restoreBlock(step.blockId, step.block);
      return { ok: true, message: "Put the previous text back." };

    case "unarchive-block":
      await notion.unarchiveBlock(step.blockId);
      return { ok: true, message: "Restored from Notion's trash." };

    case "archive-page":
      await notion.archivePage(step.pageId);
      return { ok: true, message: "Moved to Notion's trash." };

    case "restore-page-properties":
      await notion.updatePage(step.pageId, step.properties);
      return { ok: true, message: "Restored the previous values." };

    default:
      return { ok: false, message: "That change cannot be undone from here." };
  }
}

/**
 * Reverses a calendar change by shelling out to the same AppleScript layer the MCP server uses.
 *
 * Imported lazily: mac-calendar refuses to load off macOS, and the main process runs everywhere.
 */
export async function undoCalendarChange(step: UndoStep): Promise<UndoResult> {
  if (process.platform !== "darwin") return { ok: false, message: "Calendar changes can only be undone on macOS." };
  const mac = await import("../mcp/mac-calendar.ts");
  if (step.type === "delete-event") {
    await mac.deleteEvent(step.uid, step.calendar);
    return { ok: true, message: "Event removed." };
  }
  if (step.type === "restore-event") {
    const f = step.fields as { title?: string; start?: string; end?: string; allDay?: boolean; location?: string; notes?: string };
    const existing = await mac.findEvent(step.uid, step.calendar);
    if (existing) {
      await mac.updateEvent({ uid: step.uid, calendar: step.calendar, title: f.title, start: f.start, end: f.end, location: f.location, notes: f.notes });
      return { ok: true, message: "Event restored to how it was." };
    }
    // Deleted rather than edited: Calendar.app has no trash, so it is recreated from the fields
    // and comes back with a new uid.
    const created = await mac.createEvent({ title: f.title ?? "Untitled", start: f.start ?? "", end: f.end, allDay: f.allDay, calendar: step.calendar, location: f.location, notes: f.notes });
    return { ok: true, message: `Event recreated in "${created.calendar}" with a new id.` };
  }
  return { ok: false, message: "That change cannot be undone from here." };
}

/** Routes a journal entry to whichever backend made it. */
export async function undoChange(change: Change, notion: NotionClient | null): Promise<UndoResult> {
  const step = change.undo;
  if (!step) return { ok: false, message: "This change was not recorded in a way that can be reversed." };
  if (change.kind === "event") return undoCalendarChange(step);
  if (!notion) return { ok: false, message: "Add your Notion integration secret in setup before undoing Notion changes." };
  return undoNotionChange(notion, step);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
