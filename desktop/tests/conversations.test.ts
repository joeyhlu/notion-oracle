import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore } from "../src/shared/conversations-file.ts";
import { MAX_CONVERSATIONS, newConversationId, titleFrom, type Conversation } from "../src/shared/conversations.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "oracle-convo-"));

function conversation(over: Partial<Conversation> = {}): Conversation {
  const now = new Date().toISOString();
  return {
    id: newConversationId(), threadId: "cli-session-1", title: "Summarize my notes",
    createdAt: now, updatedAt: now,
    messages: [{ role: "user", text: "Summarize my notes" }, { role: "assistant", text: "Here you go." }],
    ...over,
  };
}

test("a saved conversation comes back with its CLI session id", () => {
  // That id is the whole point: without it, reopening redraws the text but the model has no memory.
  const store = new ConversationStore(scratch());
  const saved = conversation();
  store.save(saved);
  const loaded = store.get(saved.id);
  assert.equal(loaded?.threadId, "cli-session-1");
  assert.deepEqual(loaded?.messages, saved.messages);
});

test("listing is newest first and reports the message count", () => {
  const store = new ConversationStore(scratch());
  store.save(conversation({ title: "older", updatedAt: "2026-01-01T00:00:00.000Z" }));
  store.save(conversation({ title: "newer", updatedAt: "2026-06-01T00:00:00.000Z" }));
  const list = store.list();
  assert.deepEqual(list.map((c) => c.title), ["newer", "older"]);
  assert.equal(list[0]?.messageCount, 2);
});

test("a conversation with no messages is not history", () => {
  const store = new ConversationStore(scratch());
  store.save(conversation({ messages: [] }));
  assert.deepEqual(store.list(), []);
});

test("a corrupted file costs one conversation, not the history", () => {
  const dir = scratch();
  const store = new ConversationStore(dir);
  store.save(conversation({ title: "intact" }));
  mkdirSync(join(dir, "conversations"), { recursive: true });
  writeFileSync(join(dir, "conversations", "torn.json"), "{ not json");
  assert.deepEqual(store.list().map((c) => c.title), ["intact"]);
  assert.equal(store.get("torn"), null);
});

test("a missing conversation reads as null, and a missing folder lists as empty", () => {
  const store = new ConversationStore(scratch());
  assert.equal(store.get("nope"), null);
  assert.deepEqual(store.list(), []);
});

test("an id that would escape the folder is refused", () => {
  // Ids are generated, never typed, but a traversal here would write anywhere on disk.
  const store = new ConversationStore(scratch());
  for (const bad of ["../escape", "a/b", "..", "with space"]) {
    assert.throws(() => store.save(conversation({ id: bad })), /Invalid conversation id/);
  }
});

test("the oldest are dropped once the cap is passed", () => {
  const store = new ConversationStore(scratch());
  for (let i = 0; i < MAX_CONVERSATIONS + 5; i++) {
    store.save(conversation({ title: `c${i}`, updatedAt: new Date(2026, 0, 1, 0, i).toISOString() }));
  }
  const list = store.list();
  assert.equal(list.length, MAX_CONVERSATIONS);
  assert.equal(list.at(-1)?.title, "c5", "the five oldest went, not the newest");
});

test("deleting removes it and is safe to repeat", () => {
  const store = new ConversationStore(scratch());
  const saved = conversation();
  store.save(saved);
  store.remove(saved.id);
  store.remove(saved.id);
  assert.equal(store.get(saved.id), null);
});

test("titles come from the opening line, trimmed on a word boundary", () => {
  assert.equal(titleFrom("Summarize this page"), "Summarize this page");
  assert.equal(titleFrom("  spaced\n\nout   text "), "spaced out text");
  assert.equal(titleFrom(""), "New conversation");
  assert.equal(titleFrom("   "), "New conversation");
  const long = titleFrom("Turn the meeting notes into a checklist and file it under Projects");
  assert.ok(long.length <= 49 && long.endsWith("…"), long);
  assert.ok(!long.includes("  ") && !/\s…$/.test(long), `no half-word or dangling space: ${long}`);
  // A word longer than the limit still has to be cut somewhere.
  assert.ok(titleFrom("x".repeat(80)).endsWith("…"));
});
