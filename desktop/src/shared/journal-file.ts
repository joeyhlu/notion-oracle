/**
 * The journal on disk.
 *
 * JSON Lines because two MCP servers (Notion and calendar) append concurrently and a whole-file
 * rewrite would lose one of their entries. Node-only: the renderer imports journal.ts instead.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Change } from "./journal.ts";

/** Keeps the file from growing without bound; the UI only ever shows the recent tail anyway. */
export const MAX_ENTRIES = 200;

export function newChangeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Appends one entry. Never throws: a journal failure must not fail the user's actual edit. */
export function appendChange(file: string, change: Omit<Change, "id" | "at"> & Partial<Pick<Change, "id" | "at">>): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const entry: Change = { id: change.id ?? newChangeId(), at: change.at ?? new Date().toISOString(), ...change };
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // Losing an undo record is better than losing the edit that produced it.
  }
}

/** Reads the journal newest first, skipping any line a partial write left malformed. */
export function readChanges(file: string): Change[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: Change[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Change;
      if (parsed && typeof parsed.id === "string") out.push(parsed);
    } catch {
      // A line torn by a concurrent append; the rest of the file is still good.
    }
  }
  return out.reverse();
}

/**
 * Rewrites the file with `mutate` applied to every entry, and drops the oldest beyond MAX_ENTRIES.
 *
 * This is the one operation that rewrites rather than appends, so it races with a concurrent tool
 * call. It only ever runs from the main process while no run is in flight — marking an entry
 * undone, or clearing the list — and a lost append there costs an undo record, not data.
 */
export function rewriteChanges(file: string, mutate: (change: Change) => Change | null): void {
  const kept: Change[] = [];
  for (const change of readChanges(file).reverse()) {
    const next = mutate(change);
    if (next) kept.push(next);
  }
  const trimmed = kept.slice(-MAX_ENTRIES);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, trimmed.map((c) => `${JSON.stringify(c)}\n`).join(""));
}
