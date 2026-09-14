import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { readChanges } from "../src/shared/journal-file.ts";

/**
 * The journal is written by the MCP servers, which the CLI runs as child processes. Everything
 * they need arrives through the environment, and nothing in the unit tests touches that wiring:
 * ORACLE_JOURNAL could be misspelled on either side and every other test would still pass while
 * the Changes view stayed permanently empty.
 */

const PAGE_ID = "11111111-2222-4333-8444-555555555555";
const NEW_BLOCK = "aaaa1111-2222-4333-8444-555555555555";

test("a tool call through the MCP server lands in the journal named by the environment", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "oracle-mcp-")), "changes.jsonl");
  // Read at module load, so they must be set before the import.
  process.env.ORACLE_JOURNAL = file;
  process.env.NOTION_TOKEN = "secret_test";
  process.env.NOTION_CURRENT_PAGE_ID = PAGE_ID;
  process.env.NOTION_ORACLE_MCP_TEST = "1";

  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const path = String(url).replace("https://api.notion.com/v1", "");
    if (path === `/blocks/${PAGE_ID}/children` && init.method === "PATCH") {
      return new Response(JSON.stringify({ results: [{ id: NEW_BLOCK }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: `no stub for ${init.method} ${path}` }), { status: 404 });
  }) as typeof fetch;

  try {
    const { server } = await import("../src/mcp/notion-server.ts");
    const lines: string[] = [];
    // The server writes replies through its own transport; capture them the way the CLI would.
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "append_to_page", arguments: { content_markdown: "hello" } } });
    } finally {
      process.stdout.write = originalWrite;
    }

    const reply = JSON.parse(lines.join("").trim()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.equal(reply.result.isError, false, reply.result.content[0]?.text);

    const recorded = readChanges(file);
    assert.equal(recorded.length, 1, "the child process wrote the change to the file it was given");
    assert.equal(recorded[0]?.tool, "notion");
    assert.equal(recorded[0]?.kind, "block");
    assert.deepEqual(recorded[0]?.undo, { type: "delete-blocks", blockIds: [NEW_BLOCK] });
    assert.match(recorded[0]!.label, /Appended 1 block/);
  } finally {
    globalThis.fetch = original;
    delete process.env.ORACLE_JOURNAL;
    delete process.env.NOTION_TOKEN;
    delete process.env.NOTION_CURRENT_PAGE_ID;
  }
});

test("the main process and the MCP servers agree on the environment variable's name", () => {
  // A rename on one side only would be silent: tools keep working, nothing is ever recorded.
  const main = readFileSync(join(import.meta.dirname, "..", "src", "main", "main.ts"), "utf8");
  const notion = readFileSync(join(import.meta.dirname, "..", "src", "mcp", "notion-server.ts"), "utf8");
  const calendar = readFileSync(join(import.meta.dirname, "..", "src", "mcp", "calendar-server.ts"), "utf8");
  assert.equal((main.match(/ORACLE_JOURNAL/g) ?? []).length, 2, "both servers are given the journal path");
  assert.match(notion, /process\.env\.ORACLE_JOURNAL/);
  assert.match(calendar, /process\.env\.ORACLE_JOURNAL/);
});
