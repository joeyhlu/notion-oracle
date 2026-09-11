# Notion Oracle

An AI assistant for Notion that runs on **your own Claude or ChatGPT subscription**, with full access to your workspace. No Notion AI add-on, no API credits.

Ask it things in plain language and it does them in Notion for real — no copy-paste:

> *"Summarize the page I'm looking at."*
> *"Turn this into a to-do list and add it to the end."*
> *"Fix the formula in the third block."*
> *"Put 'Dentist' on my calendar Thursday at 2."*
> *"What's on my calendar this week?"*

Two ways to run it:

| | **Desktop app** (`desktop/`) | **Browser extension** (`extension/`) |
|---|---|---|
| Runs | Floating overlay next to the Notion desktop app, Mac / Windows / Linux | Side panel inside notion.so in Chrome |
| AI account | Your **Claude Pro/Max** sign-in (via Claude Code) or **ChatGPT Plus/Pro** sign-in (via Codex CLI) — no API key | Anthropic or OpenAI **API key** (pay per use) |
| Notion access | Whole workspace through a Notion integration; edits appear in the app instantly | The open page (DOM), plus the workspace with an integration token |
| Calendar | Real calendar events on macOS (Google / iCloud / Outlook via Calendar.app) | Notion databases with a date property |
| Best for | "Just add AI to my Notion" | Editing text in place on the page you're reading |

## Desktop app — quick start

> **New to this?** [`INSTALL.md`](INSTALL.md) is a click-by-click walkthrough of the steps below, including the unsigned-app warning and a set of test prompts to run in order. The app also has a **Help** screen (the **?** in its header) answering the things that most often go wrong.

1. **Download** the installer for your OS from the [Releases](../../releases) page — `-arm64.dmg` for Apple Silicon Macs, `.dmg` for Intel Macs, `.exe` for Windows. Or build it yourself: `cd desktop && npm install && npm run dist`.
2. **Install the AI tool you already pay for**, if you haven't:
   - Claude: [Claude Code](https://code.claude.com/docs/en/quickstart) — `curl -fsSL https://claude.ai/install.sh | bash` (Mac) or `irm https://claude.ai/install.ps1 | iex` (Windows PowerShell).
   - ChatGPT: [Codex CLI](https://developers.openai.com/codex/cli) — `npm install -g @openai/codex`.

   Oracle detects the tool, shows whether you're signed in, and its **Sign in** button opens a terminal running the login (`claude auth login` or `codex login`) for you.
3. **Connect Notion:** create an internal integration at [notion.so/profile/integrations](https://www.notion.so/profile/integrations), paste its secret into Oracle, and **share your pages with it** (**••• → Connections** in Notion). Sharing a top-level page shares everything underneath it. *This is the step people miss* — without it Oracle can authenticate but sees an empty workspace.
4. **Optional — connect your calendar** (macOS): add your Google, iCloud or Outlook account in **System Settings → Internet Accounts**, then turn on the calendar step in Oracle's setup. macOS will ask you to approve access the first time.
5. Press **⌘⇧Space** (**Ctrl⇧Space** on Windows) or click the ◎ pill to talk to Oracle.

Setup is four steps with live status badges — green when done, red when it's blocking, dash when optional — so you can see at a glance what's left.

See [`desktop/README.md`](desktop/README.md) for how it works internally and troubleshooting.

## What it can actually do

**In Notion**, through a bundled [MCP](https://modelcontextprotocol.io) server speaking the Notion API (version `2025-09-03`, the data-sources model):

| | |
|---|---|
| Find things | `search_notion`, `query_database`, `get_page`, `get_database` |
| Read a page | `read_page_blocks` — returns block IDs, which is what makes editing in place possible |
| Write | `create_page`, `create_database_entry`, `update_page`, `append_to_page` |
| Edit in place | `update_block`, `insert_after_block`, `delete_block` — it rewrites the block you meant instead of appending a corrected copy at the bottom |

Oracle also knows which page you have open in the Notion app, so "this page" means what you're looking at.

**In your calendar** (macOS, through Calendar.app — so events sync to your phone and to Notion Calendar like any other):

`calendar_list_calendars`, `calendar_list_events`, `calendar_create_event`, `calendar_update_event`, `calendar_delete_event`, `calendar_move_event`, `calendar_set_default_calendar`

New events go to the calendar belonging to your account rather than the empty local one macOS lists first; you can pin a different default by asking ("use my Gmail calendar"), and move a misplaced event with `calendar_move_event`.

On Windows and Linux, or if you'd rather drive Notion Calendar directly, Oracle falls back to opening Notion Calendar and typing the event — create-only, no reading or editing.

## Browser extension — quick start

```bash
cd extension && npm install && npm run build
```

Load `extension/dist/` via `chrome://extensions` → Developer mode → Load unpacked, then add an API key in the settings page. See [`extension/README.md`](extension/README.md).

Both halves share the same Notion tool layer (`extension/src/lib/`).

## Why a subscription, not an API key?

Claude.ai and ChatGPT subscriptions don't expose an API. The one legitimate way to use them programmatically is through the vendors' own coding agents — Claude Code and Codex CLI — which sign in with the subscription and can run tools. The desktop app is a thin overlay that drives whichever of those you have installed, and gives it Notion and calendar tools through a small bundled MCP server. It never talks to the claude.ai or chatgpt.com web apps directly; that would break both providers' terms.

## Privacy

Your Notion content goes to Anthropic or OpenAI — whichever account you connected — and nowhere else. There is no Notion Oracle server. Your integration secret and settings stay in a file on your own machine, and calendar access never leaves it: AppleScript talks to Calendar.app locally.

## Development

```bash
cd desktop && npm install
npm run check     # typecheck, build, unit tests
npm run smoke     # renders the panel in a real browser and asserts the layout
                  # (first run: npx playwright install chromium)
npm start         # run the app from source
```

`npm run smoke` exists because the unit tests read the source and can't see that the page *looks* right — a release once shipped with all three views drawn on top of each other and every test green. CI runs it and uploads the rendered screenshots.

## License

MIT
