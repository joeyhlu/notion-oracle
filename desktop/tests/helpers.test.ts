import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTitle } from "../src/main/notion-window.ts";
import { winQuote } from "../src/main/process.ts";
import { displayToolName, summarize } from "../src/main/brains/types.ts";

test("cleanTitle strips the app name from Notion window titles", () => {
  assert.equal(cleanTitle("Roadmap - Notion"), "Roadmap");
  assert.equal(cleanTitle("Roadmap | Notion"), "Roadmap");
  assert.equal(cleanTitle("Roadmap"), "Roadmap");
  assert.equal(cleanTitle("Notion"), null);
  assert.equal(cleanTitle(""), null);
  assert.equal(cleanTitle(null), null);
});

test("winQuote quotes only when needed and escapes inner quotes", () => {
  assert.equal(winQuote("plain"), "plain");
  assert.equal(winQuote(""), '""');
  assert.equal(winQuote("C:\\Program Files\\x.exe"), '"C:\\Program Files\\x.exe"');
  assert.equal(winQuote('say "hi"'), '"say \\"hi\\""');
});

test("tool helpers", () => {
  assert.equal(displayToolName("mcp__notion__search_notion"), "search_notion");
  assert.equal(displayToolName("search_notion"), "search_notion");
  assert.equal(summarize([{ type: "text", text: "a  b" }]), "a b");
  assert.equal(summarize("x".repeat(200)).length, 161);
});
