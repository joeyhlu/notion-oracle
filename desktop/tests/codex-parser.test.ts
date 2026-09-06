import { test } from "node:test";
import assert from "node:assert/strict";
import { newCodexState, parseCodexLine, tomlInlineTable } from "../src/main/brains/codex.ts";

test("parses codex exec --json events into UI events", () => {
  const state = newCodexState();
  const lines = [
    { type: "thread.started", thread_id: "t1" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "i1", type: "mcp_tool_call", server: "notion", tool: "search_notion", arguments: { query: "x" }, status: "in_progress" } },
    { type: "item.completed", item: { id: "i1", type: "mcp_tool_call", server: "notion", tool: "search_notion", status: "completed", result: { content: [{ type: "text", text: "[]" }] } } },
    { type: "item.completed", item: { id: "i2", type: "agent_message", text: "Nothing found." } },
    { type: "turn.completed", usage: { input_tokens: 1 } },
  ].map((l) => JSON.stringify(l));
  const events = lines.flatMap((l) => parseCodexLine(l, state));
  assert.deepEqual(events.map((e) => e.type), ["tool-start", "tool-end", "text", "done"]);
  assert.deepEqual(events.at(-1), { type: "done", threadId: "t1", text: "Nothing found." });
});

test("surfaces codex errors", () => {
  const state = newCodexState();
  assert.deepEqual(parseCodexLine(JSON.stringify({ type: "error", message: "boom" }), state), [{ type: "error", message: "boom", threadId: null }]);
});

test("formats a TOML inline table for the MCP env", () => {
  assert.equal(tomlInlineTable({ A: "1", B: 'x"y' }), '{ A = "1", B = "x\\"y" }');
});
