import { test } from "node:test";
import assert from "node:assert/strict";
import { FrontmostWatcher, isNotionApp, isOracleApp, parseLsappinfoName, shouldShowOverlay, type FrontmostSample } from "../src/main/frontmost.ts";

test("Oracle's own name does not count as Notion", () => {
  assert.equal(isNotionApp("Notion"), true);
  assert.equal(isNotionApp("Notion Calendar"), true);
  assert.equal(isNotionApp("notion"), true);
  // "Notion Oracle" contains "notion" - the overlay must not treat itself as the target app.
  assert.equal(isNotionApp("Notion Oracle"), false);
  assert.equal(isOracleApp("Notion Oracle"), true);
  assert.equal(isNotionApp("Google Chrome"), false);
  assert.equal(isNotionApp(null), false);
});

test("parses the app name out of lsappinfo output", () => {
  assert.equal(parseLsappinfoName('"LSDisplayName"="Notion"'), "Notion");
  assert.equal(parseLsappinfoName('  "LSDisplayName" = "Google Chrome"  \n'), "Google Chrome");
  assert.equal(parseLsappinfoName("no match here"), null);
});

const base = { followNotion: true, detectionSupported: true, frontmostApp: "Google Chrome", oracleFocused: false };

test("hides only when detection positively reports another app", () => {
  assert.equal(shouldShowOverlay(base), false);
  assert.equal(shouldShowOverlay({ ...base, frontmostApp: "Notion" }), true);
  assert.equal(shouldShowOverlay({ ...base, oracleFocused: true }), true);
});

test("fails open so the overlay can never become unreachable", () => {
  // Platform cannot report the foreground app (e.g. Accessibility permission denied).
  assert.equal(shouldShowOverlay({ ...base, detectionSupported: false, frontmostApp: null }), true);
  // A single failed reading is transient, not evidence Notion was closed.
  assert.equal(shouldShowOverlay({ ...base, frontmostApp: null }), true);
  // Feature switched off entirely.
  assert.equal(shouldShowOverlay({ ...base, followNotion: false }), true);
});

test("watcher reports only changes and stops once detection is unsupported", async () => {
  const samples: FrontmostSample[] = [
    { name: "Notion", supported: true },
    { name: "Notion", supported: true },
    { name: "Google Chrome", supported: true },
    { name: null, supported: false },
    { name: "Notion", supported: true },
  ];
  const seen: FrontmostSample[] = [];
  let i = 0;
  const watcher = new FrontmostWatcher({
    intervalMs: 5,
    probe: async () => samples[Math.min(i++, samples.length - 1)]!,
    onChange: (s) => seen.push(s),
  });
  watcher.start();
  await new Promise((r) => setTimeout(r, 90));
  watcher.stop();
  assert.deepEqual(seen.map((s) => s.name), ["Notion", "Google Chrome", null]);
  // Polling stopped at the unsupported sample, so the later "Notion" was never read.
  assert.ok(i <= 4, `probe kept polling after unsupported (called ${i} times)`);
});
