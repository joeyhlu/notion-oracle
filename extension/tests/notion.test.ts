import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceProperties, normalizeId } from "../src/lib/notion.ts";

test("normalizeId accepts raw ids, dashed ids and URLs", () => {
  const dashed = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  assert.equal(normalizeId(dashed), dashed);
  assert.equal(normalizeId("1a2b3c4d5e6f4a7b8c9d0e1f2a3b4c5d"), dashed);
  assert.equal(normalizeId("https://www.notion.so/team/My-Page-1a2b3c4d5e6f4a7b8c9d0e1f2a3b4c5d?pvs=4"), dashed);
  assert.throws(() => normalizeId("nope"));
});

const schema = {
  Name: { id: "title", name: "Name", type: "title" },
  Date: { id: "d", name: "Date", type: "date" },
  Tags: { id: "t", name: "Tags", type: "multi_select" },
  Done: { id: "c", name: "Done", type: "checkbox" },
  Status: { id: "s", name: "Status", type: "status" },
};

test("coerceProperties builds Notion payloads from plain values", () => {
  const out = coerceProperties(schema, { name: "Dentist", Date: "2026-09-12T14:00:00", Tags: ["Health", "Personal"], Done: "yes" });
  assert.deepEqual(out.Name, { title: [{ type: "text", text: { content: "Dentist" } }] });
  assert.deepEqual(out.Date, { date: { start: "2026-09-12T14:00:00" } });
  assert.deepEqual(out.Tags, { multi_select: [{ name: "Health" }, { name: "Personal" }] });
  assert.deepEqual(out.Done, { checkbox: true });
});

test("coerceProperties passes through raw payloads and rejects unknown properties", () => {
  const raw = { date: { start: "2026-01-01", end: "2026-01-02" } };
  assert.deepEqual(coerceProperties(schema, { Date: raw }).Date, raw);
  assert.throws(() => coerceProperties(schema, { Nope: 1 }), /does not exist/);
});

// ---------- request: timeout and retry ----------

import { MAX_ATTEMPTS, NotionApiError, NotionClient, retryDelayMs } from "../src/lib/notion.ts";

const PAGE_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const page = () => new Response(JSON.stringify({ id: PAGE_ID, url: "https://www.notion.so/x", parent: {}, properties: {} }), { status: 200 });
const status = (code: number, headers: Record<string, string> = {}) => new Response(JSON.stringify({ message: `status ${code}`, code: "x" }), { status: code, headers });

/** A fetch that answers from a script, one entry per call; an Error entry is thrown as a network failure. */
function scripted(answers: Array<() => Response | Error>): { fetchImpl: typeof globalThis.fetch; calls: Array<{ method: string; url: string }> } {
  const calls: Array<{ method: string; url: string }> = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    calls.push({ method: init?.method ?? "GET", url: String(input) });
    const next = answers.shift();
    if (!next) throw new Error("scripted fetch ran out of answers");
    const answer = next();
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetchImpl, calls };
}

function client(answers: Array<() => Response | Error>, waits: number[] = []) {
  const { fetchImpl, calls } = scripted(answers);
  const notion = new NotionClient("ntn_test", { fetch: fetchImpl, sleep: async (ms) => { waits.push(ms); } });
  return { notion, calls, waits };
}

test("retryDelayMs honours Retry-After in seconds and backs off without it", () => {
  assert.equal(retryDelayMs(0, "2"), 2000);
  assert.equal(retryDelayMs(0, "0"), 0);
  assert.equal(retryDelayMs(0, "999"), 30_000, "a huge Retry-After is capped rather than obeyed");
  assert.equal(retryDelayMs(0, null), 500);
  assert.equal(retryDelayMs(1, undefined), 1000);
  assert.equal(retryDelayMs(2, "not-a-number"), 2000);
  assert.equal(retryDelayMs(10, null), 8000, "the backoff is capped");
});

test("a 429 is retried after the Retry-After the limiter asks for", async () => {
  const { notion, calls, waits } = client([() => status(429, { "retry-after": "2" }), page]);
  const got = await notion.getPage(PAGE_ID);
  assert.equal(got.id, PAGE_ID);
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [2000]);
});

test("a 503 is retried for a write too, since the request never reached Notion", async () => {
  const { notion, calls } = client([() => status(503), () => new Response(JSON.stringify({ id: PAGE_ID, url: "", parent: {}, properties: {} }), { status: 200 })]);
  await notion.updatePage(PAGE_ID, {});
  assert.deepEqual(calls.map((c) => c.method), ["PATCH", "PATCH"]);
});

test("a 504 on a write is not retried: the write may already have happened", async () => {
  const { notion, calls } = client([() => status(504), page]);
  await assert.rejects(() => notion.updatePage(PAGE_ID, {}), (error: unknown) => error instanceof NotionApiError && error.status === 504);
  assert.equal(calls.length, 1);
});

test("a dropped connection is retried for a read and reported plainly for a write", async () => {
  const read = client([() => new TypeError("fetch failed"), page]);
  assert.equal((await read.notion.getPage(PAGE_ID)).id, PAGE_ID);
  assert.equal(read.calls.length, 2);

  const write = client([() => new TypeError("fetch failed")]);
  await assert.rejects(() => write.notion.updatePage(PAGE_ID, {}), /Could not reach Notion: fetch failed/);
  assert.equal(write.calls.length, 1);
});

test("a timeout says so, in seconds, rather than surfacing the abort", async () => {
  const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const { notion } = client([timeout]);
  await assert.rejects(() => notion.updatePage(PAGE_ID, {}), /did not answer within 30 seconds/);
});

test("retries stop after MAX_ATTEMPTS and the last answer is the error", async () => {
  const answers = Array.from({ length: MAX_ATTEMPTS + 2 }, () => () => status(429, { "retry-after": "1" }));
  const { notion, calls, waits } = client(answers);
  await assert.rejects(() => notion.getPage(PAGE_ID), (error: unknown) => error instanceof NotionApiError && error.status === 429);
  assert.equal(calls.length, MAX_ATTEMPTS);
  assert.equal(waits.length, MAX_ATTEMPTS - 1);
});

test("a 4xx that is not the limiter is not retried", async () => {
  const { notion, calls } = client([() => status(404), page]);
  await assert.rejects(() => notion.getPage(PAGE_ID), (error: unknown) => error instanceof NotionApiError && error.status === 404);
  assert.equal(calls.length, 1);
});

test("a search is a POST that only reads, so a dropped connection is retried for it", async () => {
  const hits = () => new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), { status: 200 });
  const { notion, calls } = client([() => new TypeError("fetch failed"), hits]);
  assert.deepEqual(await notion.search("budget"), []);
  assert.deepEqual(calls.map((c) => c.method), ["POST", "POST"]);
});
