import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { NOTION_API_TOOLS } from "../../extension/src/lib/tools.ts";

const server = join(import.meta.dirname, "..", "dist", "mcp", "notion-server.js");

test("built MCP server answers initialize, tools/list and tools/call over stdio", { skip: !existsSync(server) && "run npm run build first" }, async () => {
  const child = spawn(process.execPath, [server], { env: { ...process.env, NOTION_TOKEN: "" }, stdio: ["pipe", "pipe", "pipe"] });
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_notion", arguments: { query: "x" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } },
  ];
  child.stdin.end(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
  let out = "";
  for await (const chunk of child.stdout) out += chunk;
  // Replies may arrive out of order (async tool calls vs. synchronous errors), so index by id.
  const replies = new Map(out.trim().split("\n").map((l) => JSON.parse(l) as { id: number; result?: Record<string, unknown>; error?: { message: string } }).map((r) => [r.id, r]));
  assert.equal(replies.size, 4);
  assert.equal(replies.get(1)!.result!.protocolVersion, "2025-06-18");
  const tools = replies.get(2)!.result!.tools as Array<{ name: string; inputSchema: unknown }>;
  // Compare against the source of truth so adding a tool cannot silently break this test.
  assert.deepEqual(tools.map((t) => t.name).sort(), NOTION_API_TOOLS.map((t) => t.name).sort());
  assert.ok(tools.every((t) => t.inputSchema));
  const call = replies.get(3)!.result as { isError: boolean; content: Array<{ text: string }> };
  assert.equal(call.isError, true);
  assert.match(call.content[0]!.text, /No Notion integration token/);
  assert.match(replies.get(4)!.error!.message, /Unknown tool/);
});
