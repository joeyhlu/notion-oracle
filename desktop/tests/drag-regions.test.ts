import { test } from "node:test";
import assert from "node:assert/strict";
import { rules, ruleBody } from "./css-rules.ts";

/**
 * Guards a bug that functional tests cannot see: an element with -webkit-app-region: drag is
 * treated by the OS as a title bar, so the window manager swallows clicks on it. Playwright
 * injects synthetic input below that layer, so a clicked-and-it-worked test still passes while
 * the real app has a dead button. These assertions read the stylesheet instead.
 */
function appRegion(selector: string): string | null {
  return /-webkit-app-region:\s*([a-z-]+)/.exec(ruleBody(selector))?.[1] ?? null;
}

test("the collapsed pill is clickable, not a drag region", () => {
  assert.equal(appRegion(".pill"), "no-drag");
});

test("nothing in the collapsed overlay is a drag region", () => {
  // -webkit-app-region is inherited, so a draggable ancestor can swallow the pill's clicks even
  // though the pill itself says no-drag. Only the expanded panel's header may be draggable.
  const draggable = rules
    .filter((r) => /-webkit-app-region:\s*drag\b/.test(r.body))
    .map((r) => r.selector);
  assert.deepEqual(draggable, [".header"], `unexpected drag regions: ${draggable.join(", ")}`);
});

test("interactive controls inside the draggable header opt out of dragging", () => {
  assert.equal(appRegion(".header"), "drag");
  assert.equal(appRegion(".header button"), "no-drag");
});
