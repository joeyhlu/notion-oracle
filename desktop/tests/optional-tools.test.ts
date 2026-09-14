import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NOTION_API_TOOLS, notionTools } from "../../extension/src/lib/tools.ts";
import { DEFAULT_SETTINGS } from "../src/shared/types.ts";
import { buildSystemPrompt } from "../src/main/prompt.ts";

/**
 * The optional tools are decided in the main process and reach the MCP server as environment
 * flags. Two ways that goes wrong silently: the server exposes a tool the CLI's allow-list does
 * not name, so the model can see it and never call it; or the prompt teaches a tool that is not
 * there, so the model tries and fails.
 */

test("both extras are off for a new install", () => {
  // They cost real time and subscription usage per question, so they are asked for, not assumed.
  assert.equal(DEFAULT_SETTINGS.contentSearch, false);
  assert.equal(DEFAULT_SETTINGS.bulkEdit, false);
});

test("the allow-list the CLI is given matches what the server exposes", () => {
  const main = readFileSync(join(import.meta.dirname, "..", "src", "main", "main.ts"), "utf8");
  const server = readFileSync(join(import.meta.dirname, "..", "src", "mcp", "notion-server.ts"), "utf8");
  // Both sides must build their list from the same function, or the two drift apart.
  assert.match(main, /toolNames: notionTools\(\{ contentSearch: current\.contentSearch, bulkEdit: current\.bulkEdit \}\)/);
  assert.match(server, /tools: notionTools\(\{/);
  for (const flag of ["ORACLE_CONTENT_SEARCH", "ORACLE_BULK_EDIT"]) {
    assert.match(main, new RegExp(flag), `${flag} is sent`);
    assert.match(server, new RegExp(`process\\.env\\.${flag}`), `${flag} is read`);
  }
});

test("the server's flags are read as the main process writes them", () => {
  // "1" and "0", not true/false: an env var is always a string, and "false" is truthy.
  const main = readFileSync(join(import.meta.dirname, "..", "src", "main", "main.ts"), "utf8");
  const server = readFileSync(join(import.meta.dirname, "..", "src", "mcp", "notion-server.ts"), "utf8");
  assert.match(main, /ORACLE_CONTENT_SEARCH: current\.contentSearch \? "1" : "0"/);
  assert.match(server, /ORACLE_CONTENT_SEARCH === "1"/);
});

test("the prompt only teaches tools that are actually present", () => {
  const off = buildSystemPrompt("", { calendar: false, calendarAutoSave: false });
  assert.doesNotMatch(off, /search_page_contents/);
  assert.doesNotMatch(off, /set_database_rows/);

  const search = buildSystemPrompt("", { calendar: false, calendarAutoSave: false, contentSearch: true });
  assert.match(search, /search_page_contents/);
  assert.doesNotMatch(search, /set_database_rows/, "one switch does not describe the other's tools");

  const bulk = buildSystemPrompt("", { calendar: false, calendarAutoSave: false, bulkEdit: true });
  assert.match(bulk, /read_database_rows/);
  assert.match(bulk, /only_empty_property/, "it is told how to avoid redoing finished rows");
  assert.match(bulk, /Confirm with the user first if you would overwrite/);
});

test("turning nothing on leaves the tool surface exactly as it was", () => {
  assert.deepEqual(notionTools({ contentSearch: false, bulkEdit: false }).map((t) => t.name),
    NOTION_API_TOOLS.map((t) => t.name));
});

test("the setup screen offers both, and the renderer saves both", () => {
  const html = readFileSync(join(import.meta.dirname, "..", "src", "renderer", "index.html"), "utf8");
  const renderer = readFileSync(join(import.meta.dirname, "..", "src", "renderer", "renderer.ts"), "utf8");
  for (const id of ["content-search", "bulk-edit"]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} has a control`);
    assert.match(renderer, new RegExp(`"${id}"\\)\\.checked = settings\\.`), `${id} is loaded from settings`);
    assert.match(renderer, new RegExp(`\\$<HTMLInputElement>\\("${id}"\\)\\.checked,`), `${id} is written back on save`);
  }
});
