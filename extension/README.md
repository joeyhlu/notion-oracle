# Notion Oracle — browser extension

Notion AI in your browser, on your own Claude or ChatGPT API key. No Notion AI add-on.

## Install

1. Download **`notion-oracle-extension-<version>.zip`** from the [Releases](../../../releases) page and unzip it. You get one folder, `notion-oracle-extension`.
2. Open `chrome://extensions` (Edge: `edge://extensions`; Brave, Arc and other Chromium browsers use `chrome://extensions` too), switch on **Developer mode**, click **Load unpacked**, and choose that folder.
3. The setup page opens by itself:
   - **Connect an AI.** Pick Claude or ChatGPT and paste an API key ([Anthropic](https://console.anthropic.com/settings/keys), [OpenAI](https://platform.openai.com/api-keys)). It checks the key as you paste and turns green when it works. API keys are pay-as-you-go and separate from a Claude.ai or ChatGPT subscription.
   - **Connect Notion** (optional). Create an internal integration at [notion.so/profile/integrations](https://www.notion.so/profile/integrations), paste its secret, then add the integration to your top-level pages with **••• → Connections**. The page shows which pages Oracle can see, so you know it worked.
   - Everything saves as you type.
4. Pin Oracle from the puzzle-piece menu so it is one click away.

## Use

**On selected text** — an **Ask AI** button appears under any selection (or press **⌘J** / **Ctrl+J**):

| Edit or review | Generate from the selection |
|---|---|
| Improve writing · Fix spelling & grammar · Make shorter · Make longer · Change tone (professional, casual, straightforward, confident, friendly) · Simplify language · Translate (20 languages) | Explain this · Summarize · Find action items · Continue writing |

You can also type any instruction. The result appears as a preview; then **Replace selection**, **Insert below**, **Copy**, **Try again**, **Discard**, or type a follow-up ("shorter", "more formal") to revise it. The text stays highlighted while you decide.

**At the cursor** — press **⌘J** / **Ctrl+J** on any line: continue writing, summarize the page, find action items, translate the page, or draft a brainstorm, outline, blog post, meeting agenda, pros and cons list, to-do list, email, social post, press release, job description, essay, story or poem. Picking a draft starts the sentence for you ("Write a blog post about …"); finish it and press Enter.

**Chat** — **⌘⇧Space** / **Ctrl+Shift+Space**, the toolbar icon, or the Oracle button in the bottom-right corner:

- Ask about the open page, or what you have selected. The page and selection show as chips above the box; click × to leave the page out.
- **@-mention** other pages to bring them in.
- **Ask your workspace** — "what did we decide about pricing?" — Oracle searches inside your pages, not just titles, and links what it used.
- **Do things**: create pages, add database entries and calendar events, update properties, fill a column across a database ("summarize every row into Summary").
- **Search the web** (Claude): answers list their sources. Toggle **Web** off for a message that should stay inside Notion.
- Each reply shows what Oracle did in plain words ("Read this page · Searched Notion for “roadmap”"). Copy a reply, insert it into the page, or try again.
- **Chats** are saved and can be reopened. **Changes** lists everything Oracle changed through the Notion API, each with **Undo**.
- Dock the chat to the side or keep it floating. It follows Notion's light or dark theme.

### What needs the Notion integration

Without it Oracle works on the page in front of you: reading it, the AI menu, inserting and replacing text. With it, Oracle can also reach the rest of the workspace: search, @-mentions, other pages, creating pages and entries, database columns, and Undo for those changes.

### Compared with Notion AI

Covered: the selection menu, writing at the cursor, drafts, translation, chat about the page, Q&A across the workspace, filling database properties, creating content, web search with sources.

Not covered: meeting transcription (it needs audio), AI blocks that refresh on their own, and database autofill that runs as rows change. Oracle fills a column when you ask, not in the background.

## Settings

Open them from the chat's settings button, or right-click the toolbar icon → **Options**. Besides keys and model, you can switch off web search, searching inside pages, bulk database edits, the ⌘J shortcut (to keep Notion's own), the Ask AI button and the corner button, and add standing instructions ("reply in French", "my tasks live in the Tasks database").

Keys are stored in this browser profile only and sent only to Anthropic or OpenAI and to Notion. There is no Oracle server and no telemetry.

## Publish to the Chrome Web Store

Loading unpacked needs Developer mode. For a true one-click install, publish the same zip to the Chrome Web Store:

1. Register at the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole) (a one-time fee).
2. **New item** → upload `notion-oracle-extension-<version>.zip` from the release.
3. Fill in the listing: the description in `src/manifest.json` works as the summary; use `icons/icon128.png`; screenshots come from `npm run e2e -- --out shots`.
4. Privacy: Oracle stores API keys locally, sends page content only to the AI provider the user chose and to Notion, and collects nothing.

Review usually takes a few days. After that, anyone installs it with one click, and updates arrive automatically.

## Develop

```bash
npm install
npm run check       # typecheck, unit tests, build to dist/
npm run e2e         # build, then run every feature in Chromium against a mock Notion
npm run package     # build and zip to release/
npm run icons       # re-render icons/ from src/shared/mark.ts
npm run watch       # rebuild on change; reload the extension in chrome://extensions
```

`npm run e2e` needs a Chromium: `npx playwright install chromium` once, or set `CHROMIUM_PATH` to an existing binary. Pass `--out <dir>` to save screenshots of each screen.

### How it works

```
┌──────────────────────── Notion tab ─────────────────────────┐
│ content script (shadow DOM)                                 │
│  ├─ AI menu + Ask AI button ──┐                             │
│  ├─ chat window ──────────────┼── port ──►  service worker  │
│  └─ page tools: read the DOM, │             ├─ agent loop    │
│     write via synthetic paste ◄── tabs ──── │  Claude / GPT  │
└─────────────────────────────────────────────┤─ Notion API ───┘
                                              └─ settings, chats, changes (chrome.storage)
```

- `src/content/` is everything on the page. `inline.ts` is the AI menu, `chat.ts` the chat, `page.ts` reads Notion's editor and writes into it by dispatching a paste, which lets Notion turn Markdown into real blocks. When the editor will not take a paste, **Insert below** writes through the API after the right block instead, and failing both, the text goes to the clipboard with a message saying so.
- `src/lib/commands.ts` is the AI menu as data: every command, where it appears, and the exact prompt it sends. `prompt.ts` is the chat's system prompt.
- `src/background/` runs requests in the service worker, keeps it alive through long tool calls, records changes, and undoes them.
- `src/lib/` is shared with the desktop app: the Notion client and tools, Markdown ⇄ blocks, providers, undo.

## License

MIT
