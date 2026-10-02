import { test } from "node:test";
import assert from "node:assert/strict";
import { describeTool, isWriteTool } from "../src/lib/activity.ts";
import { PAGE_TOOLS, notionTools } from "../src/lib/tools.ts";

test("every tool the chat can call has a readable label", () => {
  const all = [...PAGE_TOOLS, ...notionTools({ contentSearch: true, bulkEdit: true })].map((t) => t.name);
  for (const name of [...all, "web_search"]) {
    const label = describeTool(name, {});
    assert.notEqual(label, name.replace(/_/g, " "), `${name} falls back to its raw name`);
    assert.match(label, /^[A-Z]/, name);
  }
});

test("labels carry what the user would want to see", () => {
  assert.equal(describeTool("search_notion", { query: "roadmap" }), "Searched Notion for “roadmap”");
  assert.equal(describeTool("web_search", { query: "notion api changes" }), "Searched the web for “notion api changes”");
  assert.equal(describeTool("create_page", { title: "Q4 Plan" }), "Created “Q4 Plan”");
  assert.equal(describeTool("set_database_rows", { property: "Summary", updates: [{}, {}, {}] }), "Filled “Summary” on 3 rows");
  assert.match(describeTool("search_notion", { query: "x".repeat(200) }), /…”$/);
});

test("writes are told apart from reads", () => {
  for (const n of ["create_page", "update_block", "append_to_page", "set_database_rows", "replace_selection", "insert_at_cursor", "delete_block"]) assert.equal(isWriteTool(n), true, n);
  for (const n of ["read_current_page", "search_notion", "get_page", "web_search", "query_database"]) assert.equal(isWriteTool(n), false, n);
});
