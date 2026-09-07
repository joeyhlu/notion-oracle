# Notion Oracle — desktop app

A floating AI panel that sits next to the Notion desktop app. It runs on your own Claude Code or Codex CLI sign-in (so your Claude Pro/Max or ChatGPT Plus/Pro subscription), and reaches your Notion workspace through a bundled tool server.

## Install

**From a release:** grab the `.dmg` (Mac) or `.exe` (Windows) from the [Releases](../../../releases) page.

- **Mac:** builds are ad-hoc signed but not notarized, so the first launch needs approval: right-click → **Open**, or **System Settings → Privacy & Security → Open Anyway**. If macOS calls the app damaged, run `xattr -cr "/Applications/Notion Oracle.app"` then `codesign --force --deep --sign - "/Applications/Notion Oracle.app"`. See [INSTALL.md](../INSTALL.md).
- **Windows:** SmartScreen shows "unknown publisher" the first time; click **More info → Run anyway**.

**From source:**

```bash
cd desktop
npm install
npm start        # build + run
npm run dist     # build an installer for this OS into release/
```

## Setup (once)

The app opens the setup screen on first launch.

1. **AI account.** Pick Claude or ChatGPT. Oracle looks for the `claude` / `codex` command, shows its version and whether you're signed in, and offers:
   - **Install…** — opens the vendor's install page and shows the one-line install commands.
   - **Sign in** — opens your terminal running `claude auth login` or `codex login`. That uses your existing subscription.
   - **Re-check** — after installing or signing in.
2. **Notion.** Create an internal integration at [notion.so/profile/integrations](https://www.notion.so/profile/integrations) (read, update, insert content), paste its secret, and share your top-level pages with it (**••• → Connections**). **Test Notion** tells you how many pages it can see.
3. **Save & start.**

## Use

- The ◎ pill appears only while the Notion app is in front, so it stays out of your way everywhere else. Turn that off with **Only show over Notion** in the tray menu or in settings.
- **⌘⇧Space** / **Ctrl⇧Space** opens the panel from anywhere, even while the pill is hidden. The tray/menu-bar icon works too. Esc collapses it.
- A panel opened over Notion closes itself when you switch to another app; one you opened deliberately from elsewhere stays put.
- The header shows **Looking at: <page>** when the Notion app is in front, so "this page" just works.
- **Your real calendar.** Add your Google, iCloud or Outlook account in System Settings → Internet Accounts and Oracle reads and writes it directly through the scriptable macOS Calendar app: "what's on my calendar this week?", "add dentist Sept 12 at 2pm", "move my 3pm to Thursday". Events sync to the account and show up in Notion Calendar. Windows, or macOS without that account, falls back to typing into the Notion Calendar app, which can only create. See [CALENDAR.md](CALENDAR.md).
- Editing works in place now: "rewrite this section more formally", "convert the Terms list to LaTeX", "turn that paragraph into a heading". Oracle reads the page's block ids, then rewrites, inserts or deletes individual blocks.
- Try: "Summarize this page", "What's on my calendar this week?", "Add *Dentist* on Sept 12 at 2pm to my Calendar", "Create a page under this one called Q4 Plan with an outline", "Turn this page into a to-do list and add it to the end".
- Each tool call shows as a small chip while it runs. **Stop** cancels a turn. **✚** starts a new conversation; **⚙** reopens settings.
- Right-click the tray icon for **Start at login** and **Quit**.

## How it works

```
 ┌───────────── Notion Oracle (Electron) ─────────────┐
 │ overlay window ──IPC──► main process               │
 │                          │ spawns, per message:    │
 │                          ▼                         │
 │            claude -p … / codex exec …  (your login)│
 │                          │ MCP over stdio          │
 │                          ▼                         │
 │            dist/mcp/notion-server.js ──► Notion API│
 └────────────────────────────────────────────────────┘
```

- `src/main/brains/claude.ts` runs `claude -p --output-format stream-json --include-partial-messages` with `--mcp-config` pointing at the bundled Notion server, `--tools ""` (no file/shell tools), `--allowedTools` limited to the Notion tools, and `--resume <session>` for follow-up messages. Text streams into the panel token by token; tool calls and results come through as events.
- `src/main/brains/codex.ts` does the same with `codex exec --json`, passing the MCP server as `-c mcp_servers.notion.*` overrides so your `~/.codex/config.toml` is untouched.
- `src/mcp/notion-server.ts` is a dependency-free MCP server (JSON-RPC over stdio) exposing the eight Notion tools from `extension/src/lib/tools.ts`. It runs on Electron's own binary (`ELECTRON_RUN_AS_NODE=1`), so users don't need Node installed.
- `src/main/notion-window.ts` reads the Notion app's front window title (AppleScript on Mac, PowerShell on Windows) and passes it to the model as "the page the user is looking at". The model then finds that page by title with `search_notion`.
- Notion links in replies open in the Notion app (`notion://`).

Settings live in the app's user-data folder (`settings.json`); the Notion token never leaves your machine except in requests to `api.notion.com`.

## Verified vs. not

Verified in CI-style tests: the stream parsers against a real Claude Code run, the MCP server over stdio, an end-to-end Electron run with a stubbed `claude` (setup → chat → tool call → resume → collapse), and a real `claude -p` run that connected to the MCP server and called a tool.

Not verified from the build environment: the Codex CLI path (written to the documented `codex exec --json` format), macOS/Windows window-title detection, the terminal-launching sign-in buttons, and the unsigned-app first-launch flow. Please report what you hit.

## Development

```bash
npm run typecheck
npm test            # node --test
npm run build       # esbuild → dist/
npm run watch
npm run check       # all three
```
