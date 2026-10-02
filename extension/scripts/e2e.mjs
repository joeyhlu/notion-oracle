/**
 * End-to-end check of the built extension in a real Chromium.
 *
 * Loads dist/ unpacked, serves a mock Notion page whose editor behaves like Notion's (a paste of
 * Markdown becomes blocks), and answers the Claude and Notion APIs from scripts, so every
 * feature runs for real: install opens setup, keys are checked, the AI menu edits and inserts,
 * the chat reads the page, searches the web, mentions pages, creates a page and undoes it.
 *
 *   npm run e2e                          # build, then run
 *   node scripts/e2e.mjs --out shots     # also save screenshots
 *   CHROMIUM_PATH=/path/to/chrome npm run e2e
 */
import { chromium } from "playwright";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EXT = resolve("dist");
const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;
if (OUT) mkdirSync(OUT, { recursive: true });
const { version } = JSON.parse(readFileSync("package.json", "utf8"));

const failures = [];
const passes = [];
function check(label, ok, detail = "") {
  if (ok) passes.push(label);
  else failures.push(`${label}${detail ? `: ${detail}` : ""}`);
}
const eq = (label, actual, expected) => check(label, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// ---------- colour ----------

function parse(rgb) {
  const n = rgb.match(/[\d.]+/g).map(Number);
  return { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 };
}
function over(fg, bg) {
  const f = parse(fg), b = parse(bg);
  return `rgb(${f.r * f.a + b.r * (1 - f.a)}, ${f.g * f.a + b.g * (1 - f.a)}, ${f.b * f.a + b.b * (1 - f.a)})`;
}
function luminance(rgb) {
  const { r, g, b } = parse(rgb);
  const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------- the mock Notion page ----------

const PAGE_ID = "0123456789abcdef0123456789abcdef";
const blockId = (n) => `${String(n).padStart(8, "0")}aaaabbbbccccdddd00000000`.slice(0, 32);

function notionPage(dark) {
  return `<!doctype html><html><head><title>Q3 Planning | Notion</title><style>
  body { margin: 0; font: 16px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Helvetica, sans-serif; background: #fff; color: #37352f; }
  body.dark { background: #191919; color: rgba(255,255,255,.81); }
  .notion-frame { max-width: 720px; margin: 0 auto; padding: 72px 48px; }
  .notion-page-block h1 { font-size: 40px; margin: 0 0 24px; font-weight: 700; }
  [data-block-id] { padding: 3px 2px; }
  [contenteditable] { outline: none; }
  .notion-header-block { font-size: 1.5em; font-weight: 600; margin-top: 1.2em; }
  </style></head>
  <body class="notion-body${dark ? " dark" : ""}"><div class="notion-frame">
    <div class="notion-page-block"><h1 contenteditable="true">Q3 Planning</h1></div>
    <div class="notion-page-content">
      <div class="notion-header-block" data-block-id="${blockId(1)}"><div contenteditable="true">Goals</div></div>
      <div class="notion-text-block" data-block-id="${blockId(2)}"><div contenteditable="true">We need to ship the onboarding flow before the end of the quarter, which is a lot of work but very important for growth.</div></div>
      <div class="notion-text-block" data-block-id="${blockId(3)}"><div contenteditable="true">Sam owns the pricing page.</div></div>
      <div class="notion-text-block" data-block-id="${blockId(4)}"><div contenteditable="true"></div></div>
    </div>
  </div>
  <script>
    // Notion parses a plain-text paste as Markdown blocks: the first line joins the block at the
    // caret, every further line becomes a new block after it.
    let next = 100;
    document.addEventListener("paste", (e) => {
      const target = e.target.closest && e.target.closest("[contenteditable]");
      if (!target) return;
      e.preventDefault();
      const lines = e.clipboardData.getData("text/plain").split("\\n");
      const sel = getSelection();
      const range = sel.getRangeAt(0);
      range.deleteContents();
      if (lines[0]) range.insertNode(document.createTextNode(lines[0].replace(/^[-#>*\\s]+/, "")));
      let after = target.closest("[data-block-id]");
      for (const line of lines.slice(1)) {
        if (!line.trim()) continue;
        const block = document.createElement("div");
        block.className = "notion-text-block";
        block.dataset.blockId = (String(next++).padStart(8, "0") + "eeeeffff0000111122223333").slice(0, 32);
        const leaf = document.createElement("div");
        leaf.contentEditable = "true";
        leaf.textContent = line.replace(/^[-#>*\\s]+/, "");
        block.append(leaf);
        after.after(block);
        after = block;
      }
    });
  </script></body></html>`;
}

// ---------- the mock Claude API ----------

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const requests = [];

/** Streams a message made of the given blocks. Text blocks stream as one delta. */
function message(model, blocks, stop) {
  const events = [{ type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }];
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "tool_use" || block.type === "server_tool_use") {
      events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } });
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    } else {
      events.push({ type: "content_block_start", index, content_block: block });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  events.push({ type: "message_stop" });
  return sse(events);
}

function lastUserText(body) {
  const last = body.messages[body.messages.length - 1];
  if (typeof last.content === "string") return last.content;
  return last.content.map((b) => b.text ?? (b.type === "tool_result" ? `[tool_result ${b.content}]` : "")).join("\n");
}

function firstUserText(body) {
  const first = body.messages.find((m) => m.role === "user" && typeof m.content === "string");
  return first?.content ?? "";
}

/** The scripted model. */
function brain(body) {
  const system = body.system?.[0]?.text ?? "";
  const last = lastUserText(body);
  const inline = system.includes("writing assistant inside the user's Notion page");
  if (inline) {
    if (/Apply this to your previous result/.test(last)) return [[{ type: "text", text: "A much shorter revision." }], "end_turn"];
    if (/noticeably shorter/.test(last)) return [[{ type: "text", text: "Ship onboarding this quarter: it drives growth." }], "end_turn"];
    if (/Translate the text into Spanish/.test(last)) return [[{ type: "text", text: "Sam es responsable de la página de precios." }], "end_turn"];
    if (/Continue writing/.test(last)) return [[{ type: "text", text: "- Hire a designer for onboarding\n- Review pricing with Sam" }], "end_turn"];
    if (/blog post/i.test(last)) return [[{ type: "text", text: "# Why onboarding matters\n\nFirst impressions decide retention." }], "end_turn"];
    return [[{ type: "text", text: "Generic answer." }], "end_turn"];
  }
  const ask = firstUserText(body.messages.length ? { messages: [body.messages[body.messages.length - 1]] } : body) || last;
  const turnText = typeof body.messages[body.messages.length - 1].content === "string" ? last : null;
  if (turnText !== null) {
    if (/Summarize this page/.test(turnText)) return [[{ type: "tool_use", id: "toolu_read", name: "read_current_page", input: {} }], "tool_use"];
    if (/latest news/.test(turnText)) {
      return [[
        { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "notion latest news" } },
        { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://example.com/notion-news", title: "Notion ships a thing", encrypted_content: "x", page_age: null }] },
        { type: "text", text: "Notion shipped a thing this week." },
      ], "end_turn"];
    }
    if (/create a page called Q4 Plan/.test(turnText)) return [[{ type: "tool_use", id: "toolu_create", name: "create_page", input: { title: "Q4 Plan", content_markdown: "# Goals" } }], "tool_use"];
    if (/Mentioned pages/.test(turnText)) return [[{ type: "text", text: "The roadmap mentions three launches." }], "end_turn"];
    return [[{ type: "text", text: `You said: ${ask.split("\n").pop()}` }], "end_turn"];
  }
  // After a tool result.
  if (/toolu_read/.test(JSON.stringify(body.messages[body.messages.length - 1]))) return [[{ type: "text", text: "**Summary**\n\n- Ship onboarding this quarter\n- Sam owns pricing" }], "end_turn"];
  if (/toolu_create/.test(JSON.stringify(body.messages[body.messages.length - 1]))) return [[{ type: "text", text: "Created [Q4 Plan](https://www.notion.so/Q4-Plan-11112222333344445555666677778888)." }], "end_turn"];
  return [[{ type: "text", text: "Done." }], "end_turn"];
}

// ---------- the mock Notion API ----------

const notionCalls = [];
const pageObject = (id, title) => ({
  object: "page", id, url: `https://www.notion.so/${title.replace(/\s/g, "-")}-${id.replace(/-/g, "")}`, archived: false, in_trash: false,
  parent: { type: "workspace", workspace: true }, last_edited_time: "2026-10-01T10:00:00.000Z",
  properties: { title: { id: "title", type: "title", title: [{ type: "text", plain_text: title, text: { content: title } }] } },
});

async function notionRoute(route) {
  const req = route.request();
  const url = new URL(req.url());
  notionCalls.push(`${req.method()} ${url.pathname}`);
  const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  if (url.pathname === "/v1/users/me") return json({ object: "user", id: "u1", name: "Oracle", type: "bot" });
  if (url.pathname === "/v1/search") {
    const query = (req.postDataJSON()?.query ?? "").toLowerCase();
    const all = [pageObject("aaaa1111-2222-3333-4444-555566667777", "Roadmap"), pageObject("bbbb1111-2222-3333-4444-555566667777", "Q3 Planning"), pageObject("cccc1111-2222-3333-4444-555566667777", "Meeting notes")];
    return json({ object: "list", results: all.filter((p) => p.properties.title.title[0].plain_text.toLowerCase().includes(query)), has_more: false, next_cursor: null });
  }
  if (url.pathname === "/v1/pages" && req.method() === "POST") return json(pageObject("11112222-3333-4444-5555-666677778888", "Q4 Plan"));
  if (url.pathname.startsWith("/v1/pages/")) return json({ ...pageObject(url.pathname.split("/")[3], "Q4 Plan"), archived: req.method() === "PATCH" });
  if (/^\/v1\/blocks\/[^/]+$/.test(url.pathname) && req.method() === "GET") {
    return json({ object: "block", id: url.pathname.split("/")[3], type: "paragraph", parent: { type: "page_id", page_id: PAGE_ID }, paragraph: { rich_text: [] } });
  }
  if (/\/children$/.test(url.pathname) && req.method() === "PATCH") {
    const children = req.postDataJSON()?.children ?? [];
    return json({ object: "list", results: children.map((c, i) => ({ object: "block", id: `9999000${i}-0000-0000-0000-000000000000`, type: c.type })), has_more: false, next_cursor: null });
  }
  if (url.pathname.startsWith("/v1/blocks/")) return json({ object: "list", results: [], has_more: false, next_cursor: null });
  return json({ object: "error", status: 404, code: "object_not_found", message: `Mock has no ${url.pathname}` }, 404);
}

// ---------- run ----------

const userDir = mkdtempSync(join(tmpdir(), "oracle-e2e-"));
const context = await chromium.launchPersistentContext(userDir, {
  // Extensions need full Chromium; Playwright's default headless shell cannot load them.
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chromium" }),
  headless: true,
  viewport: { width: 1280, height: 860 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new"],
});
const errors = [];
const watch = (page) => {
  page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|ERR_|favicon/i.test(m.text())) errors.push(`${page.url()}: ${m.text()}`);
  });
};
context.on("page", watch);

await context.route("https://www.notion.so/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: notionPage(new URL(route.request().url()).searchParams.has("dark")) }));
await context.route("https://api.notion.com/**", notionRoute);
await context.route("https://api.anthropic.com/**", async (route) => {
  const req = route.request();
  if (req.method() === "GET" && /\/v1\/models\//.test(req.url())) {
    const ok = (req.headers()["x-api-key"] ?? "").startsWith("sk-ant-good");
    return ok
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-09-01T00:00:00Z" }) })
      : route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) });
  }
  const body = req.postDataJSON();
  requests.push({ body, headers: req.headers() });
  const [blocks, stop] = brain(body);
  await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: message(body.model, blocks, stop) });
});

try {
  // ---- install opens setup ----
  let worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extId = new URL(worker.url()).host;
  let setup = context.pages().find((p) => p.url().includes("options.html"));
  if (!setup) setup = await context.waitForEvent("page", { predicate: (p) => p.url().includes("options.html"), timeout: 5000 }).catch(() => null);
  check("installing opens the setup page", Boolean(setup && setup.url().includes("welcome=1")), setup?.url() ?? "no page");
  if (!setup) {
    setup = await context.newPage();
    await setup.goto(`chrome-extension://${extId}/options.html?welcome=1`);
  }
  await setup.waitForLoadState();
  eq("setup shows the version", (await setup.locator("[data-version]").textContent()).trim(), version);
  await setup.waitForTimeout(300);
  eq("the key field has focus on a fresh install", await setup.evaluate(() => document.activeElement?.id), "anthropicApiKey");

  // A wrong key is reported, a right one goes green, and nothing needs a Save button.
  await setup.fill("#anthropicApiKey", "sk-ant-bad");
  await setup.waitForSelector("#check-ai.err", { timeout: 5000 });
  check("a rejected key says so", /rejected the API key/.test(await setup.textContent("#check-ai")), await setup.textContent("#check-ai"));
  await setup.fill("#anthropicApiKey", "sk-ant-good-key");
  await setup.waitForSelector("#check-ai.ok", { timeout: 5000 });
  check("a working key names the model", /Claude Opus 5\.5/.test(await setup.textContent("#check-ai")));
  eq("step one turns done", await setup.locator("#step-ai.done").count(), 1);
  await setup.fill("#notionToken", "ntn_good");
  await setup.waitForSelector("#check-notion.ok", { timeout: 5000 });
  check("Notion check lists the pages it can see", (await setup.locator("#notion-pages li").allTextContents()).includes("Roadmap"));
  check("a rejected-then-fixed key leaves no red tag", !(await setup.locator("#prop-ai.bad").count()));
  eq("the page properties show both connections", [await setup.textContent("#prop-ai"), await setup.textContent("#prop-notion")], ["Connected", "Connected"]);
  await setup.click("label.setting:has(#bulkEdit)");
  await setup.waitForTimeout(400);
  eq("a settings row toggles its switch", await setup.evaluate(() => chrome.storage.local.get("settings").then((s) => s.settings.bulkEdit)), false);
  await setup.click("label.setting:has(#bulkEdit)");
  await setup.waitForTimeout(400);
  const saved = await setup.evaluate(() => chrome.storage.local.get("settings").then((s) => s.settings));
  eq("settings save without a Save button", [saved?.anthropicApiKey, saved?.notionToken, saved?.anthropicModel], ["sk-ant-good-key", "ntn_good", "claude-opus-5-5"]);
  if (OUT) await setup.screenshot({ path: `${OUT}/setup.png`, fullPage: true });

  // ---- the page ----
  const page = await context.newPage();
  await page.goto(`https://www.notion.so/Q3-Planning-${PAGE_ID}`);
  await page.waitForSelector("#notion-oracle-host", { state: "attached", timeout: 10000 });
  await page.waitForTimeout(400);
  const host = page.locator("#notion-oracle-host");
  check("the floating button shows", await host.locator(".fab").isVisible());
  // A tooltip rule once overrode its position: fixed and left it half off the left edge.
  const fabBox = await host.locator(".fab").boundingBox();
  check("the floating button sits in the bottom-right corner", fabBox && fabBox.x > 1280 - 80 && fabBox.y > 860 - 140 && fabBox.x + fabBox.width <= 1280, JSON.stringify(fabBox));

  // ---- AI menu on a selection: make shorter, then replace ----
  await page.evaluate((id) => {
    const leaf = document.querySelector(`[data-block-id="${id}"] [contenteditable]`);
    leaf.focus();
    const range = document.createRange();
    range.selectNodeContents(leaf);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, blockId(2));
  await page.waitForTimeout(150);
  check("selecting text shows the Ask AI button", await host.locator(".bubble").isVisible());
  if (OUT) await page.screenshot({ path: `${OUT}/bubble.png` });
  await host.locator(".bubble").dispatchEvent("mousedown");
  await page.waitForTimeout(100);
  check("the button opens the AI menu", await host.locator(".ai").isVisible());
  check("the selection stays highlighted while the menu is open", await page.evaluate(() => CSS.highlights.has("oracle-selection")));
  const menuLabels = await host.locator(".ai-item .grow").allTextContents();
  for (const label of ["Improve writing", "Fix spelling & grammar", "Make shorter", "Make longer", "Change tone", "Simplify language", "Translate", "Explain this", "Summarize", "Find action items", "Continue writing"]) {
    check(`the selection menu offers ${label}`, menuLabels.includes(label));
  }
  if (OUT) await page.screenshot({ path: `${OUT}/ai-menu.png` });
  await host.locator(".ai-bar input").fill("short");
  eq("typing filters the menu", (await host.locator(".ai-item .grow").allTextContents()).slice(0, 2), ["short", "Make shorter"]);
  await host.locator(".ai-bar input").press("ArrowDown");
  await host.locator(".ai-bar input").press("Enter");
  await host.locator(".ai-result .body").getByText("Ship onboarding this quarter").waitFor({ timeout: 5000 });
  const inlineReq = requests[requests.length - 1].body;
  check("the AI menu sends no tools", !inlineReq.tools);
  check("the AI menu sends the selection, not the page", /<selection>/.test(lastUserText(inlineReq)) && !/<page>/.test(lastUserText(inlineReq)));
  eq("the result offers Replace first", (await host.locator(".ai-item .grow").allTextContents())[0], "Replace selection");
  if (OUT) await page.screenshot({ path: `${OUT}/ai-result.png` });
  // Follow-up instruction revises the result.
  await host.locator(".ai-bar input").fill("even shorter");
  await host.locator(".ai-bar input").press("Enter");
  await host.locator(".ai-result .body").getByText("A much shorter revision").waitFor({ timeout: 5000 });
  check("a follow-up continues the same thread", requests[requests.length - 1].body.messages.length === 3);
  await host.locator(".ai-bar input").press("Enter");
  await page.waitForTimeout(500);
  eq("Replace writes into the page", (await page.locator(`[data-block-id="${blockId(2)}"]`).innerText()).trim(), "A much shorter revision.");
  check("the menu closes after replacing", !(await host.locator(".ai").isVisible()));
  check("closing the menu clears the highlight", !(await page.evaluate(() => CSS.highlights.has("oracle-selection"))));

  // ---- AI menu: translate via the submenu ----
  await page.evaluate((id) => {
    const leaf = document.querySelector(`[data-block-id="${id}"] [contenteditable]`);
    leaf.focus();
    const range = document.createRange();
    range.selectNodeContents(leaf);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }, blockId(3));
  await page.keyboard.press("Control+J");
  await page.waitForTimeout(100);
  check("Ctrl+J on a selection opens the menu", await host.locator(".ai").isVisible());
  await host.locator(".ai-bar input").fill("translate");
  await host.locator(".ai-bar input").press("ArrowDown");
  await host.locator(".ai-bar input").press("ArrowRight");
  await host.locator(".ai-bar input").fill("span");
  eq("the language list filters", await host.locator(".ai-item .grow").allTextContents(), ["Translate", "Spanish"]);
  await host.locator(".ai-bar input").press("ArrowDown");
  await host.locator(".ai-bar input").press("Enter");
  await host.locator(".ai-result .body").getByText("Sam es responsable").waitFor({ timeout: 5000 });
  await host.locator(".ai-bar input").press("Enter");
  await page.waitForTimeout(500);
  eq("translating replaces the selection", (await page.locator(`[data-block-id="${blockId(3)}"]`).innerText()).trim(), "Sam es responsable de la página de precios.");

  // ---- AI menu at the cursor: continue writing, insert below ----
  await page.evaluate((id) => {
    const leaf = document.querySelector(`[data-block-id="${id}"] [contenteditable]`);
    leaf.focus();
    const range = document.createRange();
    range.selectNodeContents(leaf);
    range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }, blockId(3));
  await page.keyboard.press("Control+J");
  await page.waitForTimeout(100);
  const cursorLabels = await host.locator(".ai-item .grow").allTextContents();
  check("the cursor menu offers drafts", ["Continue writing", "Brainstorm ideas", "Blog post", "Meeting agenda", "Email"].every((l) => cursorLabels.includes(l)));
  check("the cursor menu leaves out selection edits", !cursorLabels.includes("Make shorter"));
  await host.locator(".ai-bar input").fill("continue");
  await host.locator(".ai-bar input").press("ArrowDown");
  await host.locator(".ai-bar input").press("Enter");
  await host.locator(".ai-result .body").getByText("Hire a designer").waitFor({ timeout: 5000 });
  check("continue writing sends the page", /<page>/.test(lastUserText(requests[requests.length - 1].body)));
  eq("at the cursor the result offers Insert first", (await host.locator(".ai-item .grow").allTextContents())[0], "Insert below");
  const blocksBefore = await page.locator(".notion-page-content [data-block-id]").count();
  await host.locator(".ai-bar input").press("Enter");
  await page.waitForTimeout(500);
  const texts = (await page.locator(".notion-page-content [data-block-id]").allInnerTexts()).map((t) => t.trim());
  check("Insert below adds blocks after the line", texts.length === blocksBefore + 2 && texts.indexOf("Hire a designer for onboarding") === texts.indexOf("Sam es responsable de la página de precios.") + 1, JSON.stringify(texts));

  // ---- a draft fills a prefix to finish ----
  await page.evaluate((id) => {
    const leaf = document.querySelector(`[data-block-id="${id}"] [contenteditable]`);
    leaf.focus();
    const range = document.createRange();
    range.selectNodeContents(leaf);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }, blockId(4));
  await page.keyboard.press("Control+J");
  await host.locator(".ai-bar input").fill("blog");
  await host.locator(".ai-bar input").press("ArrowDown");
  await host.locator(".ai-bar input").press("Enter");
  eq("a draft puts its opening in the box", await host.locator(".ai-bar input").inputValue(), "Write a blog post about ");
  await host.locator(".ai-bar input").press("End");
  await host.locator(".ai-bar input").type("onboarding");
  await host.locator(".ai-bar input").press("Enter");
  await host.locator(".ai-result .body").getByText("Why onboarding matters").waitFor({ timeout: 5000 });
  await host.locator(".ai-bar input").press("Enter");
  await page.waitForTimeout(500);
  eq("a draft on an empty line writes into that line", await page.locator(`[data-block-id="${blockId(4)}"]`).innerText(), "Why onboarding matters");
  // When Notion's editor will not take the text, Insert below writes it through the API.
  await page.evaluate((id) => {
    const leaf = document.querySelector(`[data-block-id="${id}"] [contenteditable]`);
    leaf.focus();
    const range = document.createRange();
    range.selectNodeContents(leaf);
    range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }, blockId(1));
  await page.keyboard.press("Control+J");
  await host.locator(".ai-bar input").fill("continue");
  await host.locator(".ai-bar input").press("ArrowDown");
  await host.locator(".ai-bar input").press("Enter");
  await host.locator(".ai-result .body").getByText("Hire a designer").waitFor({ timeout: 5000 });
  await page.evaluate((id) => document.querySelector(`[data-block-id="${id}"] [contenteditable]`).setAttribute("contenteditable", "false"), blockId(1));
  await host.locator(".ai-bar input").press("Enter");
  await host.locator(".toast", { hasText: "Inserted below" }).waitFor({ timeout: 5000 });
  check("the API fallback inserts after the right block", notionCalls.includes(`GET /v1/blocks/${blockId(1).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5")}`) && notionCalls.includes(`PATCH /v1/blocks/${PAGE_ID.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5")}/children`), notionCalls.join(", "));
  await page.evaluate((id) => document.querySelector(`[data-block-id="${id}"] [contenteditable]`).setAttribute("contenteditable", "true"), blockId(1));

  await page.keyboard.press("Control+J");
  await host.locator(".ai-bar input").press("Escape");
  check("Escape closes the menu", !(await host.locator(".ai").isVisible()));

  // ---- chat ----
  await page.keyboard.press("Control+Shift+Space");
  await page.waitForTimeout(200);
  const chat = host.locator(".chat");
  check("the shortcut opens the chat", await chat.evaluate((n) => n.classList.contains("open")));
  check("the floating button hides while the chat is open", !(await host.locator(".fab").isVisible()));
  eq("the header names the model", await host.locator(".head .model").textContent(), "Opus 5.5");
  check("the page chip names the page", /Q3 Planning/.test(await host.locator(".context .chip").first().textContent()));
  check("welcome shows the version", (await host.locator(".welcome .version").textContent()).includes(version));
  if (OUT) await page.screenshot({ path: `${OUT}/chat-empty.png` });
  await host.locator(".suggestion", { hasText: "Summarize this page" }).click();
  await host.locator(".msg.assistant .body").getByText("Sam owns pricing").waitFor({ timeout: 8000 });
  const chatReq = requests.find((r) => /Summarize this page/.test(firstUserText(r.body)))?.body;
  eq("chat uses Opus 5.5", chatReq?.model, "claude-opus-5-5");
  eq("chat sets effort explicitly", chatReq?.output_config, { effort: "medium" });
  check("chat turns on refusal fallbacks", chatReq?.fallbacks === "default");
  const chatHeaders = requests.find((r) => /Summarize this page/.test(firstUserText(r.body)))?.headers ?? {};
  check("chat sends the fallback beta header", /server-side-fallback-2026-07-01/.test(chatHeaders["anthropic-beta"] ?? ""));
  check("chat offers web search at the right version", chatReq?.tools?.some((t) => t.type === "web_search_20260209"));
  check("with Notion connected the chat gets workspace tools", ["search_page_contents", "set_database_rows", "create_page"].every((n) => chatReq?.tools?.some((t) => t.name === n)));
  check("the reply shows what it did in words", /Read this page/.test(await host.locator(".activity summary").first().textContent()));
  check("suggestions go after the first message", (await host.locator(".suggestion").count()) === 0);
  if (OUT) await page.screenshot({ path: `${OUT}/chat-reply.png` });

  // web search with sources
  const input = host.locator(".composer textarea");
  await input.fill("what is the latest news about notion");
  await input.press("Enter");
  await host.locator(".sources a").first().waitFor({ timeout: 8000 });
  eq("web answers list their sources", await host.locator(".sources a").first().textContent(), "Notion ships a thing");
  check("the web search shows as an action", /Searched the web for/.test((await host.locator(".activity summary").allTextContents()).join(" ")));
  // The web toggle turns search off for the next message.
  await host.locator(".toggle", { hasText: "Web" }).click();
  await input.fill("hello without web");
  await input.press("Enter");
  await host.locator(".msg.assistant .body").getByText("You said: hello without web").waitFor({ timeout: 8000 });
  check("switching Web off drops the search tool", !requests[requests.length - 1].body.tools?.some((t) => t.name === "web_search"));

  // @-mention
  await input.fill("@Road");
  await host.locator(".picker-item", { hasText: "Roadmap" }).waitFor({ timeout: 5000 });
  await input.press("Enter");
  check("choosing a page adds a chip", (await host.locator(".context .chip").allTextContents()).some((t) => t.includes("Roadmap")));
  await input.fill("what does it say?");
  await input.press("Enter");
  await host.locator(".msg.assistant .body").getByText("three launches").waitFor({ timeout: 8000 });
  check("the mention reaches the model", /Mentioned pages:\n- Roadmap \(page id aaaa1111/.test(firstUserText({ messages: [requests[requests.length - 1].body.messages.at(-1)] })));

  // a change, then undo
  await input.fill("create a page called Q4 Plan");
  await input.press("Enter");
  await host.locator(".changed").waitFor({ timeout: 8000 });
  check("a change is announced under the reply", /Changed 1 thing in Notion/.test(await host.locator(".changed").textContent()));
  await host.locator(".changed .link").click();
  await host.locator(".tab.on", { hasText: "Changes" }).waitFor();
  check("the change is listed", (await host.locator(".row .t").allTextContents()).some((t) => /Q4 Plan/.test(t)));
  if (OUT) await page.screenshot({ path: `${OUT}/changes.png` });
  await host.locator(".row .btn", { hasText: "Undo" }).first().click();
  await host.locator(".row.undone").first().waitFor({ timeout: 5000 });
  check("undo archives the created page", notionCalls.includes("PATCH /v1/pages/11112222-3333-4444-5555-666677778888"));

  // chats are saved and reopen
  await host.locator(".tab", { hasText: "Chats" }).click();
  await host.locator(".row .t").first().waitFor();
  eq("the chat is saved under its first message", await host.locator(".row .t").first().textContent(), "Summarize this page in a few bullet points.");
  if (OUT) await page.screenshot({ path: `${OUT}/history.png` });
  await host.locator('[aria-label="New chat"]').click();
  check("a new chat brings back the suggestions", (await host.locator(".suggestion").count()) > 0);
  await host.locator('[aria-label="Chats and changes"]').click();
  await host.locator(".row .main").first().click();
  await host.locator(".msg.assistant .body").getByText("Sam owns pricing").waitFor({ timeout: 3000 });
  check("reopening a chat restores the conversation", (await host.locator(".msg.user").count()) >= 4);
  await input.fill("and one more");
  await input.press("Enter");
  await host.locator(".msg.assistant .body").getByText("You said: and one more").waitFor({ timeout: 8000 });
  check("a reopened chat continues with its history", requests[requests.length - 1].body.messages.length > 5);

  // docking
  await host.locator('[aria-label="Dock to the side"]').click();
  check("the chat docks to the side", await chat.evaluate((n) => n.classList.contains("side") && Math.round(n.getBoundingClientRect().height) === innerHeight));
  if (OUT) await page.screenshot({ path: `${OUT}/chat-docked.png` });
  await host.locator('[aria-label="Float the window"]').click();
  await input.press("Escape");
  check("Escape closes the chat and brings back the button", !(await chat.evaluate((n) => n.classList.contains("open"))) && (await host.locator(".fab").isVisible()));

  // ---- contrast, light and dark ----
  for (const dark of [false, true]) {
    const p = dark ? await context.newPage() : page;
    if (dark) {
      await p.goto(`https://www.notion.so/Q3-Planning-${PAGE_ID}?dark=1`);
      await p.waitForSelector("#notion-oracle-host", { state: "attached" });
      await p.waitForTimeout(300);
      check("Oracle follows Notion's dark theme", await p.evaluate(() => document.getElementById("notion-oracle-host").classList.contains("dark")));
    }
    await p.keyboard.press("Control+Shift+Space");
    await p.waitForTimeout(250);
    await p.locator('#notion-oracle-host [aria-label="New chat"]').click();
    const colours = await p.evaluate(() => {
      const root = document.getElementById("notion-oracle-host").shadowRoot;
      const read = (sel) => {
        const n = root.querySelector(sel);
        const cs = getComputedStyle(n);
        return { fg: cs.color, bg: cs.backgroundColor };
      };
      return { chat: read(".chat"), welcome: read(".welcome p:not(.who)"), send: read(".send"), chip: read(".chip"), suggestion: read(".suggestion") };
    });
    const ground = colours.chat.bg;
    const pairs = {
      "chat text": [over(colours.chat.fg, ground), ground],
      "secondary text": [over(colours.welcome.fg, ground), ground],
      "send button": [colours.send.fg, colours.send.bg],
      "chips": [over(colours.chip.fg, over(colours.chip.bg, ground)), over(colours.chip.bg, ground)],
    };
    for (const [name, [fg, bg]] of Object.entries(pairs)) {
      const ratio = contrast(fg, bg);
      check(`${dark ? "dark" : "light"}: ${name} contrast ≥ 4.5`, ratio >= 4.5, ratio.toFixed(2));
    }
    if (OUT && dark) await p.screenshot({ path: `${OUT}/chat-dark.png` });
    if (dark) {
      await p.evaluate(() => {
        const leaf = document.querySelectorAll(".notion-page-content [contenteditable]")[1];
        const range = document.createRange();
        range.selectNodeContents(leaf);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      });
      await p.keyboard.press("Control+Shift+Space");
      await p.waitForTimeout(150);
      await p.locator("#notion-oracle-host .bubble").dispatchEvent("mousedown");
      await p.waitForTimeout(150);
      if (OUT) await p.screenshot({ path: `${OUT}/ai-menu-dark.png` });
      await p.close();
    }
  }

  // ---- unconfigured: the chat says how to start ----
  await setup.fill("#anthropicApiKey", "");
  await setup.waitForTimeout(500);
  const fresh = await context.newPage();
  await fresh.goto(`https://www.notion.so/Q3-Planning-${PAGE_ID}`);
  await fresh.waitForSelector("#notion-oracle-host", { state: "attached" });
  await fresh.waitForTimeout(300);
  await fresh.keyboard.press("Control+Shift+Space");
  await fresh.waitForTimeout(200);
  check("without a key the chat points to setup", await fresh.locator("#notion-oracle-host .setup-card").isVisible());

  // Install and update inject into every open Notion tab; a tab that already has Oracle must not
  // end up with two.
  const notionTabs = await setup.evaluate(async () => (await chrome.tabs.query({ url: "https://www.notion.so/*" })).map((t) => t.id));
  await setup.evaluate((ids) => Promise.all(ids.map((id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ["content.js"] }))), notionTabs);
  await fresh.waitForTimeout(300);
  eq("injecting again leaves exactly one Oracle on the page", await fresh.locator("#notion-oracle-host").count(), 1);

  worker = context.serviceWorkers()[0];
  check("the service worker is still alive", Boolean(worker));
  eq("no console errors", errors, []);
} catch (error) {
  failures.push(`crashed: ${error.stack ?? error}`);
} finally {
  await context.close();
  rmSync(userDir, { recursive: true, force: true });
}

console.log(`${passes.length} checks passed`);
if (failures.length) {
  console.error(`${failures.length} failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("e2e passed: install, setup, AI menu, chat, web, mentions, undo, history, themes");
