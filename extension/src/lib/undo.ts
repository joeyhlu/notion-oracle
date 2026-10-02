/**
 * Reverses a Notion change Oracle recorded.
 *
 * Undo is a fixed set of API calls derived from what was recorded, so it runs without the model.
 * Each step is the exact inverse of the tool that made the change. Shared by the browser
 * extension and the desktop app; the desktop adds calendar steps on top.
 */

import type { NotionClient } from "./notion.ts";

/** The Notion half of the journal's undo steps. */
export type NotionUndoStep =
  /** Blocks Oracle created: remove them again. A conversion also names the original to restore. */
  | { type: "delete-blocks"; blockIds: string[]; thenUnarchive?: string }
  /** A block Oracle rewrote in place: put the old body back. */
  | { type: "restore-block"; blockId: string; block: Record<string, unknown> }
  /** A block Oracle archived: Notion keeps it, so it can come back. */
  | { type: "unarchive-block"; blockId: string }
  /** A page or database entry Oracle created: send it to the trash. */
  | { type: "archive-page"; pageId: string }
  /** Page properties Oracle overwrote: reapply what was there. */
  | { type: "restore-page-properties"; pageId: string; properties: Record<string, unknown> };

export const NOTION_UNDO_TYPES: ReadonlySet<string> = new Set(["delete-blocks", "restore-block", "unarchive-block", "archive-page", "restore-page-properties"]);

export function isNotionUndoStep(step: { type: string } | undefined | null): step is NotionUndoStep {
  return Boolean(step && NOTION_UNDO_TYPES.has(step.type));
}

export interface UndoResult {
  ok: boolean;
  message: string;
}

export async function undoNotionChange(notion: NotionClient, step: NotionUndoStep): Promise<UndoResult> {
  switch (step.type) {
    case "delete-blocks": {
      const { blockIds, thenUnarchive } = step;
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
