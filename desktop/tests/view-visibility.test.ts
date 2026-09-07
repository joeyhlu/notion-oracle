import { test } from "node:test";
import assert from "node:assert/strict";
import { markup, rules, ruleBody } from "./css-rules.ts";

/**
 * Guards the bug that shipped in 0.3.0: chat, setup and help are shown and hidden through the
 * `hidden` attribute, but the redesign gave several of them a `display:` of their own. A class
 * selector outranks the user agent's bare `[hidden]` rule, so the attribute was ignored and all
 * three views rendered stacked on top of each other. The DOM says hidden and the compositor
 * draws it anyway, so a functional test cannot see it — this reads the stylesheet.
 */
test("the hidden attribute wins over any rule that sets display", () => {
  assert.match(ruleBody("[hidden]"), /display:\s*none\s*!important/);
});

test("every element that starts hidden is one the renderer can show again", () => {
  const ids = [...markup.matchAll(/id="([\w-]+)"[^>]*\shidden\b/g)].map((m) => m[1]);
  for (const id of ["view-setup", "view-help", "setup-banner"]) {
    assert.ok(ids.includes(id), `expected #${id} to start hidden, got: ${ids.join(", ")}`);
  }
});

test("no rule targets .setup, which the redesigned markup no longer has", () => {
  // The redesign renamed the setup container to .view.scroll and orphaned every `.setup ...`
  // rule, leaving its labels, inputs and selects unstyled.
  const orphans = rules.map((r) => r.selector).filter((s) => /(^|[\s,]|^)\.setup(\s|$|,)/.test(s));
  assert.deepEqual(orphans, [], `rules target .setup: ${orphans.join(", ")}`);
});

test("scrolling views style their own labels, inputs and selects", () => {
  const selectors = rules.map((r) => r.selector);
  for (const needed of [".view.scroll label", ".view.scroll select"]) {
    assert.ok(
      selectors.some((s) => s.split(",").some((part) => part.trim() === needed)),
      `missing a rule for ${needed}`,
    );
  }
});

test("each selector is declared once, so reading the sheet tells you what applies", () => {
  // An appended "polish" block that re-declared .chip, .send, .status-card and .setup-footer was
  // how the display conflict slipped in unnoticed.
  // A selector may legitimately reappear under a different at-rule — :root is redefined inside
  // the dark-scheme media query — so duplicates are counted per enclosing context.
  const seen = new Map<string, number>();
  for (const r of rules) {
    const key = [...r.context, r.selector].join(" >> ");
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const dupes = [...seen].filter(([, n]) => n > 1).map(([s]) => s);
  assert.deepEqual(dupes, [], `declared more than once: ${dupes.join(", ")}`);
});
