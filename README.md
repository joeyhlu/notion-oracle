# Notion Oracle

An AI assistant for Notion that runs on **your own Claude or ChatGPT subscription**, with full access to your workspace. No Notion AI add-on, no API credits.

Two ways to use it:

| | **Desktop app** (`desktop/`) | **Browser extension** (`extension/`) |
|---|---|---|
| Runs | Floating overlay next to the Notion desktop app, Mac / Windows / Linux | Side panel inside notion.so in Chrome |
| AI account | Your **Claude Pro/Max** sign-in (via Claude Code) or **ChatGPT Plus/Pro** sign-in (via Codex CLI) — no API key | Anthropic or OpenAI **API key** (pay per use) |
| Notion access | Whole workspace through a Notion integration; edits appear in the app instantly | The open page (DOM), plus the workspace with an integration token |
| Best for | "Just add AI to my Notion" | Editing text in place on the page you're reading |

Both share the same Notion tool layer (`extension/src/lib/`): search, read pages, create pages, add and update database entries (calendars are databases with a date property), append content.

## Desktop app — quick start

> **New to this?** [`INSTALL.md`](INSTALL.md) is a click-by-click walkthrough of the four steps below, including the unsigned-app warning and a set of test prompts to run in order.

1. **Download** the installer for your OS from the [Releases](../../releases) page (`.dmg` for Mac, `.exe` for Windows). Or build it yourself: `cd desktop && npm install && npm run dist`.
2. **Install the AI tool you already pay for**, if you haven't:
   - Claude: [Claude Code](https://code.claude.com/docs/en/quickstart) — `curl -fsSL https://claude.ai/install.sh | bash` (Mac) or `irm https://claude.ai/install.ps1 | iex` (Windows PowerShell), then `claude auth login`.
   - ChatGPT: [Codex CLI](https://developers.openai.com/codex/cli) — `npm install -g @openai/codex`, then `codex login`.
   The app detects the tool, shows whether you're signed in, and has a **Sign in** button that runs the login for you.
3. **Connect Notion:** create an internal integration at [notion.so/profile/integrations](https://www.notion.so/profile/integrations), paste its secret into Oracle, and share your top-level pages with it (**••• → Connections** in Notion). Sharing a top-level page shares everything underneath it.
4. Press **⌘⇧Space** (**Ctrl⇧Space** on Windows) or click the ◎ pill to talk to Oracle. It knows which page you have open in the Notion app and can read it, summarize it, add to it, and create pages and calendar entries.

See [`desktop/README.md`](desktop/README.md) for how it works, the unsigned-app note, and troubleshooting.

## Browser extension — quick start

```bash
cd extension && npm install && npm run build
```

Load `extension/dist/` via `chrome://extensions` → Developer mode → Load unpacked, then add an API key in the settings page. See [`extension/README.md`](extension/README.md).

## Why a subscription, not an API key?

Claude.ai and ChatGPT subscriptions don't expose an API. The one legitimate way to use them programmatically is through the vendors' own coding agents — Claude Code and Codex CLI — which sign in with the subscription and can run tools. The desktop app is a thin overlay that drives whichever of those you have installed, and gives it Notion tools through a small bundled [MCP](https://modelcontextprotocol.io) server. It never talks to the claude.ai or chatgpt.com web apps directly; that would break both providers' terms.

## License

MIT
