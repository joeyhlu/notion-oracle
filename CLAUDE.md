# Notion Oracle — working notes

An AI overlay for the Notion desktop app that runs on the user's own Claude or ChatGPT
subscription. No API keys, no Notion AI add-on.

## Layout

- `desktop/` — the Electron app. This is the product.
- `extension/` — a Chrome MV3 side panel, API-key based. Shares the Notion tool layer with the
  desktop app: `extension/src/lib/` is imported by `desktop/src/mcp/notion-server.ts`, so a change
  there affects both. Run both test suites.

## How it works

Oracle never calls an LLM API. It drives the vendor's own CLI headless — Claude Code or Codex CLI,
whichever the user signed into — and hands it Notion and calendar tools through bundled MCP
servers. Those servers run as **child processes spawned by the CLI**, not by Electron, and receive
everything through environment variables:

| Variable | Set in | Read in |
|---|---|---|
| `NOTION_TOKEN` | `main/main.ts` `mcpSpecs()` | `mcp/notion-server.ts` |
| `ORACLE_JOURNAL` | same | `notion-server.ts`, `calendar-server.ts` |
| `ORACLE_CONTENT_SEARCH`, `ORACLE_BULK_EDIT` | same | `notion-server.ts` |
| `CALENDAR_BACKEND`, `CALENDAR_STATE_DIR`, … | same | `calendar-server.ts` |

A flag misspelled on one side fails silently — the feature simply never happens. Tests in
`tests/mcp-journal.test.ts` and `tests/optional-tools.test.ts` assert both sides agree.

The Notion API is pinned at version `2025-09-03`, the data-sources model. A database can have
several data sources; resolve with `resolveDataSource` before querying or writing.

## Commands

```bash
cd desktop
npm run check    # typecheck + build + 174 tests
npm run smoke    # renders the built panel in Chromium, both themes  (needs a browser, see below)
npm start        # run from source
cd ../extension && npm run check   # 41 tests
```

`npm test` runs against `dist/`, not `src/`. **Rebuild before testing a source change** or you are
testing the previous build. `npm run check` and `npm run smoke` both build first; bare
`node scripts/smoke.mjs` does not.

For the render check: `npx playwright install chromium` once, or set `CHROMIUM_PATH` to an existing
binary when the sandbox already has one.

## Traps that have each cost a broken release

**`-webkit-app-region` is inherited.** An element the OS treats as a title bar has its clicks
swallowed by the window manager before the page sees them, and a draggable *ancestor* is enough.
Playwright's synthetic clicks bypass that layer entirely, so a functional test passes while the
real button is dead. `tests/drag-regions.test.ts` reads the stylesheet instead. Only `.header` may
be a drag region.

**`[hidden]` loses to any class that sets `display`.** Version 0.3.0 shipped with chat, setup and
help drawn on top of each other because `.view.scroll { display: block }` outranked the user
agent's `[hidden]` rule. One `[hidden] { display: none !important }` settles it; do not reintroduce
per-rule specificity races.

**Notion cannot retype a block.** `PATCH /blocks/{id}` only rewrites a block as the type it already
is; anything else fails with "Block type mismatch". Converting a paragraph to a to-do means
inserting the replacement after it and archiving the original. `replaceBlock` does this.

**CI runs the desktop job on ubuntu only.** A platform-conditional assertion can therefore only
fail in the release workflow, which runs all three. That has happened; it cost a release with no
Windows installer.

**`normalizeId` rejects anything that is not a Notion UUID.** Test fixtures need real-shaped ids.

**Electron's transparent frameless window** breaks Playwright screenshots of the collapsed pill
(compositing never settles). Assert computed styles instead; it is a harness quirk, not a bug.

## Visual language

Three redesigns taught one lesson: the panel reads as generated when it tries to be **pretty**, and
reads as real when it tries to be **invisible**. It is a utility someone opens forty times a day.

- **No display typography.** Headings are 13px semibold in the same system sans as everything
  else. A serif heading on warm cream with a terracotta accent is the single most recognisable
  signature of a generated interface — it was here at v0.6.1 and the user rejected it. Do not
  reintroduce a serif, a 22px heading, or a "hero" greeting.
- **13px base, tight rhythm.** Real desktop tools are compact. Space goes between groups, not
  everywhere uniformly. All five setup steps must fit without scrolling at the default height.
- **Warm neutrals, kept.** `#faf9f5` / `#262624` grounds; greys are the ink at low alpha so they
  tint against their surface. This is the one thing carried over from the Claude pass, because a
  cold grey is harsher than it needs to be beside Notion all day.
- **Colour carries meaning only.** Terracotta on the send button and links; green and brick for
  status. Nothing is coloured to look designed. Two accent tokens because one cannot serve both
  jobs: `--accent` (#b5532f) fills buttons and must carry white text; `--accent-text` (#b5532f
  light / #e08b6e dark) is for links and must read on the page.
- **Modest radii** (5px controls, 7px containers, 10px window), one hairline weight, one quiet
  shadow. Native checkboxes and radios are sized to 14px; the OS default is meant for a full window.

The render check asserts 4.5:1 on the panel, pill, send button and chips in both themes, and the
stylesheet tests require every selector to be declared once — an appended "polish" block that
re-declares rules is how two earlier regressions hid, and the test exists to refuse it.

## Conventions

Commits are authored **and** committed as `Joey Lu <31147609+joeyhlu@users.noreply.github.com>`,
with no `Co-Authored-By` or session trailers. This checkout's git identity may default to something
else — set it on the repo before committing and verify with
`git log -1 --format='%an <%ae> | %cn <%ce>'`.

The version shown in the app is injected by `scripts/build.mjs` from `package.json` via esbuild
`define` (`__APP_VERSION__`), and the main process uses `app.getVersion()`. Never hard-code it —
`tests/version.test.ts` fails if the number appears as a literal in the renderer.

Releases go through `workflow_dispatch` on `.github/workflows/release.yml` with a `tag` input.
Pushing a tag directly returns 403 from the session token. Always confirm the release's **asset
list** afterwards rather than the run's exit status: a job can pass while an installer is missing.

Every mutating Notion or calendar tool must record a reversible entry to the change journal, with
enough before-state to undo it. Capture that state before the write — Notion keeps no version to
fall back on.

## Not verified against real hardware

Two features have never executed for real, and the tests only cover the scripts they generate:

- **Selection reading** (`main/selection.ts`) — needs a Mac with the Accessibility permission. Open
  question is whether Notion's Electron view reports `AXSelectedText` at all.
- **Outlook calendar** (`mcp/win-calendar.ts`) — needs Windows with Outlook installed. No COM call
  has been made.

Two undo paths are pinned by request shape but unconfirmed against the live API: `unarchiveBlock`
(`PATCH {archived:false}`) and `restore-page-properties`. A failure in either is visible and
recoverable — the journal entry stays un-undone with the error shown.

Do not describe any of these as working.
