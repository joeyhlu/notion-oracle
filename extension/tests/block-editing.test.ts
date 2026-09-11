import { test } from "node:test";
import assert from "node:assert/strict";
import { NotionClient } from "../src/lib/notion.ts";
import { createToolExecutor } from "../src/lib/tools.ts";

const PAGE_ID = "11111111-2222-4333-8444-555555555555";
const BLOCK_ID = "3d8aaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NEW_ID = "99999999-8888-4777-8666-555555555555";

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

const paragraph = (text: string) => ({
  object: "block", id: BLOCK_ID, type: "paragraph", has_children: false,
  parent: { type: "page_id", page_id: PAGE_ID },
  paragraph: { rich_text: [{ type: "text", text: { content: text }, plain_text: text }] },
});

test("rewriting a paragraph as a paragraph patches it in place", async () => {
  const { calls, restore } = stubFetch({
    [`GET /blocks/${BLOCK_ID}`]: () => ({ json: paragraph("before") }),
    [`PATCH /blocks/${BLOCK_ID}`]: () => ({ json: paragraph("after") }),
  });
  try {
    const result = await new NotionClient("t").replaceBlock(BLOCK_ID, [
      { type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "after" } }] } },
    ] as never);
    assert.equal(result.converted, false);
    assert.deepEqual(result.blockIds, [BLOCK_ID]);
    // The block keeps its id and children, so nothing is archived.
    assert.deepEqual(calls.map((c) => c.method), ["GET", "PATCH"]);
  } finally { restore(); }
});

test("turning a paragraph into a to-do replaces the block instead of failing", async () => {
  // Notion's PATCH /blocks/{id} rejects a body whose type differs from the block's own with
  // "Block type mismatch: this block is a `paragraph`". Every attempt to make a checklist out of
  // existing text hit that, and the model fell back to inserting duplicate copies of the content.
  const { calls, restore } = stubFetch({
    [`GET /blocks/${BLOCK_ID}`]: () => ({ json: paragraph("Buy milk") }),
    [`PATCH /blocks/${BLOCK_ID}`]: () => ({
      status: 400,
      json: { code: "validation_error", message: "Block type mismatch: this block is a `paragraph`." },
    }),
    [`PATCH /blocks/${PAGE_ID}/children`]: () => ({ json: { results: [{ object: "block", id: NEW_ID, type: "to_do" }] } }),
    [`DELETE /blocks/${BLOCK_ID}`]: () => ({ json: { object: "block", id: BLOCK_ID, archived: true } }),
  });
  try {
    const result = await new NotionClient("t").replaceBlock(BLOCK_ID, [
      { type: "to_do", to_do: { rich_text: [{ type: "text", text: { content: "Buy milk" } }], checked: false } },
    ] as never);

    assert.equal(result.converted, true);
    assert.equal(result.from, "paragraph");
    assert.equal(result.to, "to_do");
    // The new block is where the old one was, and the old one is archived rather than orphaned.
    assert.deepEqual(result.blockIds, [NEW_ID]);
    const insert = calls.find((c) => c.path.endsWith("/children"));
    assert.equal(insert?.body?.after, BLOCK_ID, "the replacement must land in the original's position");
    assert.ok(calls.some((c) => c.method === "DELETE" && c.path === `/blocks/${BLOCK_ID}`));
    // The failing PATCH is never attempted: the type is compared first.
    assert.equal(calls.filter((c) => c.method === "PATCH" && c.path === `/blocks/${BLOCK_ID}`).length, 0);
  } finally { restore(); }
});

test("update_block reports new ids after a conversion so follow-up edits have a live target", async () => {
  const { restore } = stubFetch({
    [`GET /blocks/${BLOCK_ID}`]: () => ({ json: paragraph("Buy milk") }),
    [`PATCH /blocks/${PAGE_ID}/children`]: () => ({ json: { results: [{ object: "block", id: NEW_ID, type: "to_do" }] } }),
    [`DELETE /blocks/${BLOCK_ID}`]: () => ({ json: { object: "block", id: BLOCK_ID, archived: true } }),
  });
  try {
    const execute = createToolExecutor({
      notion: new NotionClient("t"), currentPageId: PAGE_ID,
      runPageTool: async () => ({ ok: false, content: "n/a" }),
    });
    const result = await execute("update_block", { block_id: BLOCK_ID, markdown: "- [ ] Buy milk" });
    assert.equal(result.ok, true, result.content);
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    assert.equal(payload.converted_from, "paragraph");
    assert.equal(payload.type, "to_do");
    assert.deepEqual(payload.block_ids, [NEW_ID]);
    assert.equal(payload.block_id, undefined, "the archived id must not be handed back as live");
  } finally { restore(); }
});
