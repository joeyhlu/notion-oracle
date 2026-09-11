import { test } from "node:test";
import assert from "node:assert/strict";
import { markup, rules, ruleBody } from "./css-rules.ts";
import { DEFAULT_SETTINGS, THEMES, asTheme } from "../src/shared/types.ts";

/** The custom properties a token block declares, as name -> value. */
function tokens(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[name!] = value!.trim();
  }
  return out;
}

test("appearance defaults to following the OS", () => {
  assert.equal(DEFAULT_SETTINGS.theme, "system");
  assert.deepEqual([...THEMES], ["system", "light", "dark"]);
});

test("an unrecognised stored theme falls back to system", () => {
  // settings.json is a plain file a user can hand-edit, and dataset values are strings.
  for (const bad of ["", "Dark", "sepia", null, undefined, 3, {}]) {
    assert.equal(asTheme(bad), "system", `asTheme(${JSON.stringify(bad)})`);
  }
  for (const good of THEMES) assert.equal(asTheme(good), good);
});

test("the two dark palettes are identical", () => {
  // CSS cannot share one block between a media query and an attribute selector, so the dark
  // tokens are written twice. Drift between them means the OS-dark and chosen-dark appearances
  // silently differ, which no screenshot of either one alone would reveal.
  const fromMedia = tokens(ruleBody(':root:not([data-theme="light"])'));
  const fromAttribute = tokens(ruleBody(':root[data-theme="dark"]'));
  assert.ok(Object.keys(fromMedia).length > 10, "the dark media block defines no tokens");
  assert.deepEqual(fromAttribute, fromMedia);
});

test("dark redefines exactly the tokens light defines", () => {
  const light = Object.keys(tokens(ruleBody(":root"))).filter((n) => n !== "--t");
  const dark = Object.keys(tokens(ruleBody(':root[data-theme="dark"]')));
  const missing = light.filter((n) => !dark.includes(n) && !n.startsWith("--r"));
  assert.deepEqual(missing, [], `light-only tokens leak into dark: ${missing.join(", ")}`);
});

test("an explicit choice overrides the OS in both directions", () => {
  // Forcing light has to beat a dark OS, which only the :not() on the media block achieves.
  const selectors = rules.map((r) => r.selector);
  assert.ok(selectors.includes(':root:not([data-theme="light"])'),
    "the dark media block must stand down when the user has forced light");
  assert.ok(selectors.includes(':root[data-theme="dark"]'),
    "choosing dark must work on a light OS");
  // Native widgets follow the choice too, or a forced-dark panel gets light scrollbars.
  assert.match(ruleBody(':root[data-theme="light"]'), /color-scheme:\s*light/);
  assert.match(ruleBody(':root[data-theme="dark"]'), /color-scheme:\s*dark/);
});

test("the control offers one segment per theme", () => {
  const values = [...markup.matchAll(/data-theme-value="([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(values, [...THEMES]);
});
