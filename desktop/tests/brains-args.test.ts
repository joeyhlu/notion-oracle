import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeArgs, claudeMcpConfig } from "../src/main/brains/claude.ts";
import { codexArgs } from "../src/main/brains/codex.ts";
import { qualifiedToolNames, type McpServerSpec } from "../src/main/brains/types.ts";

const servers: McpServerSpec[] = [
  { name: "notion", command: "/app/electron", args: ["/app/dist/mcp/notion-server.js"], env: { ELECTRON_RUN_AS_NODE: "1", NOTION_TOKEN: "ntn_x" }, toolNames: ["search_notion", "get_page"] },
  { name: "calendar", command: "/app/electron", args: ["/app/dist/mcp/calendar-server.js"], env: { ELECTRON_RUN_AS_NODE: "1", CALENDAR_AUTO_SAVE: "0" }, toolNames: ["calendar_status", "calendar_create_event"] },
];

test("tool names are qualified per server", () => {
  assert.deepEqual(qualifiedToolNames(servers), ["mcp__notion__search_notion", "mcp__notion__get_page", "mcp__calendar__calendar_status", "mcp__calendar__calendar_create_event"]);
});

test("claude gets every server in its config and allow-list, and no built-in tools", () => {
  const args = claudeArgs({ mcpServers: servers, threadId: null, model: "" }, { mcpConfigPath: "/tmp/mcp.json", systemPromptPath: "/tmp/sys.txt" });
  const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--permission-mode"));
  assert.deepEqual(allowed, qualifiedToolNames(servers));
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.ok(!args.includes("--resume"));
  const config = claudeMcpConfig(servers) as { mcpServers: Record<string, { command: string; env: Record<string, string> }> };
  assert.deepEqual(Object.keys(config.mcpServers), ["notion", "calendar"]);
  assert.equal(config.mcpServers.calendar?.env.CALENDAR_AUTO_SAVE, "0");
});

test("claude resumes a thread and passes a model override", () => {
  const args = claudeArgs({ mcpServers: servers, threadId: "sess-1", model: " opus " }, { mcpConfigPath: "m", systemPromptPath: "s" });
  assert.equal(args[args.indexOf("--resume") + 1], "sess-1");
  assert.equal(args[args.indexOf("--model") + 1], "opus");
});

test("codex gets one config override triple per server", () => {
  const args = codexArgs({ mcpServers: servers, threadId: null, model: "", cwd: "/work" });
  const overrides = args.filter((_, i) => args[i - 1] === "-c");
  assert.equal(overrides.length, 6);
  assert.ok(overrides.includes('mcp_servers.notion.command="/app/electron"'));
  assert.ok(overrides.includes('mcp_servers.calendar.env={ ELECTRON_RUN_AS_NODE = "1", CALENDAR_AUTO_SAVE = "0" }'));
  assert.deepEqual(args.slice(0, 1), ["exec"]);
  assert.deepEqual(codexArgs({ mcpServers: servers, threadId: "t9", model: "", cwd: "/work" }).slice(0, 3), ["exec", "resume", "t9"]);
});
