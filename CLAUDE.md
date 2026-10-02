# Notion Oracle — working notes

An AI overlay for the Notion desktop app that runs on the user's own Claude or ChatGPT
subscription. No API keys, no Notion AI add-on.

## Layout

- `desktop/` — the Electron app, on the user's Claude or ChatGPT subscription.
- `extension/` — a Chrome MV3 extension on an API key: Notion AI's selection menu, ⌘J at the
  cursor, and a chat window, all inside notion.so. `extension/src/lib/` is shared: the desktop
  imports its Notion client, tools, Markdown and undo, so a change there affects both. Run both
  test suites.

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
npm run check    # typecheck + build + 213 tests
npm run smoke    # renders the built panel in Chromium, both themes  (needs a browser, see below)
npm start        # run from source
cd ../extension && npm run check   # typecheck + 75 tests + build
npm run e2e                        # loads dist/ into Chromium against a mock Notion: every feature
npm run package                    # zip for the release page / Chrome Web Store
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

**Playwright's default headless browser cannot load extensions.** `scripts/e2e.mjs` launches
with `channel: "chromium"` (or `CHROMIUM_PATH`); the headless shell silently runs without the
extension and every check fails on a missing host element.

**A shadow-DOM rule can outrank positioning.** `[data-tip] { position: relative }` once beat
`.fab { position: fixed }` (same specificity, later rule) and put the floating button half off the
left edge. Tooltip anchors are positioned by their own rules; `tests/styles.test.ts` and the e2e
position check guard it.

**Notion's editor is not ours to drive.** The extension writes by dispatching a synthetic paste
and checks the page changed afterwards; Insert below then falls back to the API after the right
block, then to the clipboard with a message. Keep that chain: a silent no-op is the failure mode.

**Electron's transparent frameless window** breaks Playwright screenshots of the collapsed pill
(compositing never settles). Assert computed styles instead; it is a harness quirk, not a bug.

## Visual language

Both apps are drawn in **Notion's own visual language**, at Notion's density. The user asked for
exactly that (v0.9.0) after rejecting two looser passes, a "Notion-inspired" one and a Claude-style
one with a serif and terracotta, as reading generated. The lesson: imitate Notion's real
components and measurements, never a mood.

- **Notion's tokens.** Ink `#37352f`, secondary ink at 72%, hairlines at 9% / 16%, hover at 6%.
  Dark is `#191919` / `#202020` / `#252525` with white ink at 86%. Font stack is Notion's
  (`ui-sans-serif, -apple-system, … "Segoe UI Variable Display"`).
- **Blue is the one colour.** Notion's `#2383e2` fails 4.5:1 under white text (3.9:1), so fills and
  link text use `#1c74d4` (4.7:1); switches and focus rings keep `#2383e2`; dark links use Notion's
  `#529cca`. Terracotta survives only as the dot in the icon.
- **Notion's components, not lookalikes.** Toggle lists with a solid triangle; status shown as
  select tags with words ("Done", "Needs you", "Optional"), grey/green/red; switches for settings
  rows; grey callouts with an emoji; buttons with an inset hairline and 4px corners; menu rows 28–30px.
- **Sizes.** UI text 14px, meta 12px. Panels (the desktop window, the panel inside notion.so) stay
  at UI sizes: view headings are Notion's settings-section style, 14px semibold over a hairline.
  Only the extension's setup page, which is a whole page, uses Notion's page scale: 40px title,
  24px headings, 16px body, a 708px column. Never a serif.
- **Icons** are one line set, `extension/src/shared/icons.ts`, used by both apps; the mark is
  `extension/src/shared/mark.ts`; `npm run icons -- --desktop` re-renders the PNGs from it.

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
`tests/version.test.ts` fails if the number appears as a literal in the renderer. The extension's
`src/manifest.json` carries `0.0.0`; its build writes the version from `extension/package.json`.
Both packages move together: one release, one number.

Releases go through `workflow_dispatch` on `.github/workflows/release.yml` with a `tag` input. A
release has five assets: two DMGs, the Windows `.exe`, the AppImage and
`notion-oracle-extension-<version>.zip`.
Pushing a tag directly returns 403 from the session token. Always confirm the release's **asset
list** afterwards rather than the run's exit status: a job can pass while an installer is missing.

Every mutating Notion or calendar tool must record a reversible entry to the change journal, with
enough before-state to undo it. Capture that state before the write — Notion keeps no version to
fall back on.

Calendar edits go through `mcp/calendar-edit.ts` (find by title, plan new times) and
`mcp/rrule.ts` (repeat rules); both are pure and tested on Linux. The backends only carry out a
plan. A series is one record from the scripts, dated at its first occurrence, and `expandListing`
turns it into occurrences for a range; an edit always targets the master, so on a series only
the time of day may move (see `planTimes`). Both backends print nine-field records: the last
two are notes and the RFC 5545 rule, and `parseEvents` maps AppleScript's "missing value" to "".

## Not verified against real hardware

Two features have never executed for real, and the tests only cover the scripts they generate:

- **Selection reading** (`main/selection.ts`) — needs a Mac with the Accessibility permission. Open
  question is whether Notion's Electron view reports `AXSelectedText` at all.
- **Outlook calendar** (`mcp/win-calendar.ts`) — needs Windows with Outlook installed. No COM call
  has been made.

Three calendar behaviours are likewise script-shape only: the `whose … recurrence contains "FREQ"`
filter that fetches series which began before a range (it is inside `try`, so if Calendar.app
rejects it the plain listing still works and series are simply missing), `set recurrence of ev`
to change or clear a rule, and the Outlook recurrence pattern in `win-calendar.ts`.

Two undo paths are pinned by request shape but unconfirmed against the live API: `unarchiveBlock`
(`PATCH {archived:false}`) and `restore-page-properties`. A failure in either is visible and
recoverable — the journal entry stays un-undone with the error shown.

The extension is verified end to end only against a mock Notion page and scripted APIs. Not yet
confirmed on the live notion.so: that Notion's editor accepts the synthetic paste (the fallbacks
cover it if not), that the capture-phase ⌘J listener runs before Notion's own, and the exact
selectors (`.notion-page-content`, `data-block-id`, `body.dark`) on the current Notion build.

Do not describe any of these as working.
