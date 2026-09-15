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

The panel floats beside Notion, so it follows Notion's idiom rather than a generic one:

- warm neutrals. The ink is `#37352f` and the greys are that colour at low alpha, not separate
  swatches — which is why hover states tint against whatever is behind them.
- small radii: 3px controls, 5px containers, 8px window. Never round a button to 8px.
- Notion's three-layer menu shadow (hairline ring plus two spreads), not one soft blur.
- the system font stack. A bundled typeface reads as foreign next to Notion.
- two blues, deliberately. `--accent` fills buttons and must carry white text; `--accent-text` is
  for links and must read against the page. In dark mode those pull opposite ways, so one value
  cannot serve both — Notion's own `#2383e2` button is 3.9:1 against its white label, under AA.

The render check asserts 4.5:1 on the panel, pill, send button and chips in both themes, so a
palette change that hurts legibility fails rather than ships.

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
