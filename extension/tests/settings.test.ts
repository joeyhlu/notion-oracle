import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateSettings, shortModelLabel } from "../src/shared/settings.ts";
import { DEFAULT_SETTINGS, SETTINGS_VERSION } from "../src/shared/types.ts";

test("a fresh install gets the defaults: Opus 5.5 and every Notion AI feature on", () => {
  const s = migrateSettings(undefined);
  assert.equal(s.anthropicModel, "claude-opus-5-5");
  assert.equal(s.version, SETTINGS_VERSION);
  for (const key of ["webSearch", "workspaceSearch", "bulkEdit", "aiShortcut", "selectionButton", "floatingButton"] as const) assert.equal(s[key], true, key);
});

test("settings saved by 0.1 move off the old default model but keep everything else", () => {
  const s = migrateSettings({ provider: "anthropic", anthropicApiKey: "sk-ant-x", anthropicModel: "claude-opus-5", customInstructions: "Be brief" });
  assert.equal(s.anthropicModel, "claude-opus-5-5");
  assert.equal(s.anthropicApiKey, "sk-ant-x");
  assert.equal(s.customInstructions, "Be brief");
  assert.equal(s.webSearch, true, "new settings arrive with their defaults");
});

test("a model the user chose is never changed", () => {
  assert.equal(migrateSettings({ anthropicModel: "claude-sonnet-5-5" }).anthropicModel, "claude-sonnet-5-5");
  assert.equal(migrateSettings({ version: 2, anthropicModel: "claude-opus-5" }).anthropicModel, "claude-opus-5", "only pre-2 settings migrate");
});

test("the header shows a short model name", () => {
  assert.equal(shortModelLabel({ ...DEFAULT_SETTINGS }), "Opus 5.5");
  assert.equal(shortModelLabel({ ...DEFAULT_SETTINGS, anthropicModel: "claude-haiku-4-5" }), "Haiku 4.5");
  assert.equal(shortModelLabel({ ...DEFAULT_SETTINGS, anthropicModel: "claude-opus-5" }), "Opus 5");
  assert.equal(shortModelLabel({ ...DEFAULT_SETTINGS, provider: "openai" }), "GPT-5.5");
});
