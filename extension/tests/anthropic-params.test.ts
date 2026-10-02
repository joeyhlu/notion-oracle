import { test } from "node:test";
import assert from "node:assert/strict";
import { requestParams, searchResultSources, supportsEffort, supportsFallbacks, webSearchToolType } from "../src/lib/providers/anthropic.ts";

const tool = { name: "read_current_page", description: "Read", input_schema: { type: "object" as const, properties: {} } };

test("the default model gets explicit effort, refusal fallbacks and the current web search tool", () => {
  const p = requestParams("claude-opus-5-5", "medium", { system: "S", tools: [tool], webSearch: true });
  assert.equal(p.model, "claude-opus-5-5");
  assert.deepEqual(p.output_config, { effort: "medium" });
  assert.deepEqual(p.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(p.fallbacks, "default");
  assert.deepEqual(p.tools?.map((t) => ("type" in t ? t.type : t.name)), ["read_current_page", "web_search_20260209"]);
  assert.deepEqual(p.system, [{ type: "text", text: "S", cache_control: { type: "ephemeral" } }]);
});

test("a plain completion sends no tools key at all", () => {
  const p = requestParams("claude-opus-5-5", "low", { system: "S", tools: [] });
  assert.equal("tools" in p, false);
});

test("Haiku takes neither effort nor fallbacks, and the basic web search", () => {
  assert.equal(supportsEffort("claude-haiku-4-5"), false);
  assert.equal(supportsFallbacks("claude-haiku-4-5"), false);
  assert.equal(webSearchToolType("claude-haiku-4-5"), "web_search_20250305");
  const p = requestParams("claude-haiku-4-5", "high", { system: "S", tools: [], webSearch: true });
  assert.equal("output_config" in p, false);
  assert.equal("fallbacks" in p, false);
});

test("model families map to the right options", () => {
  for (const m of ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"]) assert.equal(supportsFallbacks(m), true, m);
  assert.equal(supportsFallbacks("claude-sonnet-5"), false);
  for (const m of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-4-6", "claude-sonnet-4-6"]) assert.equal(webSearchToolType(m), "web_search_20260209", m);
  for (const m of ["claude-fable-5-1", "claude-opus-4-5"]) assert.equal(webSearchToolType(m), "web_search_20250305", m);
});

test("web search results become sources; an error result yields none", () => {
  const ok = { type: "web_search_tool_result" as const, tool_use_id: "s", content: [{ type: "web_search_result", url: "https://a.example", title: "A" }, { type: "web_search_result", url: "https://b.example", title: "" }] };
  assert.deepEqual(searchResultSources(ok), [{ title: "A", url: "https://a.example" }, { title: "https://b.example", url: "https://b.example" }]);
  assert.deepEqual(searchResultSources({ type: "web_search_tool_result", tool_use_id: "s", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } }), []);
});
