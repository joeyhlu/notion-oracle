# Notion Oracle — browser extension

A browser extension that puts a **bring-your-own-key AI assistant inside Notion**, so you get what Notion AI does without the Notion AI add-on. Plug in your own Anthropic (Claude) or OpenAI (ChatGPT) API key and, optionally, a Notion integration token.

Oracle opens as a side panel on any Notion page and can:

- **Answer questions about the open page** and summarize it
- **Rewrite, fix, translate or explain a selection**, replacing it in place
- **Draft content** and insert it at the cursor or at the end of the page
- **Search your workspace**, read other pages, and follow links between them
- **Create pages** with structured Markdown bodies
- **Add calendar events, tasks and other database rows** ("add dentist next Friday at 2pm to my calendar")
- **Update properties** of existing entries (dates, statuses, checkboxes)

It runs an agentic tool-use loop: the model decides which tools to call (read page, search Notion, create entry, …), the extension executes them, and the reply streams into the panel.

## Install

```bash
npm install
npm run build        # bundles to dist/
```

Then in Chrome, Edge, Brave or Arc: open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and pick the `dist/` folder. The settings page opens automatically on first install.

`npm run watch` rebuilds on change while you develop (reload the extension in `chrome://extensions` to pick up background changes).

## Setup

1. **AI provider.** Pick Claude or ChatGPT in the settings page and paste an API key.
   - Claude: create a key at [console.anthropic.com](https://console.anthropic.com/settings/keys). Default model is `claude-opus-5`; Sonnet 5 and Haiku 4.5 are available for lower cost.
   - ChatGPT: create a key at [platform.openai.com](https://platform.openai.com/api-keys). Default model is `gpt-5.5`; any chat model id can be typed in.

   API keys are billed per use and are separate from a Claude.ai or ChatGPT subscription. Consumer subscriptions do not expose an API, so the extension cannot piggyback on them.

2. **Notion integration (optional but recommended).** Without it Oracle can still read and edit the page you have open. With it, Oracle can search, create pages and write to databases.
   - Go to [notion.so/profile/integrations](https://www.notion.so/profile/integrations) and create an **internal** integration with read, update and insert content capabilities.
   - Paste its *Internal Integration Secret* into the settings page.
   - In Notion, open each page or database Oracle should reach and use **••• → Connections** to add the integration. Sharing a top-level page shares everything beneath it.

3. Click **Test connection** for each service, then **Save**.

## Use

Open a Notion page and press **Ctrl+Shift+Space** (**⌘+Shift+Space** on Mac), click the extension's toolbar icon, or the ◎ button in the bottom-right corner.

Things to try:

- "Summarize this page in five bullets"
- "Turn these meeting notes into a to-do list and add it to the end of the page"
- Select a paragraph → "Make this more formal" (Oracle replaces the selection)
- "Add *Dentist* on September 12 at 2pm to my Calendar"
- "Create a page under this one called Q4 Plan with an outline for a product launch"
- "What tasks in my Tasks database are due this week?"

Each message includes the current date, the open page's id and your selection, so relative dates and "this page" resolve correctly. Quick-action chips in the panel cover the common cases.

## How it works

```
┌──────────────────────── Notion tab ────────────────────────┐
│  content script                                            │
│   ├─ panel UI (shadow DOM)  ── port ──►  service worker    │
│   └─ page tools: read DOM, selection,    ├─ agent loop     │
│      insert/replace via synthetic paste  │   Anthropic SDK │
│                              ◄── tabs ── │   OpenAI SDK    │
└──────────────────────────────────────────┤─ Notion API ────┘
                                           └─ settings (chrome.storage.local)
```

- `src/background/` runs the agent loop in the extension's service worker. Providers stream text and tool calls; tools run either in the worker (Notion API) or are forwarded to the tab (DOM tools). Conversation history lives in the panel and is round-tripped with each message, so a service-worker restart never loses the thread.
- `src/lib/providers/` holds the two provider adapters behind one interface. The Claude adapter uses adaptive thinking, prompt caching for the system prompt, configurable effort, and server-side refusal fallbacks. The OpenAI adapter uses Chat Completions with streaming function calls.
- `src/lib/tools.ts` defines the tool set (JSON Schema) and its executor. `src/lib/notion.ts` is a small Notion API client with Markdown ⇄ block conversion and plain-value → property coercion, so the model can write `{"Date": "2026-09-12T14:00"}` instead of raw Notion payloads.
- `src/content/page.ts` reads the editor DOM as Markdown and writes into it by dispatching a paste event, which lets Notion parse Markdown into real blocks.

## Development

```bash
npm run typecheck   # tsc
npm test            # node --test (markdown + Notion helpers)
npm run build       # esbuild → dist/
npm run check       # all three
npm run icons       # regenerate icons/ (no dependencies)
```

## Privacy

Keys and the Notion token are stored in `chrome.storage.local` on your machine and are only sent to `api.anthropic.com`, `api.openai.com` and `api.notion.com` respectively. Page content is sent to the AI provider you chose when a tool reads it. Nothing is sent anywhere else; there is no telemetry.

## Roadmap

- Firefox build (MV3 with `browser.*` shims)
- Slash-command style inline prompts inside the editor ("/ask")
- Multi-page research: follow child pages and relations automatically
- Support for the newer Notion API data-source model

## License

MIT
