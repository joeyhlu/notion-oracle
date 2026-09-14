import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ENTRIES, appendChange, readChanges, rewriteChanges } from "../src/shared/journal-file.ts";
import { summarise, type Change } from "../src/shared/journal.ts";

const scratch = () => join(mkdtempSync(join(tmpdir(), "oracle-journal-")), "changes.jsonl");

const entry = (over: Partial<Change> = {}): Omit<Change, "id" | "at"> => ({
  tool: "notion", kind: "block", action: "create", label: "Appended 2 blocks",
  undo: { type: "delete-blocks", blockIds: ["a", "b"] }, ...over,
} as Omit<Change, "id" | "at">);

test("entries come back newest first with an id and a timestamp", () => {
  const file = scratch();
  appendChange(file, entry({ label: "first" }));
  appendChange(file, entry({ label: "second" }));
  const changes = readChanges(file);
  assert.deepEqual(changes.map((c) => c.label), ["second", "first"]);
  for (const c of changes) {
    assert.match(c.id, /^[a-z0-9]+-[a-z0-9]+$/);
    assert.ok(!Number.isNaN(Date.parse(c.at)));
  }
});

test("the directory is created on demand", () => {
  const file = join(mkdtempSync(join(tmpdir(), "oracle-journal-")), "nested", "deep", "changes.jsonl");
  appendChange(file, entry());
  assert.equal(readChanges(file).length, 1);
});

test("a missing journal reads as empty rather than throwing", () => {
  assert.deepEqual(readChanges(join(tmpdir(), "definitely-not-here", "changes.jsonl")), []);
});

test("a torn line is skipped and the rest of the file survives", () => {
  // Two MCP servers append concurrently; a partial write must not take the history with it.
  const file = scratch();
  appendChange(file, entry({ label: "before" }));
  appendFileSync(file, '{"id":"broken","at":"2026-01\n');
  appendChange(file, entry({ label: "after" }));
  assert.deepEqual(readChanges(file).map((c) => c.label), ["after", "before"]);
});

test("journalling never throws, whatever the filesystem says", () => {
  // A directory where the file should be: appending must fail silently rather than fail the edit.
  const dir = mkdtempSync(join(tmpdir(), "oracle-journal-"));
  assert.doesNotThrow(() => appendChange(dir, entry()));
});

test("marking one entry undone leaves the others alone", () => {
  const file = scratch();
  appendChange(file, entry({ label: "one" }));
  appendChange(file, entry({ label: "two" }));
  const target = readChanges(file).find((c) => c.label === "one")!;
  rewriteChanges(file, (c) => (c.id === target.id ? { ...c, undone: true } : c));
  const after = readChanges(file);
  assert.equal(after.find((c) => c.label === "one")?.undone, true);
  assert.equal(after.find((c) => c.label === "two")?.undone, undefined);
  assert.equal(after.length, 2, "order and count are preserved");
});

test("the journal is trimmed on rewrite so it cannot grow forever", () => {
  const file = scratch();
  for (let i = 0; i < MAX_ENTRIES + 25; i++) appendChange(file, entry({ label: `n${i}` }));
  rewriteChanges(file, (c) => c);
  const kept = readChanges(file);
  assert.equal(kept.length, MAX_ENTRIES);
  // The oldest go, not the newest.
  assert.equal(kept[0]?.label, `n${MAX_ENTRIES + 24}`);
});

test("summarise groups a turn's edits by page instead of counting them one by one", () => {
  const base = { id: "x", at: "", tool: "notion", action: "update" } as const;
  const line = summarise([
    { ...base, kind: "block", label: "", target: "page-1" },
    { ...base, kind: "block", label: "", target: "page-1" },
    { ...base, kind: "block", label: "", target: "page-2" },
    { ...base, kind: "event", label: "", target: "Work" },
  ]);
  assert.equal(line, "Changed 3 edits across 2 pages and 1 calendar event");
});

test("summarise ignores changes that were undone, and says nothing when there are none", () => {
  const base = { id: "x", at: "", tool: "notion", action: "create", kind: "block", label: "", target: "p" } as const;
  assert.equal(summarise([]), null);
  assert.equal(summarise([{ ...base, undone: true }]), null);
  assert.equal(summarise([{ ...base }]), "Changed 1 edit across 1 page");
});
