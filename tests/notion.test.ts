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
