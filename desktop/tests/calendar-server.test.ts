import { test } from "node:test";
import assert from "node:assert/strict";
import { StdioMcpServer } from "../src/mcp/stdio-server.ts";

// The env var must be set before calendar-server.ts is evaluated, so it's a dynamic import that
// runs after the assignment below rather than a static (hoisted) one.
process.env.NOTION_ORACLE_MCP_TEST = "1";
const { server, CALENDAR_TOOLS, execute } = await import("../src/mcp/calendar-server.ts");

// Sanity check on the module's default export: it's a real server, just not the one we drive in
// these tests (it defaults to writing on stdout, which we don't want mixed into `node --test` output).
assert.ok(server instanceof StdioMcpServer);

interface JsonRpcReply {
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function makeServer(): { srv: StdioMcpServer; lines: string[] } {
  const lines: string[] = [];
  const srv = new StdioMcpServer({
    name: "notion-oracle-calendar-test",
    version: "0.0.0",
    instructions: "test",
    tools: CALENDAR_TOOLS,
    execute,
    write: (line) => lines.push(line),
  });
  return { srv, lines };
}

function repliesById(lines: string[]): Map<number | string | null, JsonRpcReply> {
  return new Map(lines.map((l) => JSON.parse(l) as JsonRpcReply).map((r) => [r.id, r]));
}

function toolCallResult(reply: JsonRpcReply): { isError: boolean; content: Array<{ type: string; text: string }> } {
  return reply.result as { isError: boolean; content: Array<{ type: string; text: string }> };
}

test("initialize and tools/list expose this platform's calendar tools, each with an input schema", async () => {
  const { srv, lines } = makeServer();
  await srv.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  await srv.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });

  const replies = repliesById(lines);
  assert.equal(replies.get(1)!.result!.protocolVersion, "2025-06-18");

  const tools = replies.get(2)!.result!.tools as Array<{ name: string; inputSchema: unknown }>;
  const names = tools.map((t) => t.name);
  assert.deepEqual(names, CALENDAR_TOOLS.map((t) => t.name));
  // The keystroke fallback exists everywhere. The real read/write tools need a calendar Oracle
  // can drive: Calendar.app on macOS, Outlook on Windows. Linux has neither.
  const HAS_REAL_CALENDAR = process.platform === "darwin" || process.platform === "win32";
  assert.ok(names.includes("calendar_create_event_by_keystrokes"));
  assert.equal(names.includes("calendar_create_event"), HAS_REAL_CALENDAR);
  assert.ok(
    tools.every((t) => t.inputSchema && typeof t.inputSchema === "object"),
    "every tool must carry an inputSchema",
  );
});

// CI runs these on all three platforms. Notion Calendar is installed on none of them, so the
// app is never running, but the control method differs: macOS and Windows really probe for the
// app, Linux reports the platform as unsupported.
const EXPECTED_METHOD = process.platform === "darwin" ? "applescript" : process.platform === "win32" ? "powershell" : "unsupported";
const APP_UNREACHABLE = /is not running|only supported on macOS and Windows/;

test("calendar_status reports both backends and how each is set up", async () => {
  const { srv, lines } = makeServer();
  await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "calendar_status", arguments: {} } });

  const call = toolCallResult(repliesById(lines).get(1)!);
  assert.equal(call.isError, false);
  const status = JSON.parse(call.content[0]!.text) as {
    default_backend: string;
    notion_calendar_app: { running: boolean; platform: string; method: string };
    system_calendar: { available: boolean; reason?: string };
  };
  assert.equal(status.notion_calendar_app.platform, process.platform);
  assert.equal(status.notion_calendar_app.running, false);
  if (process.platform === "darwin" || process.platform === "win32") {
    assert.equal(status.default_backend, "system-calendar");
  } else {
    // Linux has no calendar Oracle can read or write, so the keystroke path is the default and
    // the status says why the better one is missing.
    assert.equal(status.default_backend, "notion-app-keystrokes");
    assert.equal(status.system_calendar.available, false);
    assert.match(status.system_calendar.reason ?? "", /macOS and Windows/);
  }
});

test("the keystroke fallback reports a bad date as a bad date, even when the app cannot be reached", async () => {
  const { srv, lines } = makeServer();
  await srv.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "calendar_create_event_by_keystrokes", arguments: { title: "Dentist", start: "not-a-date" } },
  });

  const call = toolCallResult(repliesById(lines).get(1)!);
  assert.equal(call.isError, true);
  // Input is validated before the app-status check, so the model gets the precise error rather
  // than "the app is not running" (which is what this platform would otherwise report).
  assert.match(call.content[0]!.text, /ISO 8601/);
});

test("the keystroke fallback stops at the app check when the app is unreachable", async () => {
  const { srv, lines } = makeServer();
  await srv.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "calendar_create_event_by_keystrokes", arguments: { title: "Dentist", start: "2026-09-07T14:00:00" } },
  });
  const call = toolCallResult(repliesById(lines).get(1)!);
  assert.equal(call.isError, true);
  assert.match(call.content[0]!.text, APP_UNREACHABLE);
});

test("calendar_open_date surfaces the ISO 8601 parsing error for a bad date (parseWhen runs before any platform check)", async () => {
  const { srv, lines } = makeServer();
  await srv.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "calendar_open_date", arguments: { date: "not-a-date" } },
  });

  const call = toolCallResult(repliesById(lines).get(1)!);
  assert.equal(call.isError, true);
  assert.match(call.content[0]!.text, /ISO 8601/);
});

test("tools/call rejects an unknown tool name", async () => {
  const { srv, lines } = makeServer();
  await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "calendar_delete_everything", arguments: {} } });
  const reply = repliesById(lines).get(1)!;
  assert.match(reply.error!.message, /Unknown tool/);
});

// ---------- editing by name ----------

// These run through the executor directly: on Linux the system-calendar tools are not listed,
// but the request checks that happen before any backend is touched are the same everywhere.

test("an edit has to say which event: uid or words from the title", async () => {
  const result = await execute("calendar_update_event", { start: "2026-09-18T15:00:00" });
  assert.equal(result.ok, false);
  assert.match(result.content, /pass match .*or uid/i);
  const del = await execute("calendar_delete_event", {});
  assert.equal(del.ok, false);
  assert.match(del.content, /pass match/i);
});

test("a find needs a query", async () => {
  const result = await execute("calendar_find_events", {});
  assert.equal(result.ok, false);
  assert.match(result.content, /query/);
});

test("a repeat the tool cannot read is refused before anything is written", async () => {
  const result = await execute("calendar_create_event", { title: "Yoga", start: "2026-09-18T07:00:00", repeat: "whenever" });
  assert.equal(result.ok, false);
  assert.match(result.content, /Could not read the repeat/);
});

test("the editing tools describe the one-step path and the repeat option", () => {
  const byName = Object.fromEntries(CALENDAR_TOOLS.map((t) => [t.name, t]));
  if (!byName.calendar_update_event) return; // Linux: the system tools are not exposed
  const update = byName.calendar_update_event!;
  const props = update.input_schema.properties as Record<string, unknown>;
  for (const key of ["match", "on", "uid", "start", "shift_minutes", "duration_minutes", "repeat", "repeat_until", "repeat_count", "show"]) assert.ok(key in props, key);
  assert.equal((update.input_schema as { required?: string[] }).required, undefined, "nothing is required: match or uid is checked at run time");
  assert.match(update.description, /keeps the event's length/);
  assert.ok("match" in (byName.calendar_delete_event!.input_schema.properties as object));
  assert.ok("match" in (byName.calendar_move_event!.input_schema.properties as object));
  assert.ok("repeat" in (byName.calendar_create_event!.input_schema.properties as object));
  assert.ok(byName.calendar_find_events, "find by name is exposed");
});
