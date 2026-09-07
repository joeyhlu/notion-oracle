/**
 * Renders the built panel in a real browser and asserts what a screenshot would have shown.
 *
 * The unit tests read the stylesheet; they cannot tell you that the page *looks* right. Version
 * 0.3.0 shipped with chat, setup and help drawn on top of each other because a class selector
 * outranked the `hidden` attribute — every test passed, and the panel was unusable. This is the
 * check that would have caught it, so it runs in CI.
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

for (const ready of [true, false]) {
  const state = ready ? "configured" : "fresh";
  const page = await browser.newPage({ viewport: { width: 420, height: 620 }, deviceScaleFactor: 2 });
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

  check(`${state}: console clean`, noise, []);
  await page.close();
}

await browser.close();

if (failures.length) {
  console.error("smoke failed:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log("smoke passed: views switch cleanly, setup and help render, console clean");
