import { test } from "node:test";
import assert from "node:assert/strict";
import { NotionClient, isEmptyProperty, scoreText } from "../src/lib/notion.ts";
import { BULK_EDIT_TOOLS, CONTENT_SEARCH_TOOLS, NOTION_API_TOOLS, createToolExecutor, notionTools, type RecordedChange } from "../src/lib/tools.ts";

const DB_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const DS_ID = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const ROW_1 = "aaaa1111-2222-4333-8444-555555555555";
const ROW_2 = "bbbb1111-2222-4333-8444-555555555555";

function stubFetch(routes: Record<string, (body: Record<string, unknown> | null) => { status?: number; json: unknown }>) {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
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

// ---------- gating ----------

test("the optional tools are absent until turned on", () => {
  const base = notionTools().map((t) => t.name);
  assert.deepEqual(base, NOTION_API_TOOLS.map((t) => t.name));
  assert.ok(!base.includes("search_page_contents"));
  assert.ok(!base.includes("set_database_rows"));
});

test("each switch adds only its own group", () => {
  const search = notionTools({ contentSearch: true }).map((t) => t.name);
  assert.ok(search.includes("search_page_contents"));
  assert.ok(!search.includes("read_database_rows"));

  const bulk = notionTools({ bulkEdit: true }).map((t) => t.name);
  assert.ok(bulk.includes("read_database_rows") && bulk.includes("set_database_rows"));
  assert.ok(!bulk.includes("search_page_contents"));

  const both = notionTools({ contentSearch: true, bulkEdit: true });
  assert.equal(both.length, NOTION_API_TOOLS.length + CONTENT_SEARCH_TOOLS.length + BULK_EDIT_TOOLS.length);
  assert.ok(both.every((t) => t.input_schema), "every optional tool carries a schema too");
});

// ---------- scoring ----------

test("a page matching more of the query outranks one repeating a single word", () => {
  const both = scoreText("The budget for the retreat is fixed.", "Planning", ["budget", "retreat"]);
  const one = scoreText("budget budget budget budget", "Planning", ["budget", "retreat"]);
  assert.equal(both?.termsMatched, 2);
  assert.equal(one?.termsMatched, 1);
  assert.ok(one!.hits > both!.hits, "the repetitive page wins on raw hits, which is why terms rank first");
});

test("the title counts as content", () => {
  // A page called "Budget" answers "budget" even if the body never repeats the word.
  assert.ok(scoreText("Numbers are attached.", "Budget", ["budget"]));
});

test("a page with none of the terms is not a match at all", () => {
  assert.equal(scoreText("Nothing relevant here.", "Notes", ["budget"]), null);
});

test("excerpts are the matching lines, capped and trimmed", () => {
  const text = ["irrelevant", "  the budget is £400  ", "also irrelevant", "budget again", "budget third", "budget fourth"].join("\n");
  const scored = scoreText(text, "Notes", ["budget"])!;
  assert.equal(scored.excerpts.length, 3, "at most three, so one page cannot flood the answer");
  assert.equal(scored.excerpts[0], "the budget is £400");
  const long = scoreText(`budget ${"x".repeat(400)}`, "Notes", ["budget"])!;
  assert.ok(long.excerpts[0]!.length <= 241 && long.excerpts[0]!.endsWith("…"));
});

// ---------- empty-property detection ----------

test("an empty property is recognised across the shapes Notion uses", () => {
  // This is what stops a second fill pass redoing rows that are already done.
  assert.equal(isEmptyProperty(undefined), true);
  assert.equal(isEmptyProperty({ type: "rich_text", rich_text: [] }), true);
  assert.equal(isEmptyProperty({ type: "select", select: null }), true);
  assert.equal(isEmptyProperty({ type: "url", url: "" }), true);
  assert.equal(isEmptyProperty({ type: "url", url: "   " }), true);
  assert.equal(isEmptyProperty({ type: "select", select: { name: "Done" } }), false);
  assert.equal(isEmptyProperty({ type: "rich_text", rich_text: [{ plain_text: "x" }] }), false);
  assert.equal(isEmptyProperty({ type: "checkbox", checkbox: false }), false, "false is a value, not an absence");
});

// ---------- content search, end to end ----------

test("content search reads pages and returns the lines that matched", async () => {
  const page = (id: string, title: string) => ({
    object: "page", id, url: `https://notion.so/${id}`,
    properties: { Name: { id: "t", type: "title", title: [{ type: "text", text: { content: title }, plain_text: title }] } },
  });
  const blocks = (text: string) => ({ results: [{ object: "block", id: "b", type: "paragraph", has_children: false, paragraph: { rich_text: [{ type: "text", text: { content: text }, plain_text: text }] } }] });
  const { calls, restore } = stubFetch({
    "POST /search": () => ({ json: { results: [page(ROW_1, "Q3 Planning"), page(ROW_2, "Recipes")] } }),
    [`GET /blocks/${ROW_1}/children?page_size=100`]: () => ({ json: blocks("We settled the budget at 400.") }),
    [`GET /blocks/${ROW_2}/children?page_size=100`]: () => ({ json: blocks("Three eggs and butter.") }),
  });
  try {
    const execute = createToolExecutor({ notion: new NotionClient("t"), currentPageId: null, runPageTool: async () => ({ ok: false, content: "n/a" }) });
    const outcome = await execute("search_page_contents", { query: "budget" });
    assert.equal(outcome.ok, true, outcome.content);
    const payload = JSON.parse(outcome.content) as { matches: Array<{ title: string; excerpts: string[] }> };
    assert.equal(payload.matches.length, 1, "the recipe page is not a match");
    assert.equal(payload.matches[0]?.title, "Q3 Planning");
    assert.match(payload.matches[0]!.excerpts[0]!, /settled the budget/);
    assert.ok(calls.some((c) => c.path.includes(`${ROW_2}/children`)), "every candidate is read, not only the first");
  } finally { restore(); }
});

test("finding nothing says how far it looked instead of closing the question", async () => {
  const { restore } = stubFetch({ "POST /search": () => ({ json: { results: [] } }) });
  try {
    const execute = createToolExecutor({ notion: new NotionClient("t"), currentPageId: null, runPageTool: async () => ({ ok: false, content: "n/a" }) });
    const outcome = await execute("search_page_contents", { query: "budget", scan: 40 });
    assert.equal(outcome.ok, true);
    assert.match(outcome.content, /40 most recently edited/);
    assert.match(outcome.content, /shared with the Oracle integration/);
  } finally { restore(); }
});

test("an unreadable page does not sink the whole search", async () => {
  const page = (id: string, title: string) => ({
    object: "page", id, url: "u",
    properties: { Name: { id: "t", type: "title", title: [{ type: "text", text: { content: title }, plain_text: title }] } },
  });
  const { restore } = stubFetch({
    "POST /search": () => ({ json: { results: [page(ROW_1, "Locked"), page(ROW_2, "Budget notes")] } }),
    [`GET /blocks/${ROW_1}/children?page_size=100`]: () => ({ status: 403, json: { message: "no access", code: "restricted_resource" } }),
    [`GET /blocks/${ROW_2}/children?page_size=100`]: () => ({ json: { results: [] } }),
  });
  try {
    const execute = createToolExecutor({ notion: new NotionClient("t"), currentPageId: null, runPageTool: async () => ({ ok: false, content: "n/a" }) });
    const outcome = await execute("search_page_contents", { query: "budget" });
    assert.equal(outcome.ok, true, outcome.content);
    assert.match(outcome.content, /Budget notes/, "the readable page still matched on its title");
  } finally { restore(); }
});

// ---------- bulk edits ----------

const SCHEMA = {
  Name: { id: "t", name: "Name", type: "title" },
  Summary: { id: "s", name: "Summary", type: "rich_text" },
};

function databaseRoutes(rows: Array<Record<string, unknown>>) {
  return {
    [`GET /databases/${DB_ID}`]: () => ({ json: { object: "database", id: DB_ID, url: "u", title: [{ type: "text", text: { content: "Notes" }, plain_text: "Notes" }], data_sources: [{ id: DS_ID, name: "Notes" }] } }),
    [`GET /data_sources/${DS_ID}`]: () => ({ json: { object: "data_source", id: DS_ID, name: "Notes", properties: SCHEMA } }),
    [`POST /data_sources/${DS_ID}/query`]: () => ({ json: { results: rows } }),
  };
}

const row = (id: string, title: string, summary: unknown[] = []) => ({
  object: "page", id, url: `https://notion.so/${id}`,
  properties: {
    Name: { id: "t", type: "title", title: [{ type: "text", text: { content: title }, plain_text: title }] },
    Summary: { id: "s", type: "rich_text", rich_text: summary },
  },
});

test("reading rows skips the ones already filled in when asked", async () => {
  const { restore } = stubFetch({
    ...databaseRoutes([row(ROW_1, "Empty one"), row(ROW_2, "Done one", [{ plain_text: "already summarised" }])]),
    [`GET /blocks/${ROW_1}/children?page_size=100`]: () => ({ json: { results: [] } }),
  });
  try {
    const execute = createToolExecutor({ notion: new NotionClient("t"), currentPageId: null, runPageTool: async () => ({ ok: false, content: "n/a" }) });
    const outcome = await execute("read_database_rows", { database_id: DB_ID, only_empty_property: "Summary" });
    assert.equal(outcome.ok, true, outcome.content);
    const payload = JSON.parse(outcome.content) as { rows: Array<{ title: string }>; properties: Record<string, string> };
    assert.deepEqual(payload.rows.map((r) => r.title), ["Empty one"]);
    assert.equal(payload.properties.Summary, "rich_text", "the property types come back, so values can be coerced");
  } finally { restore(); }
});

test("a bulk write records each row separately, so one value can be undone alone", async () => {
  const recorded: RecordedChange[] = [];
  const { calls, restore } = stubFetch({
    ...databaseRoutes([]),
    [`GET /pages/${ROW_1}`]: () => ({ json: row(ROW_1, "First") }),
    [`GET /pages/${ROW_2}`]: () => ({ json: row(ROW_2, "Second") }),
    [`PATCH /pages/${ROW_1}`]: () => ({ json: row(ROW_1, "First") }),
    [`PATCH /pages/${ROW_2}`]: () => ({ json: row(ROW_2, "Second") }),
  });
  try {
    const execute = createToolExecutor({
      notion: new NotionClient("t"), currentPageId: null,
      runPageTool: async () => ({ ok: false, content: "n/a" }),
      recordChange: (c) => recorded.push(c),
    });
    const outcome = await execute("set_database_rows", {
      database_id: DB_ID, property: "Summary",
      updates: [{ page_id: ROW_1, value: "one" }, { page_id: ROW_2, value: "two" }],
    });
    assert.equal(outcome.ok, true, outcome.content);
    assert.equal(JSON.parse(outcome.content).updated, 2);
    assert.equal(recorded.length, 2, "one journal entry per row, not one for the pass");
    assert.equal((recorded[0]?.undo as { type: string }).type, "restore-page-properties");
    // The value written went through the property's real type, not as a raw string.
    const patch = calls.find((c) => c.method === "PATCH" && c.path === `/pages/${ROW_1}`);
    assert.ok((patch?.body as { properties: { Summary: { rich_text: unknown[] } } }).properties.Summary.rich_text.length);
  } finally { restore(); }
});

test("one bad row does not abandon the rest half-written", async () => {
  const { restore } = stubFetch({
    ...databaseRoutes([]),
    [`GET /pages/${ROW_1}`]: () => ({ status: 404, json: { message: "gone", code: "object_not_found" } }),
    [`GET /pages/${ROW_2}`]: () => ({ json: row(ROW_2, "Second") }),
    [`PATCH /pages/${ROW_2}`]: () => ({ json: row(ROW_2, "Second") }),
  });
  try {
    const execute = createToolExecutor({ notion: new NotionClient("t"), currentPageId: null, runPageTool: async () => ({ ok: false, content: "n/a" }) });
    const outcome = await execute("set_database_rows", {
      database_id: DB_ID, property: "Summary",
      updates: [{ page_id: ROW_1, value: "one" }, { page_id: ROW_2, value: "two" }],
    });
    assert.equal(outcome.ok, true, outcome.content);
    const payload = JSON.parse(outcome.content) as { updated: number; failed: Array<{ page_id: string }> };
    assert.equal(payload.updated, 1);
    assert.deepEqual(payload.failed.map((f) => f.page_id), [ROW_1], "the failure is reported, not swallowed");
  } finally { restore(); }
});

test("writing a property the database does not have is refused with the real names", async () => {
  const { restore } = stubFetch(databaseRoutes([]));
  try {
    const execute = createToolExecutor({ notion: new NotionClient("t"), currentPageId: null, runPageTool: async () => ({ ok: false, content: "n/a" }) });
    const outcome = await execute("set_database_rows", { database_id: DB_ID, property: "Nope", updates: [{ page_id: ROW_1, value: "x" }] });
    assert.equal(outcome.ok, false);
    assert.match(outcome.content, /It has: Name, Summary/);
  } finally { restore(); }
});
