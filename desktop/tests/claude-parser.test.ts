import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newClaudeState, parseClaudeLine } from "../src/main/brains/claude.ts";
import type { ChatEvent } from "../src/shared/types.ts";

function replay(lines: string[]): ChatEvent[] {
  const state = newClaudeState();
  return lines.flatMap((line) => parseClaudeLine(line, state));
}

test("parses a real Claude Code stream-json run with an MCP tool call", () => {
  const fixture = readFileSync(join(import.meta.dirname, "fixtures", "claude-stream.jsonl"), "utf8").split("\n");
  const events = replay(fixture);
  const types = events.map((e) => e.type);
  assert.deepEqual(types.filter((t) => t !== "text"), ["status", "tool-start", "tool-end", "done"]);
  const start = events.find((e) => e.type === "tool-start");
  assert.ok(start && start.type === "tool-start" && start.name === "search_notion" && JSON.stringify(start.input) === '{"query":"test"}');
  const end = events.find((e) => e.type === "tool-end");
  assert.ok(end && end.type === "tool-end" && end.ok === false && /No Notion integration token/.test(end.summary));
  const done = events.at(-1);
  assert.ok(done && done.type === "done" && done.threadId === "337f10c2-b25a-4814-b3e5-970870d7bdfa");
  const text = events.filter((e): e is Extract<ChatEvent, { type: "text" }> => e.type === "text").map((e) => e.delta).join("");
  assert.equal(text, done.text);
  assert.match(text, /no Notion integration token/i);
});

test("falls back to full assistant text when no partial deltas were streamed", () => {
  const events = replay([
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello there" }] }, session_id: "s1" }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Hello there", session_id: "s1" }),
  ]);
  assert.deepEqual(events, [
    { type: "text", delta: "Hello there" },
    { type: "done", threadId: "s1", text: "Hello there" },
  ]);
});

test("does not duplicate text that was already streamed as deltas", () => {
  const events = replay([
    JSON.stringify({ type: "stream_event", event: { type: "message_start" } }),
    JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hi" }] } }),
    JSON.stringify({ type: "result", subtype: "success", result: "Hi", session_id: "s2" }),
  ]);
  assert.equal(events.filter((e) => e.type === "text").length, 1);
});

test("reports error results and ignores garbage lines", () => {
  const events = replay(["not json", JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "", session_id: "s3" })]);
  assert.deepEqual(events, [{ type: "error", message: "Claude Code stopped: error_max_turns", threadId: "s3" }]);
});
