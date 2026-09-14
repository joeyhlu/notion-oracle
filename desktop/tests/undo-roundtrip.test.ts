import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotionClient } from "../../extension/src/lib/notion.ts";
import { createToolExecutor } from "../../extension/src/lib/tools.ts";
import { appendChange, readChanges } from "../src/shared/journal-file.ts";
import type { UndoStep } from "../src/shared/journal.ts";
import { undoChange } from "../src/main/undo.ts";

/**
 * The whole undo path, end to end: a tool changes something, the change is journalled to a real
 * file, and undoChange reads it back and issues the reversing calls.
 *
 * The unit tests cover each half. What they cannot show is that the two halves agree — that the
 * shape a tool records is the shape the reverser expects, once it has been through JSON. A typo
 * in either would leave a journal full of entries whose Undo button fails.
 */

const PAGE_ID = "11111111-2222-4333-8444-555555555555";
const BLOCK_ID = "3d8aaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
// Real ids, because normalizeId rejects anything that is not one — as it should.
const NEW_1 = "aaaa1111-2222-4333-8444-555555555555";
const NEW_2 = "bbbb1111-2222-4333-8444-555555555555";
const TODO_1 = "cccc1111-2222-4333-8444-555555555555";
const NEW_PAGE = "dddd1111-2222-4333-8444-555555555555";
const GONE = "eeee1111-2222-4333-8444-555555555555";

interface Call { method: string; path: string; body: Record<string, unknown> | null }

function stubFetch(routes: Record<string, (body: Record<string, unknown> | null) => { status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const path = String(url).replace("https://api.notion.com/v1", "");
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method: String(init.method), path, body });
    const route = routes[`${init.method} ${path}`];
    if (!route) return new Response(JSON.stringify({ message: `no stub for ${init.method} ${path}`, code: "object_not_found" }), { status: 404 });
    const res = route(body);
    return new Response(JSON.stringify(res.json), { status: res.status ?? 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const journalFile = () => join(mkdtempSync(join(tmpdir(), "oracle-undo-")), "changes.jsonl");

/** Runs a tool with journalling on, then undoes what it recorded. Returns every HTTP call made. */
async function roundTrip(tool: string, input: Record<string, unknown>, routes: Parameters<typeof stubFetch>[0]) {
  const file = journalFile();
  const { calls, restore } = stubFetch(routes);
  try {
    const notion = new NotionClient("t");
    const execute = createToolExecutor({
      notion, currentPageId: PAGE_ID,
      runPageTool: async () => ({ ok: false, content: "n/a" }),
      recordChange: (change) => appendChange(file, { tool: "notion", ...change, undo: change.undo as UndoStep | undefined }),
    });
    const outcome = await execute(tool, input);
    assert.equal(outcome.ok, true, outcome.content);

    // Straight off disk, so anything JSON cannot carry would be lost by now.
    const recorded = readChanges(file);
    assert.equal(recorded.length, 1, "the tool recorded exactly one change");
    const before = calls.length;
    const result = await undoChange(recorded[0]!, notion);
    return { change: recorded[0]!, result, undoCalls: calls.slice(before) };
  } finally { restore(); }
}

test("appending, then undoing, deletes exactly the blocks that were added", async () => {
  const { result, undoCalls } = await roundTrip("append_to_page", { content_markdown: "one\n\ntwo" }, {
    [`PATCH /blocks/${PAGE_ID}/children`]: () => ({ json: { results: [{ id: NEW_1 }, { id: NEW_2 }] } }),
    [`DELETE /blocks/${NEW_1}`]: () => ({ json: { id: NEW_1, archived: true } }),
    [`DELETE /blocks/${NEW_2}`]: () => ({ json: { id: NEW_2, archived: true } }),
  });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(undoCalls.map((c) => `${c.method} ${c.path}`), [`DELETE /blocks/${NEW_1}`, `DELETE /blocks/${NEW_2}`]);
});

test("rewriting, then undoing, puts the original body back verbatim", async () => {
  const body = { rich_text: [{ type: "text", text: { content: "old wording" }, plain_text: "old wording" }] };
  const { result, undoCalls } = await roundTrip("update_block", { block_id: BLOCK_ID, markdown: "new wording" }, {
    [`GET /blocks/${BLOCK_ID}`]: () => ({ json: { object: "block", id: BLOCK_ID, type: "paragraph", parent: { page_id: PAGE_ID }, paragraph: body } }),
    [`PATCH /blocks/${BLOCK_ID}`]: () => ({ json: { object: "block", id: BLOCK_ID, type: "paragraph" } }),
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(undoCalls.length, 1);
  // The exact body, not a re-derivation of it: Notion keeps no version to fall back on.
  assert.deepEqual(undoCalls[0]!.body, { type: "paragraph", paragraph: body });
});

test("converting a block, then undoing, removes the replacement and revives the original", async () => {
  const { result, undoCalls } = await roundTrip("update_block", { block_id: BLOCK_ID, markdown: "- [ ] task" }, {
    [`GET /blocks/${BLOCK_ID}`]: () => ({ json: { object: "block", id: BLOCK_ID, type: "paragraph", parent: { page_id: PAGE_ID }, paragraph: { rich_text: [] } } }),
    [`PATCH /blocks/${PAGE_ID}/children`]: () => ({ json: { results: [{ id: TODO_1 }] } }),
    [`DELETE /blocks/${BLOCK_ID}`]: () => ({ json: { archived: true } }),
    [`DELETE /blocks/${TODO_1}`]: () => ({ json: { archived: true } }),
    [`PATCH /blocks/${BLOCK_ID}`]: () => ({ json: { id: BLOCK_ID, archived: false } }),
  });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(undoCalls.map((c) => `${c.method} ${c.path}`), [`DELETE /blocks/${TODO_1}`, `PATCH /blocks/${BLOCK_ID}`]);
  // Order matters: the original must come back, and it must come back un-archived.
  assert.deepEqual(undoCalls[1]!.body, { archived: false });
});

test("deleting, then undoing, unarchives the block", async () => {
  const { result, undoCalls } = await roundTrip("delete_block", { block_id: BLOCK_ID }, {
    [`DELETE /blocks/${BLOCK_ID}`]: () => ({ json: { archived: true } }),
    [`PATCH /blocks/${BLOCK_ID}`]: () => ({ json: { id: BLOCK_ID, archived: false } }),
  });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(undoCalls.map((c) => `${c.method} ${c.path}`), [`PATCH /blocks/${BLOCK_ID}`]);
  assert.deepEqual(undoCalls[0]!.body, { archived: false });
});

test("creating a page, then undoing, sends it to the trash", async () => {
  const { result, undoCalls } = await roundTrip("create_page", { title: "Scratch", parent_page_id: PAGE_ID }, {
    "POST /pages": () => ({ json: { object: "page", id: NEW_PAGE, url: "https://notion.so/new-page", properties: {} } }),
    [`PATCH /pages/${NEW_PAGE}`]: () => ({ json: { object: "page", id: NEW_PAGE, archived: true } }),
  });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(undoCalls.map((c) => `${c.method} ${c.path}`), [`PATCH /pages/${NEW_PAGE}`]);
  assert.deepEqual(undoCalls[0]!.body, { archived: true });
});

test("changing a property, then undoing, restores only that property", async () => {
  const props = {
    Status: { id: "s", type: "select", select: { name: "Todo" } },
    Owner: { id: "o", type: "rich_text", rich_text: [{ type: "text", text: { content: "Joey" }, plain_text: "Joey" }] },
  };
  const { result, undoCalls } = await roundTrip("update_page", { page_id: PAGE_ID, values: { Status: "Done" } }, {
    [`GET /pages/${PAGE_ID}`]: () => ({ json: { object: "page", id: PAGE_ID, url: "u", parent: { type: "page_id", page_id: "x" }, properties: props } }),
    [`PATCH /pages/${PAGE_ID}`]: () => ({ json: { object: "page", id: PAGE_ID, url: "u", properties: props } }),
  });
  assert.equal(result.ok, true, result.message);
  const restored = (undoCalls[0]!.body as { properties: Record<string, unknown> }).properties;
  assert.deepEqual(Object.keys(restored), ["Status"], "an edit made by hand to Owner in between must survive");
  assert.deepEqual(restored.Status, props.Status);
});

test("a change with nothing recorded to reverse says so instead of failing loudly", async () => {
  const file = journalFile();
  appendChange(file, { tool: "notion", kind: "block", action: "update", label: "Something odd" });
  const result = await undoChange(readChanges(file)[0]!, new NotionClient("t"));
  assert.equal(result.ok, false);
  assert.match(result.message, /not recorded in a way that can be reversed/);
});

test("undoing a Notion change with no token explains itself rather than throwing", async () => {
  const file = journalFile();
  appendChange(file, { tool: "notion", kind: "block", action: "create", label: "Added blocks", undo: { type: "delete-blocks", blockIds: [NEW_1] } });
  const result = await undoChange(readChanges(file)[0]!, null);
  assert.equal(result.ok, false);
  assert.match(result.message, /integration secret/);
});

test("an already-deleted block does not strand the rest of the undo", async () => {
  // Half-applied undo is the worst outcome: the user cannot tell what state the page is in.
  const file = journalFile();
  appendChange(file, { tool: "notion", kind: "block", action: "create", label: "Added 2 blocks", undo: { type: "delete-blocks", blockIds: [GONE, NEW_1] } });
  const { restore } = stubFetch({
    [`DELETE /blocks/${GONE}`]: () => ({ status: 404, json: { message: "Could not find block", code: "object_not_found" } }),
    [`DELETE /blocks/${NEW_1}`]: () => ({ json: { archived: true } }),
  });
  try {
    const result = await undoChange(readChanges(file)[0]!, new NotionClient("t"));
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /1 of 2/);
  } finally { restore(); }
});
