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
    getPageHint: async () => window.__hint ?? null,
    testNotion: async () => ({ ok: true, message: "Connected" }),
    chatSend: async () => {}, chatAbort: async () => {},
    getChanges: async () => window.__changes ?? [],
    undoChange: async (id) => {
      window.__changes = (window.__changes ?? []).map((c) => (c.id === id ? { ...c, undone: true } : c));
      return { ok: true, message: "Removed." };
    },
    clearChanges: async () => { window.__changes = []; },
    listConversations: async () => window.__conversations ?? [],
    getConversation: async (id) => (window.__saved ?? {})[id] ?? null,
    deleteConversation: async (id) => {
      window.__conversations = (window.__conversations ?? []).filter((c) => c.id !== id);
    },
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
  /**
   * Which views the browser is actually painting. Derived from the DOM rather than a list here:
   * a hard-coded list silently stops covering any view added later, which is exactly the kind of
   * gap that let three stacked views ship.
   */
  const shown = () => page.evaluate(() => [...document.querySelectorAll(".view")]
    .filter((el) => getComputedStyle(el).display !== "none").map((el) => el.id));
  const displayed = (id) => page.evaluate(
    (x) => getComputedStyle(document.getElementById(x)).display !== "none", id);
  const shot = (name) => out && page.screenshot({ path: join(out, `${state}-${name}.png`) });

  // The app opens on chat once setup is done, and on setup before that.
  await page.evaluate(() => {
    const setup = document.getElementById("view-setup");
    if (!setup.hidden) document.getElementById("btn-settings").click();
  });
  check(`${state}: chat only`, await shown(), ["view-chat"]);

  // The suggestions are an opener, not a permanent toolbar: they go once a turn has started.
  check(`${state}: suggestions on the empty chat`, await page.locator("#quick").isVisible(), true);
  await page.evaluate(() => {
    document.getElementById("input").value = "hello";
    document.getElementById("send").click();
  });
  await page.waitForFunction(() => document.getElementById("quick").hidden);
  check(`${state}: suggestions gone after sending`, await page.locator("#quick").isVisible(), false);
  // A new conversation is a first message again, so they come back.
  await page.click("#btn-new");
  check(`${state}: suggestions return on a new chat`, await page.locator("#quick").isVisible(), true);

  // Every header button names itself on hover, instantly and in the app's own style.
  const tips = await page.evaluate(() => [...document.querySelectorAll(".header [data-tip]")]
    .map((b) => b.dataset.tip));
  check(`${state}: every header button has a tip`, tips, ["New chat", "History", "Changes", "Help", "Setup", "Close"]);
  check(`${state}: tips are one or two words`, tips.every((t) => t.split(" ").length <= 2), true);
  check(`${state}: tip is hidden until hover`, await page.evaluate(
    () => getComputedStyle(document.getElementById("btn-help"), "::after").opacity), "0");
  await page.hover("#btn-help");
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById("btn-help"), "::after").opacity === "1");
  check(`${state}: tip appears on hover`, await page.evaluate(
    () => getComputedStyle(document.getElementById("btn-help"), "::after").content), '"Help"');
  // A tooltip that ran past the panel edge would be clipped away by its overflow:hidden.
  await page.hover("#btn-collapse");
  check(`${state}: the last tip stays inside the panel`, await page.evaluate(() => {
    const panel = document.querySelector(".panel").getBoundingClientRect();
    const btn = document.getElementById("btn-collapse").getBoundingClientRect();
    return btn.right <= panel.right;
  }), true);
  await page.mouse.move(0, 300);
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

  // The Changes view: an empty state, a row per change, and Undo that visibly takes effect.
  await page.evaluate(() => {
    window.__changes = [];
  });
  await page.click("#btn-changes");
  check(`${state}: changes only`, await shown(), ["view-changes"]);
  check(`${state}: empty state`, await page.locator("#changes .empty").count(), 1);

  await page.evaluate(() => {
    window.__changes = [
      { id: "c1", at: new Date().toISOString(), tool: "notion", kind: "block", action: "create",
        label: "Appended 3 blocks", target: "p1", url: "https://notion.so/p1",
        undo: { type: "delete-blocks", blockIds: ["a", "b", "c"] } },
      { id: "c2", at: new Date(Date.now() - 3.6e6).toISOString(), tool: "calendar", kind: "event",
        action: "delete", label: "Deleted \"Standup\"" },
    ];
  });
  // Leave and re-enter so the list re-reads the bridge.
  await page.click("#btn-changes");
  await page.click("#btn-changes");
  check(`${state}: a row per change`, await page.locator("#changes .change").count(), 2);
  // A change with no recorded reverse says so instead of offering a button that would fail.
  check(`${state}: unreversible change is labelled`, await page.locator("#changes .change-state").innerText(), "cannot undo");
  check(`${state}: relative time`, await page.locator("#changes .change-when").first().innerText(), "just now");

  await page.locator("#changes .change").first().getByText("Undo").click();
  await page.waitForFunction(() => document.querySelectorAll("#changes .change.undone").length === 1);
  check(`${state}: undo marks the row`, await page.locator("#changes .change.undone").count(), 1);
  await shot("changes");

  // History: an empty state, then a saved conversation that reopens with its transcript redrawn.
  await page.evaluate(() => { window.__conversations = []; });
  await page.click("#btn-history");
  check(`${state}: history only`, await shown(), ["view-history"]);
  check(`${state}: history empty state`, await page.locator("#history .empty").count(), 1);

  await page.evaluate(() => {
    window.__conversations = [{ id: "k1", title: "Summarize my notes", updatedAt: new Date().toISOString(), messageCount: 2 }];
    window.__saved = { k1: { id: "k1", threadId: "cli-1", title: "Summarize my notes", createdAt: "", updatedAt: "",
      messages: [{ role: "user", text: "Summarize my notes" }, { role: "assistant", text: "**Three** points." }] } };
  });
  await page.click("#btn-history");
  await page.click("#btn-history");
  check(`${state}: one row per conversation`, await page.locator("#history .change").count(), 1);
  await shot("history");

  await page.locator("#history .change-main").first().click();
  await page.waitForFunction(() => !document.getElementById("view-chat").hidden);
  check(`${state}: reopening returns to chat`, await shown(), ["view-chat"]);
  check(`${state}: transcript is redrawn`, await page.locator("#messages .msg").count(), 2);
  // Markdown is re-rendered, not shown as source.
  check(`${state}: reply keeps its formatting`, await page.locator("#messages .msg.assistant strong").innerText(), "Three");

  // A blocked window read has to be visible in the panel, not only in a reply.
  await page.evaluate(() => { window.__hint = { notionWindowTitle: null, windowStatus: "no-permission" }; });
  await page.click("#btn-history");
  await page.click("#btn-history");
  await page.waitForFunction(() => !document.getElementById("looking-at").hidden);
  check(`${state}: blocked read is shown`, await page.locator("#looking-at .warn").innerText(), "Can’t read the open page — ");
  await page.locator("#looking-at .link-btn").click();
  check(`${state}: it opens the right FAQ entry`, await page.evaluate(
    () => [...document.querySelectorAll("#faq .faq-item.open")].map((i) => i.dataset.faq)),
    ["window-permission"]);
  await page.evaluate(() => { window.__hint = null; });

  check(`${state}: console clean`, noise, []);
  await page.close();
}
}

/*
 * Appearance. The stylesheet has to win against the OS in both directions, and that is exactly
 * what a screenshot of either theme on its own cannot show: forcing light on a dark OS relies on
 * a :not() in the media query, and forcing dark on a light OS relies on a separate attribute
 * block. Each combination is rendered and the painted colour read back.
 */
{
  const page = await browser.newPage({ viewport: { width: 420, height: 620 } });
  await page.addInitScript(installBridge, true);

  /** The colour the panel actually paints under this OS setting and this explicit choice. */
  const paint = async (os, choice) => {
    await page.emulateMedia({ colorScheme: os });
    await page.evaluate((c) => {
      if (c === "system") delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = c;
    }, choice);
    return page.evaluate(() => getComputedStyle(document.querySelector(".panel")).backgroundColor);
  };

  await page.goto(page_url);
  await page.evaluate(() => { document.body.className = "expanded"; });

  const lightPaper = await paint("light", "system");
  const darkPaper = await paint("dark", "system");
  check("theme: the OS setting is followed by default", lightPaper !== darkPaper, true);
  check("theme: dark OS gives the dark panel", await paint("dark", "system"), darkPaper);
  check("theme: light is honoured on a dark OS", await paint("dark", "light"), lightPaper);
  check("theme: dark is honoured on a light OS", await paint("light", "dark"), darkPaper);
  check("theme: back to system follows the OS again", await paint("dark", "system"), darkPaper);

  // The control has to show which one is active, or the choice is invisible once made.
  await page.emulateMedia({ colorScheme: "light" });
  for (const choice of ["system", "light", "dark"]) {
    await page.evaluate((c) => {
      document.querySelector(`.seg[data-theme-value="${c}"]`).click();
    }, choice);
    check(`theme: ${choice} segment marked active`, await page.evaluate(
      () => [...document.querySelectorAll(".seg.active")].map((s) => s.dataset.themeValue)), [choice]);
    check(`theme: ${choice} applied to the document`, await page.evaluate(
      () => document.documentElement.dataset.theme ?? "system"), choice);
  }
  if (out) {
    await page.click("#btn-settings");
    await page.evaluate(() => document.getElementById("step-prefs").classList.add("open"));
    await page.screenshot({ path: join(out, "theme-control.png") });
  }
  await page.close();
}

await browser.close();

if (failures.length) {
  console.error("smoke failed:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log("smoke passed: views switch cleanly, setup and help render, console clean");
