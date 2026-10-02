import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CONVERSATIONS, ageGroup, newConversationId, titleFrom, upsertIndex, type ConversationSummary } from "../src/lib/conversations.ts";

test("a chat is titled by its first message, cut at a word", () => {
  assert.equal(titleFrom("Summarize this page"), "Summarize this page");
  assert.equal(titleFrom("  multi\nline   text "), "multi line text");
  const long = titleFrom("What did we decide about the pricing page redesign in the meeting last Thursday afternoon");
  assert.ok(long.endsWith("…") && long.length <= 61 && !long.slice(0, -1).endsWith(" "));
  assert.equal(titleFrom(""), "New chat");
});

test("saving puts a chat on top, replaces its old entry, and evicts past the cap", () => {
  const entry = (id: string): ConversationSummary => ({ id, title: id, updatedAt: "2026-10-01T00:00:00Z" });
  let index: ConversationSummary[] = [];
  for (let i = 0; i < MAX_CONVERSATIONS; i++) index = upsertIndex(index, entry(`c${i}`)).index;
  const again = upsertIndex(index, entry("c5"));
  assert.equal(again.index[0]!.id, "c5");
  assert.equal(again.index.length, MAX_CONVERSATIONS);
  assert.deepEqual(again.evicted, []);
  const over = upsertIndex(index, entry("new"));
  assert.deepEqual(over.evicted, ["c0"]);
  assert.equal(over.index.length, MAX_CONVERSATIONS);
});

test("ids are unique and storage-safe", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newConversationId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^c[a-z0-9]+$/);
});

test("history groups by age", () => {
  const now = new Date(2026, 9, 2, 15, 0);
  assert.equal(ageGroup(new Date(2026, 9, 2, 1, 0).toISOString(), now), "Today");
  assert.equal(ageGroup(new Date(2026, 9, 1, 23, 0).toISOString(), now), "Yesterday");
  assert.equal(ageGroup(new Date(2026, 8, 28).toISOString(), now), "Previous 7 days");
  assert.equal(ageGroup(new Date(2026, 6, 1).toISOString(), now), "Older");
});
