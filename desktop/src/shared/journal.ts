/**
 * A record of everything Oracle changed, and enough state to put it back.
 *
 * The MCP servers run as child processes spawned by the CLI, so the ids of created blocks and the
 * content of overwritten ones exist only inside them. Rather than trying to reconstruct changes
 * from the CLI's tool-call stream — which reports a truncated summary string — each mutating tool
 * appends a line here, and the main process reads the file back to render and reverse them.
 *
 * This module holds the shapes and the pure helpers, so the renderer — which bundles for the
 * browser and cannot take node:fs — can import them. The file-backed store is journal-file.ts.
 */


export type ChangeKind = "block" | "page" | "event";
export type ChangeAction = "create" | "update" | "delete";

export interface Change {
  id: string;
  at: string;
  tool: string;
  kind: ChangeKind;
  action: ChangeAction;
  /** One line for the UI, e.g. "Added 3 blocks to Q3 Planning". */
  label: string;
  /** Where it happened, when the tool knew: a Notion page id or a calendar name. */
  target?: string;
  /** Deep link, for changes the user can go and look at. */
  url?: string;
  /**
   * What to do to reverse it. Absent means the change cannot be undone, and the UI says so
   * rather than offering a button that fails.
   */
  undo?: UndoStep;
  undone?: boolean;
}

export type UndoStep =
  /** Blocks Oracle created: remove them again. */
  | { type: "delete-blocks"; blockIds: string[] }
  /** A block Oracle rewrote in place: put the old body back. */
  | { type: "restore-block"; blockId: string; block: Record<string, unknown> }
  /** A block Oracle archived: Notion keeps it, so it can come back. */
  | { type: "unarchive-block"; blockId: string }
  /** A page or database entry Oracle created: send it to the trash. */
  | { type: "archive-page"; pageId: string }
  /** Page properties Oracle overwrote: reapply what was there. */
  | { type: "restore-page-properties"; pageId: string; properties: Record<string, unknown> }
  /** A calendar event Oracle created: delete it. */
  | { type: "delete-event"; uid: string; calendar: string }
  /** A calendar event Oracle changed or removed: write the old fields back. */
  | { type: "restore-event"; uid: string; calendar: string; fields: Record<string, unknown> };

/** "3 blocks", "1 block" — used in labels and in the after-a-turn summary. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * One line describing a turn's changes, or null when it changed nothing.
 *
 * Grouped by page so a run that rewrote six blocks on one page reads as one page, not six edits.
 *
 * Where a change did not record which page it was on — deleting a block needs only its id, so
 * nothing looks the page up — the count is left out rather than guessed. This line exists to be
 * more trustworthy than the model's own account of what it did; a page count that is quietly
 * wrong in either direction would defeat that.
 */
export function summarise(changes: Change[]): string | null {
  const live = changes.filter((c) => !c.undone);
  if (!live.length) return null;

  const blocks = live.filter((c) => c.kind === "block");
  const events = live.filter((c) => c.kind === "event");
  const pageChanges = live.filter((c) => c.kind === "page");
  const known = new Set([...blocks, ...pageChanges].map((c) => c.target).filter(Boolean));
  const anyUnknown = [...blocks, ...pageChanges].some((c) => !c.target);

  const parts: string[] = [];
  if (blocks.length) {
    // "across n pages" only when every edit said where it landed; "and elsewhere" when some
    // did not, and no claim at all when none did.
    const where = known.size === 0 ? "" : anyUnknown ? ` across ${plural(known.size, "page")} and elsewhere` : ` across ${plural(known.size, "page")}`;
    parts.push(`${plural(blocks.length, "edit")}${where}`);
  } else if (pageChanges.length) {
    parts.push(known.size && !anyUnknown ? plural(known.size, "page") : plural(pageChanges.length, "page"));
  }
  if (events.length) parts.push(plural(events.length, "calendar event"));
  return parts.length ? `Changed ${parts.join(" and ")}` : null;
}
