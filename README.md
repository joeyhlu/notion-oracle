# Notion Oracle

An AI assistant for Notion that runs on **your own Claude or ChatGPT subscription**, with full access to your workspace. No Notion AI add-on, no API credits.

Ask it things in plain language and it does them in Notion for real — no copy-paste:

> *"Summarize the page I'm looking at."*
> *"What did I decide about the budget?"*
> *"Turn this into a to-do list and add it to the end."*
> *"Fix the formula in the third block."*
> *"Put 'Dentist' on my calendar Thursday at 2."*
> *"What's on my calendar this week?"*

## Download

Every link below always points at the newest release. **[notion-oracle on GitHub Pages](https://joeyhlu.github.io/notion-oracle/)** picks the right one for your machine.

| | Download | Then |
|---|---|---|
| **Mac, Apple silicon** (M1 and later) | [Notion-Oracle-mac-arm64.dmg](https://github.com/joeyhlu/notion-oracle/releases/latest/download/Notion-Oracle-mac-arm64.dmg) | Open the DMG, drag the app to Applications. First launch: right-click → **Open** (see [INSTALL.md](INSTALL.md)) |
| **Mac, Intel** | [Notion-Oracle-mac-x64.dmg](https://github.com/joeyhlu/notion-oracle/releases/latest/download/Notion-Oracle-mac-x64.dmg) | Same |
| **Windows** | [Notion-Oracle-win-x64.exe](https://github.com/joeyhlu/notion-oracle/releases/latest/download/Notion-Oracle-win-x64.exe) | Run it. At "Windows protected your PC": **More info → Run anyway** |
| **Linux** | [Notion-Oracle-linux-x86_64.AppImage](https://github.com/joeyhlu/notion-oracle/releases/latest/download/Notion-Oracle-linux-x86_64.AppImage) | `chmod +x`, then run |
| **Browser extension** (Chrome, Edge, Brave, Arc) | [notion-oracle-extension.zip](https://github.com/joeyhlu/notion-oracle/releases/latest/download/notion-oracle-extension.zip) | Unzip, then `chrome://extensions` → Developer mode → **Load unpacked** |

Not sure which Mac you have? Apple menu → **About This Mac**: "Apple M1/M2/M3/M4" means Apple silicon.

Two ways to run it:

| | **Desktop app** (`desktop/`) | **Browser extension** (`extension/`) |
|---|---|---|
| Runs | Floating overlay next to the Notion desktop app, Mac / Windows / Linux | Inside notion.so in Chrome, Edge, Brave or Arc: an AI menu on your selection and at your cursor, plus a chat window |
| AI account | Your **Claude Pro/Max** sign-in (via Claude Code) or **ChatGPT Plus/Pro** sign-in (via Codex CLI) — no API key | Anthropic or OpenAI **API key** (pay per use) |
| Notion access | Whole workspace through a Notion integration; edits appear in the app instantly | The open page (DOM), plus the workspace with an integration token |
| Calendar | Real events: Calendar.app on macOS, Outlook on Windows | Notion databases with a date property |
| Best for | "Just add AI to my Notion" | The Notion AI experience in the browser: select text, ask, replace |

## Desktop app — quick start

> **New to this?** [`INSTALL.md`](INSTALL.md) is a click-by-click walkthrough of the steps below, including the unsigned-app warning and a set of test prompts to run in order. The app also has a **Help** screen (the **?** in its header) answering the things that most often go wrong.

1. **Download** the installer for your machine from the table above, or build it yourself: `cd desktop && npm install && npm run dist`.
2. **Install the AI tool you already pay for**, if you haven't. Oracle's setup screen has an **Install** button that opens a terminal running the installer, and a **Sign in** button that runs the login (`claude auth login` or `codex login`); it notices on its own when each finishes. Or do it by hand:
   - Claude: [Claude Code](https://code.claude.com/docs/en/quickstart) — `curl -fsSL https://claude.ai/install.sh | bash` (Mac, Linux) or `irm https://claude.ai/install.ps1 | iex` (Windows PowerShell).
   - ChatGPT: [Codex CLI](https://developers.openai.com/codex/cli) — `npm install -g @openai/codex`.
3. **Connect Notion:** create an internal integration at [notion.so/profile/integrations](https://www.notion.so/profile/integrations), paste its secret into Oracle (it is checked the moment you paste it), and **share your pages with it** (**••• → Connections** in Notion). Sharing a top-level page shares everything underneath it. *This is the step people miss* — without it Oracle can authenticate but sees an empty workspace, and the setup screen tells you so.
4. **Optional — connect your calendar**: on a Mac, add your Google, iCloud or Outlook account in **System Settings → Internet Accounts**; on Windows, Oracle uses Outlook, so any account added there works. Then turn on the calendar step in Oracle's setup. The OS asks you to approve access the first time.
5. **Optional — turn on deeper search or bulk edits** in setup, if you want Oracle to search inside your pages or fill a database column. See below for what each costs.
6. Press **⌘⇧Space** (**Ctrl⇧Space** on Windows) or click the ◎ pill to talk to Oracle. The first chat offers five suggestions in order, from the simplest check to a real edit; each one proves a different part of the setup.

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
| Optional | `search_page_contents`, `read_database_rows`, `set_database_rows` — off by default, see below |

Oracle also knows which page you have open in the Notion app, so "this page" means what you're looking at — and on macOS it can see the text you have **highlighted**, so "fix this paragraph" works without describing which one. That needs the Accessibility permission and can be switched off in Preferences.

**Undo.** Everything Oracle changes is recorded, and the **⟲** button in the header lists it with an Undo on each entry: blocks it added are removed, a rewritten block gets its previous text back, a deleted one comes out of Notion's trash, and calendar events are put back as they were. A line under each reply says what that turn actually touched — taken from the record of what the tools did, not from the model's own account of it.

**Conversations are kept.** Quitting no longer ends the thread. The **☰** button lists past conversations, and reopening one restores both the transcript and the underlying CLI session, so the next message carries on rather than starting fresh.

### Two things you can turn on

Both live in **Setup → Deeper search & bulk edits**, and both are off until you ask for them: each costs noticeably more time and more of your AI subscription per question than the defaults.

**Search inside your pages, not just their titles.** Notion's own search matches titles, which is fine for "open my Roadmap" and useless for *"what did I decide about the budget"* when the page is called Q3 Planning. With this on, Oracle reads your recently edited pages, ranks them by how many of your words they actually contain, and answers with the lines that matched and a link to each page. It says how far back it looked when it finds nothing, so you can tell "not written down" from "further back than I checked".

**Fill a property across a whole database.** *"Summarize every row into the Summary column"*, *"tag these by topic"*. Oracle reads each row's page — not just its title — then writes the whole column in one pass. It can skip rows that already have a value, so topping up a column doesn't redo finished work, and every row it writes is recorded separately, so one wrong value can be undone on its own without reverting the pass.

This is the on-demand version of Notion AI's always-on AI properties. Oracle has no way to run on a schedule, so it fills the column when you ask rather than as rows change.

**In your calendar** — Calendar.app on macOS, Outlook on Windows, so events sync to your phone and to Notion Calendar like any other:

`calendar_list_calendars`, `calendar_list_events`, `calendar_find_events`, `calendar_create_event`, `calendar_update_event`, `calendar_delete_event`, `calendar_move_event`, `calendar_set_default_calendar`

Editing is one step. *"Move the dentist to Friday at 3"*, *"push my 1:1 back an hour"*, *"make Thursday's lunch 90 minutes"*, *"delete the standup on the 24th"*: Oracle finds the event by its title (a week back to three months ahead), keeps its length when only the time moves, and asks which one you mean only when two different events fit the words. Repeating events work too — *"yoga every Tuesday at 7 until December"* creates a series, *"make the standup daily"* or *"stop it repeating"* changes one, and *"what's on Thursday"* includes the weekly standup you created in January. A change to a series applies to every occurrence; a single occurrence is the one thing to do in Notion Calendar itself. Say *"show me"* and Oracle opens Notion Calendar to that day.

New events go to the calendar belonging to your account rather than the empty local one macOS lists first; you can pin a different default by asking ("use my Gmail calendar"), and move a misplaced event with *"move it to my Gmail calendar"*. Every calendar change is in the changes list with an Undo, including moves.

On Windows any account you have added to Outlook works, Google and iCloud included. On Linux, on a PC without Outlook, or if you'd rather drive Notion Calendar directly, Oracle falls back to opening Notion Calendar and typing the event — create-only, no reading or editing.

## Browser extension — install in a minute

1. Download **[notion-oracle-extension.zip](https://github.com/joeyhlu/notion-oracle/releases/latest/download/notion-oracle-extension.zip)** and unzip it. You get one folder, `notion-oracle-extension`.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`), switch on **Developer mode**, click **Load unpacked**, and choose that folder.
3. A setup page opens by itself. Paste a Claude or ChatGPT API key — it turns green when the key works — and optionally a Notion integration secret. There is no Save button; it saves as you type.

Then open any Notion page:

- **Select text → Ask AI**: improve writing, fix spelling and grammar, make shorter or longer, change tone, simplify, translate, explain, summarize, find action items, continue writing. The result previews first; **Replace**, **Insert below**, **Copy**, **Try again**, or tell it what to change.
- **⌘J / Ctrl+J at the cursor**: continue writing, or draft a blog post, outline, meeting agenda, email, pros and cons, to-do list, brainstorm and more.
- **⌘⇧Space / Ctrl+Shift+Space**, or the Oracle button in the corner: chat about the page, @-mention other pages, ask questions across your workspace, fill a database column, create pages and calendar entries, and search the web with sources. Chats are saved, and changes made through Notion's API can be undone from the chat's **Changes** list.

See [`extension/README.md`](extension/README.md) for details, what works without a Notion integration, and how to publish it to the Chrome Web Store for true one-click installs.

## Why a subscription, not an API key?

Claude.ai and ChatGPT subscriptions don't expose an API. The one legitimate way to use them programmatically is through the vendors' own coding agents — Claude Code and Codex CLI — which sign in with the subscription and can run tools. The desktop app is a thin overlay that drives whichever of those you have installed, and gives it Notion and calendar tools through a small bundled MCP server. It never talks to the claude.ai or chatgpt.com web apps directly; that would break both providers' terms.

## Privacy

Your Notion content goes to Anthropic or OpenAI — whichever account you connected — and nowhere else. There is no Notion Oracle server. Your integration secret and settings stay in a file on your own machine, and calendar access never leaves it: AppleScript talks to Calendar.app locally.

## Development

Node 22.12 or later (`.nvmrc`).

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
