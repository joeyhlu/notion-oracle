import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards a bug that functional tests cannot see: an element with -webkit-app-region: drag is
 * treated by the OS as a title bar, so the window manager swallows clicks on it. Playwright
 * injects synthetic input below that layer, so a clicked-and-it-worked test still passes while
 * the real app has a dead button. These assertions read the stylesheet instead.
 */
const css = readFileSync(join(import.meta.dirname, "..", "src", "renderer", "styles.css"), "utf8");

/** Returns the declarations of the first rule whose selector list matches exactly. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css);
  assert.ok(match, `no CSS rule found for "${selector}"`);
  return match![1] ?? "";
}

function appRegion(selector: string): string | null {
  return /-webkit-app-region:\s*([a-z-]+)/.exec(ruleBody(selector))?.[1] ?? null;
}

test("the collapsed pill is clickable, not a drag region", () => {
  assert.equal(appRegion(".pill"), "no-drag");
});

test("interactive controls inside the draggable header opt out of dragging", () => {
  assert.equal(appRegion(".header"), "drag");
  assert.equal(appRegion(".header button"), "no-drag");
});
