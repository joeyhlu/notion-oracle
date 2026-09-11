/**
 * Renders the built panel in a real browser and asserts what a screenshot would have shown.
 *
 * The unit tests read the stylesheet; they cannot tell you that the page *looks* right. Version
 * 0.3.0 shipped with chat, setup and help drawn on top of each other because a class selector
 * outranked the `hidden` attribute — every test passed, and the panel was unusable. This is the
 * check that would have caught it, so it runs in CI.
 *
 * It renders both themes: a dark palette is easy to half-define, and a token that exists only
 * in the light block shows up as unreadable text or a transparent panel, never as a test failure.
 *
 * Usage: node scripts/smoke.mjs [--out <dir>]   (writes screenshots when --out is given)
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const outIndex = process.argv.indexOf("--out");
const out = outIndex === -1 ? null : process.argv[outIndex + 1];
if (out) mkdirSync(out, { recursive: true });

const page_url = pathToFileURL(join(import.meta.dirname, "..", "dist", "renderer", "index.html")).href;

/** Stands in for the preload bridge. `ready` false is a machine that has finished no setup at all. */
function installBridge(ready) {
  const settings = {
    brain: "claude", claudePath: "", codexPath: "", model: "",
    notionToken: ready ? "ntn_smoke" : "",
    customInstructions: "", hotkey: "CommandOrControl+Shift+Space", followNotion: true,
    calendarAutomation: true, calendarBackend: "system", calendarAutosave: false,
    calendarStrategy: "new-event-key", setupComplete: ready,
  };
  window.oracle = {
    platform: async () => "darwin",
    getSettings: async () => settings,
    saveSettings: async (patch) => Object.assign(settings, patch),
    checkBrain: async () => ({
      brain: "claude", installed: ready, path: ready ? "/opt/homebrew/bin/claude" : null,
      version: ready ? "2.1.0" : null, loggedIn: ready,
      detail: ready ? "signed in" : "not found on this machine",
    }),
    getPageHint: async () => null,
    testNotion: async () => ({ ok: true, message: "Connected" }),
    chatSend: async () => {}, chatAbort: async () => {},
    setMode: () => {}, openExternal: () => {}, openSignIn: () => {}, quit: () => {},
    onChatEvent: () => {}, onMode: () => {},
  };
}

/** Relative luminance per WCAG, from a computed `rgb(r, g, b)` string. */
function luminance(rgb) {
  const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map((n) => {
    const c = Number(n) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const failures = [];
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}: expected ${e}, got ${a}`);
};

// CI installs its own Chromium; CHROMIUM_PATH lets a sandbox point at a preinstalled one whose
// build number does not match this Playwright release.
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

for (const scheme of ["light", "dark"]) {
for (const ready of [true, false]) {
  const state = `${scheme}-${ready ? "configured" : "fresh"}`;
  const page = await browser.newPage({
    viewport: { width: 420, height: 620 }, deviceScaleFactor: 2, colorScheme: scheme,
  });
  const noise = [];
  page.on("pageerror", (e) => noise.push(String(e)));
  page.on("console", (m) => m.type() === "error" && noise.push(m.text()));
  await page.addInitScript(installBridge, ready);
  await page.goto(page_url);
  await page.evaluate(() => { document.body.className = "expanded"; });
  await page.waitForFunction(() => !document.getElementById("setup-summary").textContent.startsWith("Checking"));

  /** Ids of the views the browser is actually painting. */
  const shown = () => page.evaluate(() => ["view-chat", "view-setup", "view-help"]
    .filter((id) => getComputedStyle(document.getElementById(id)).display !== "none"));
  const displayed = (id) => page.evaluate(
    (x) => getComputedStyle(document.getElementById(x)).display !== "none", id);
  const shot = (name) => out && page.screenshot({ path: join(out, `${state}-${name}.png`) });

  // The app opens on chat once setup is done, and on setup before that.
  await page.evaluate(() => {
    const setup = document.getElementById("view-setup");
    if (!setup.hidden) document.getElementById("btn-settings").click();
  });
  check(`${state}: chat only`, await shown(), ["view-chat"]);
  // The banner is the one thing that tells you the app cannot answer yet.
  check(`${state}: banner shown`, await displayed("setup-banner"), !ready);
  await shot("chat");

  await page.click("#btn-settings");
  check(`${state}: setup only`, await shown(), ["view-setup"]);
  check(`${state}: summary`, await page.textContent("#setup-summary"),
    ready ? "Everything is ready." : "0 of 2 required steps done.");
  // Setup opens the step that still needs attention rather than everything or nothing.
  check(`${state}: open steps`, await page.evaluate(
    () => [...document.querySelectorAll(".step.open")].map((s) => s.id)), ready ? [] : ["step-ai"]);
  await shot("setup");

  await page.click("#btn-help");
  check(`${state}: help only`, await shown(), ["view-help"]);
  check(`${state}: faq entries`, await page.locator("#faq .faq-item").count() >= 8, true);
  check(`${state}: faq starts closed`, await page.locator("#faq .faq-a:visible").count(), 0);
  await page.click("#faq .faq-q");
  check(`${state}: faq opens`, await page.locator("#faq .faq-a:visible").count(), 1);
  await shot("help");

  // Nothing may overflow the panel horizontally at the window's real width.
  check(`${state}: no sideways overflow`, await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);

  // A token defined only in the light block leaves an element transparent or its text unreadable.
  const paint = await page.evaluate(() => {
    const read = (sel) => {
      const c = getComputedStyle(document.querySelector(sel));
      return { bg: c.backgroundColor, fg: c.color };
    };
    // Not body: the Electron window is transparent by design and the panel does the painting.
    return { panel: read(".panel"), pill: read(".pill"), send: read(".send"), chip: read(".chip") };
  });
  for (const [name, { bg, fg }] of Object.entries(paint)) {
    check(`${state}: ${name} has a background`, /rgba?\([^)]*?(,\s*0)\)$/.test(bg), false);
    const ratio = contrast(bg, fg);
    check(`${state}: ${name} text is readable (${ratio.toFixed(1)}:1)`, ratio >= 4.5, true);
  }

  check(`${state}: console clean`, noise, []);
  await page.close();
}
}

await browser.close();

if (failures.length) {
  console.error("smoke failed:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log("smoke passed: views switch cleanly, setup and help render, console clean");
