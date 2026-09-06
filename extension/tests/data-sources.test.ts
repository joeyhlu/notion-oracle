import { test } from "node:test";
import assert from "node:assert/strict";
import { NotionClient } from "../src/lib/notion.ts";
import { createToolExecutor } from "../src/lib/tools.ts";

const DB_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const DS_ID = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const DS2_ID = "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f";

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  version: string | null;
}

/** Stub global fetch and record every request the client makes. */
function stubFetch(routes: Record<string, (body: Record<string, unknown> | null) => { status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const path = String(url).replace("https://api.notion.com/v1", "");
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const version = new Headers(init.headers).get("Notion-Version");
    calls.push({ method: String(init.method), path, body, version });
    const key = `${init.method} ${path}`;
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ message: `no stub for ${key}`, code: "object_not_found" }), { status: 404 });
    const res = route(body);
    return new Response(JSON.stringify(res.json), { status: res.status ?? 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const SCHEMA = { Name: { id: "t", name: "Name", type: "title" }, Date: { id: "d", name: "Date", type: "date" } };

test("resolves a multi-data-source database to its first data source", async () => {
  const { calls, restore } = stubFetch({
    [`GET /databases/${DB_ID}`]: () => ({ json: { object: "database", id: DB_ID, url: "https://notion.so/db", title: [{ type: "text", text: { content: "Tasks" }, plain_text: "Tasks" }], data_sources: [{ id: DS_ID, name: "Tasks" }, { id: DS2_ID, name: "Archive" }] } }),
    [`GET /data_sources/${DS_ID}`]: () => ({ json: { object: "data_source", id: DS_ID, name: "Tasks", properties: SCHEMA } }),
  });
  try {
    const resolved = await new NotionClient("t").resolveDataSource(DB_ID);
    assert.equal(resolved.dataSourceId, DS_ID);
    assert.equal(resolved.databaseId, DB_ID);
    assert.equal(resolved.available.length, 2);
    assert.deepEqual(Object.keys(resolved.properties), ["Name", "Date"]);
    assert.equal(calls[0]?.version, "2025-09-03");
  } finally {
    restore();
  }
});

test("accepts a data source id directly when it is not a database", async () => {
  const { restore } = stubFetch({
    [`GET /databases/${DS_ID}`]: () => ({ status: 404, json: { message: "Could not find database", code: "object_not_found" } }),
    [`GET /data_sources/${DS_ID}`]: () => ({ json: { object: "data_source", id: DS_ID, name: "Calendar", database_parent: { database_id: DB_ID }, properties: SCHEMA } }),
  });
  try {
    const resolved = await new NotionClient("t").resolveDataSource(DS_ID);
    assert.equal(resolved.dataSourceId, DS_ID);
    assert.equal(resolved.databaseId, DB_ID);
    assert.equal(resolved.title, "Calendar");
  } finally {
    restore();
  }
});

test("create_database_entry parents the page on the data source, not the database", async () => {
  const { calls, restore } = stubFetch({
    [`GET /databases/${DB_ID}`]: () => ({ json: { object: "database", id: DB_ID, url: "u", title: [], data_sources: [{ id: DS_ID, name: "Calendar" }] } }),
    [`GET /data_sources/${DS_ID}`]: () => ({ json: { object: "data_source", id: DS_ID, name: "Calendar", properties: SCHEMA } }),
    "POST /pages": (body) => ({ json: { object: "page", id: "new-page", url: "https://notion.so/new", parent: body?.parent, properties: {} } }),
  });
  try {
    const execute = createToolExecutor({ notion: new NotionClient("t"), currentPageId: null, runPageTool: async () => ({ ok: false, content: "n/a" }) });
    const outcome = await execute("create_database_entry", { database_id: DB_ID, values: { Name: "Dentist", Date: "2026-09-12T14:00:00" } });
    assert.equal(outcome.ok, true, outcome.content);
    const create = calls.find((c) => c.path === "/pages");
    assert.deepEqual(create?.body?.parent, { type: "data_source_id", data_source_id: DS_ID });
    const props = create?.body?.properties as Record<string, unknown>;
    assert.deepEqual(props.Date, { date: { start: "2026-09-12T14:00:00" } });
  } finally {
    restore();
  }
});

test("query_database queries the data source endpoint", async () => {
  const { calls, restore } = stubFetch({
    [`GET /databases/${DB_ID}`]: () => ({ json: { object: "database", id: DB_ID, url: "u", title: [], data_sources: [{ id: DS_ID, name: "Tasks" }] } }),
    [`GET /data_sources/${DS_ID}`]: () => ({ json: { object: "data_source", id: DS_ID, name: "Tasks", properties: SCHEMA } }),
    [`POST /data_sources/${DS_ID}/query`]: () => ({ json: { results: [{ object: "page", id: "p1", url: "u", properties: {} }], has_more: false, next_cursor: null } }),
  });
  try {
    const execute = createToolExecutor({ notion: new NotionClient("t"), currentPageId: null, runPageTool: async () => ({ ok: false, content: "n/a" }) });
    const outcome = await execute("query_database", { database_id: DB_ID });
    assert.equal(outcome.ok, true, outcome.content);
    assert.ok(calls.some((c) => c.path === `/data_sources/${DS_ID}/query`));
    assert.ok(!calls.some((c) => c.path.includes("/databases/") && c.path.endsWith("/query")));
  } finally {
    restore();
  }
});

test("search filters on data_source, and reports multi-source databases", async () => {
  const { calls, restore } = stubFetch({
    "POST /search": () => ({ json: { results: [{ object: "data_source", id: DS_ID, name: "Calendar", url: "https://notion.so/cal", database_parent: { database_id: DB_ID } }], has_more: false, next_cursor: null } }),
  });
  try {
    const execute = createToolExecutor({ notion: new NotionClient("t"), currentPageId: null, runPageTool: async () => ({ ok: false, content: "n/a" }) });
    const outcome = await execute("search_notion", { query: "calendar", object_type: "database" });
    assert.equal(outcome.ok, true);
    assert.deepEqual(calls[0]?.body?.filter, { property: "object", value: "data_source" });
    const parsed = JSON.parse(outcome.content) as Array<{ object: string; id: string; title: string }>;
    assert.equal(parsed[0]?.id, DS_ID);
    assert.equal(parsed[0]?.title, "Calendar");
  } finally {
    restore();
  }
});

test("an empty search lists what the integration can actually see", async () => {
  let call = 0;
  const { calls, restore } = stubFetch({
    "POST /search": (body) => {
      call++;
      // First call is the model's filtered query; second is the fallback listing.
      if (body?.filter) return { json: { results: [], has_more: false, next_cursor: null } };
      return { json: { results: [{ object: "data_source", id: DS_ID, name: "Habit Tracker", url: "u" }, { object: "page", id: "p1", url: "u2", properties: {} }], has_more: false, next_cursor: null } };
    },
  });
  try {
    const execute = createToolExecutor({ notion: new NotionClient("t"), currentPageId: null, runPageTool: async () => ({ ok: false, content: "n/a" }) });
    const outcome = await execute("search_notion", { query: "calendar", object_type: "database" });
    assert.equal(outcome.ok, true);
    const parsed = JSON.parse(outcome.content) as { results: unknown[]; note: string; visible: Array<{ title: string }> };
    assert.deepEqual(parsed.results, []);
    assert.match(parsed.note, /not been shared/);
    assert.deepEqual(parsed.visible.map((v) => v.title), ["Habit Tracker", "Untitled"]);
    assert.equal(call, 2);
    assert.equal(calls[1]?.body?.query, "");
  } finally {
    restore();
  }
});

test("reports plainly when the integration can see nothing at all", async () => {
  const { restore } = stubFetch({
    "POST /search": () => ({ json: { results: [], has_more: false, next_cursor: null } }),
  });
  try {
    const execute = createToolExecutor({ notion: new NotionClient("t"), currentPageId: null, runPageTool: async () => ({ ok: false, content: "n/a" }) });
    const outcome = await execute("search_notion", { query: "calendar" });
    assert.equal(outcome.ok, true);
    assert.match(outcome.content, /cannot see anything in the workspace at all/);
    assert.match(outcome.content, /Connections/);
  } finally {
    restore();
  }
});
