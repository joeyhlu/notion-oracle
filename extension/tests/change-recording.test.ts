import { test } from "node:test";
import assert from "node:assert/strict";
import { NotionClient } from "../src/lib/notion.ts";
import { createToolExecutor, type RecordedChange } from "../src/lib/tools.ts";

const PAGE_ID = "11111111-2222-4333-8444-555555555555";
const BLOCK_ID = "3d8aaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function stubFetch(routes: Record<string, (body: Record<string, unknown> | null) => { status?: number; json: unknown }>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const path = String(url).replace("https://api.notion.com/v1", "");
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const route = routes[`${init.method} ${path}`];
    if (!route) return new Response(JSON.stringify({ message: `no stub for ${init.method} ${path}`, code: "object_not_found" }), { status: 404 });
    const res = route(body);
    return new Response(JSON.stringify(res.json), { status: res.status ?? 200 });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; } };
}

function executorWithLog(routes: Parameters<typeof stubFetch>[0]) {
  const recorded: RecordedChange[] = [];
  const { restore } = stubFetch(routes);
  const execute = createToolExecutor({
    notion: new NotionClient("t"), currentPageId: PAGE_ID,
    runPageTool: async () => ({ ok: false, content: "n/a" }),
    recordChange: (c) => recorded.push(c),
  });
  return { execute, recorded, restore };
}

test("appending records the ids it created, so undo can remove exactly those", async () => {
  const { execute, recorded, restore } = executorWithLog({
    [`PATCH /blocks/${PAGE_ID}/children`]: () => ({ json: { results: [{ id: "new-1" }, { id: "new-2" }] } }),
  });
  try {
    assert.equal((await execute("append_to_page", { content_markdown: "one\n\ntwo" })).ok, true);
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0]?.undo, { type: "delete-blocks", blockIds: ["new-1", "new-2"] });
    assert.equal(recorded[0]?.target, PAGE_ID);
  } finally { restore(); }
});

test("an in-place rewrite records the text it overwrote", async () => {
  // Without capturing the old body there is nothing to put back: Notion keeps no version of it.
  const before = { rich_text: [{ type: "text", text: { content: "old wording" }, plain_text: "old wording" }] };
  const { execute, recorded, restore } = executorWithLog({
    [`GET /blocks/${BLOCK_ID}`]: () => ({ json: { object: "block", id: BLOCK_ID, type: "paragraph", parent: { page_id: PAGE_ID }, paragraph: before } }),
    [`PATCH /blocks/${BLOCK_ID}`]: () => ({ json: { object: "block", id: BLOCK_ID, type: "paragraph" } }),
  });
  try {
    assert.equal((await execute("update_block", { block_id: BLOCK_ID, markdown: "new wording" })).ok, true);
    assert.deepEqual(recorded[0]?.undo, { type: "restore-block", blockId: BLOCK_ID, block: { type: "paragraph", paragraph: before } });
  } finally { restore(); }
});

test("a type conversion undoes to removing the replacement and reviving the original", async () => {
  const { execute, recorded, restore } = executorWithLog({
    [`GET /blocks/${BLOCK_ID}`]: () => ({ json: { object: "block", id: BLOCK_ID, type: "paragraph", parent: { page_id: PAGE_ID }, paragraph: { rich_text: [] } } }),
    [`PATCH /blocks/${PAGE_ID}/children`]: () => ({ json: { results: [{ id: "todo-1" }] } }),
    [`DELETE /blocks/${BLOCK_ID}`]: () => ({ json: { id: BLOCK_ID, archived: true } }),
  });
  try {
    assert.equal((await execute("update_block", { block_id: BLOCK_ID, markdown: "- [ ] task" })).ok, true);
    assert.deepEqual(recorded[0]?.undo, { type: "delete-blocks", blockIds: ["todo-1"], thenUnarchive: BLOCK_ID });
  } finally { restore(); }
});

test("deleting records how to bring the block back", async () => {
  const { execute, recorded, restore } = executorWithLog({
    [`DELETE /blocks/${BLOCK_ID}`]: () => ({ json: { id: BLOCK_ID, archived: true } }),
  });
  try {
    await execute("delete_block", { block_id: BLOCK_ID });
    assert.deepEqual(recorded[0]?.undo, { type: "unarchive-block", blockId: BLOCK_ID });
  } finally { restore(); }
});

test("a property update records only the properties it overwrote", async () => {
  // Restoring the whole property bag would revert edits the user made by hand in between.
  const props = {
    Status: { id: "s", type: "select", select: { name: "Todo" } },
    Owner: { id: "o", type: "rich_text", rich_text: [] },
  };
  const { execute, recorded, restore } = executorWithLog({
    [`GET /pages/${PAGE_ID}`]: () => ({ json: { object: "page", id: PAGE_ID, url: "u", parent: { type: "page_id", page_id: "x" }, properties: props } }),
    [`PATCH /pages/${PAGE_ID}`]: () => ({ json: { object: "page", id: PAGE_ID, url: "u", properties: props } }),
  });
  try {
    assert.equal((await execute("update_page", { page_id: PAGE_ID, values: { Status: "Done" } })).ok, true);
    const undo = recorded[0]?.undo as { type: string; properties: Record<string, unknown> };
    assert.equal(undo.type, "restore-page-properties");
    assert.deepEqual(Object.keys(undo.properties), ["Status"], "Owner was not touched, so it is not restored");
  } finally { restore(); }
});

test("reads record nothing", async () => {
  const { execute, recorded, restore } = executorWithLog({
    [`GET /blocks/${PAGE_ID}/children?page_size=100`]: () => ({ json: { results: [] } }),
  });
  try {
    await execute("read_page_blocks", { page_id: PAGE_ID });
    assert.deepEqual(recorded, []);
  } finally { restore(); }
});
