import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");

/**
 * The version has to come from package.json everywhere it appears. A hard-coded one is worse than
 * none: it goes stale silently, and then a bug report names a build that was never shipped.
 */

test("the build injects the version from package.json", () => {
  const build = read("scripts", "build.mjs");
  assert.match(build, /JSON\.parse\(readFileSync\("package\.json"/);
  assert.match(build, /define: \{ __APP_VERSION__: JSON\.stringify\(version\) \}/);
});

test("the renderer reads the injected value and never a literal", () => {
  const renderer = read("src", "renderer", "renderer.ts");
  assert.match(renderer, /const VERSION = __APP_VERSION__;/);
  const { version } = JSON.parse(read("package.json")) as { version: string };
  assert.ok(!renderer.includes(version), `renderer.ts hard-codes ${version}`);
});

test("the main process takes it from Electron, which reads the same file", () => {
  const main = read("src", "main", "main.ts");
  assert.match(main, /Notion Oracle \$\{app\.getVersion\(\)\}/);
});

test("the markup has somewhere to put it", () => {
  const html = read("src", "renderer", "index.html");
  assert.equal((html.match(/data-version/g) ?? []).length, 2, "setup and help each carry a slot");
});

test("the built bundle has the real number in it", () => {
  // Proves the define actually fired, rather than the identifier surviving into the output.
  const { version } = JSON.parse(read("package.json")) as { version: string };
  let bundle: string;
  try {
    bundle = read("dist", "renderer", "renderer.js");
  } catch {
    return; // not built yet; npm run check builds first
  }
  assert.ok(bundle.includes(`"${version}"`), `the bundle does not contain ${version}`);
  assert.ok(!bundle.includes("__APP_VERSION__"), "the placeholder survived into the bundle");
});
