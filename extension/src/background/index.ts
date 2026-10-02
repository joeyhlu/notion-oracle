/**
 * Service worker: runs the chat agent and AI-menu completions, brokers page tools to the Notion
 * tab, keeps the change list, and opens setup on first install.
 */

import { AnthropicProvider, describeAnthropicError } from "../lib/providers/anthropic.ts";
import { OpenAIProvider, describeOpenAIError } from "../lib/providers/openai.ts";
import type { Provider } from "../lib/providers/types.ts";
import { NotionClient, databaseTitle, pageTitle, type NotionDataSource, type NotionPage } from "../lib/notion.ts";
import { markdownToBlocks } from "../lib/markdown.ts";
import { buildSystemPrompt, buildUserTurn } from "../lib/prompt.ts";
import { inlineSystemPrompt } from "../lib/commands.ts";
import { PAGE_TOOLS, createToolExecutor, notionTools, type RecordedChange } from "../lib/tools.ts";
import { isNotionUndoStep, undoNotionChange } from "../lib/undo.ts";
import { MAX_CHANGES } from "../lib/conversations.ts";
import { activeApiKey, loadSettings, shortModelLabel } from "../shared/settings.ts";
import {
  CHAT_PORT_NAME,
  type BackgroundToPanel,
  type PageToolResponse,
  type PanelToBackground,
  type RuntimeMessage,
  type Settings,
  type Status,
  type StoredChange,
} from "../shared/types.ts";

const NOTION_HOST = /^https:\/\/(www\.notion\.so|[^/]+\.notion\.site)\//;
const VERSION = chrome.runtime.getManifest().version;

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    const settings = await loadSettings();
    if (!activeApiKey(settings)) void chrome.tabs.create({ url: chrome.runtime.getURL("options.html?welcome=1") });
  }
  if (details.reason === "install" || details.reason === "update") void injectIntoOpenTabs();
});

/**
 * Notion tabs that were open before the install (or an update) have no content script, so the
 * AI menu and the shortcuts would do nothing until the user reloaded them. Put Oracle there now.
 */
async function injectIntoOpenTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ["https://www.notion.so/*", "https://*.notion.site/*"] });
  await Promise.all(tabs.map((tab) => (tab.id === undefined ? null : chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => null))));
}

async function togglePanel(tab?: chrome.tabs.Tab): Promise<void> {
  const target = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!target?.id || !target.url || !NOTION_HOST.test(target.url)) {
    const settings = await loadSettings();
    // Off Notion, the icon goes where the user can do something: setup if it is not done yet,
    // otherwise Notion itself.
    if (!activeApiKey(settings)) void chrome.runtime.openOptionsPage();
    else void chrome.tabs.create({ url: "https://www.notion.so/" });
    return;
  }
  try {
    await chrome.tabs.sendMessage(target.id, { type: "toggle-panel" } satisfies RuntimeMessage);
  } catch {
    // The tab was open before the extension was installed, so it has no content script yet.
    const tabId = target.id;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      setTimeout(() => void chrome.tabs.sendMessage(tabId, { type: "toggle-panel" } satisfies RuntimeMessage).catch(() => {}), 300);
    } catch {
      await chrome.tabs.reload(tabId);
    }
  }
}

chrome.action.onClicked.addListener((tab) => void togglePanel(tab));
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-panel") void togglePanel(tab);
});

// ---------- the change list ----------

async function readChanges(): Promise<StoredChange[]> {
  const stored = await chrome.storage.local.get("changes");
  return (stored.changes as StoredChange[] | undefined) ?? [];
}

async function writeChanges(changes: StoredChange[]): Promise<void> {
  await chrome.storage.local.set({ changes: changes.slice(0, MAX_CHANGES) });
}

/** Changes arrive in quick succession from one turn; chain the writes so none overwrites another. */
let changeQueue: Promise<unknown> = Promise.resolve();

function recordChange(change: RecordedChange): Promise<StoredChange> {
  const stored: StoredChange = {
    id: `ch${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    label: change.label,
    url: change.url,
    undo: change.undo as StoredChange["undo"],
  };
  const write = changeQueue.then(async () => writeChanges([stored, ...(await readChanges())]));
  changeQueue = write.catch(() => {});
  return write.then(() => stored);
}

async function undoStoredChange(id: string): Promise<{ ok: boolean; message: string }> {
  const changes = await readChanges();
  const change = changes.find((c) => c.id === id);
  if (!change) return { ok: false, message: "That change is no longer in the list." };
  if (change.undone) return { ok: true, message: "Already undone." };
  const settings = await loadSettings();
  if (!settings.notionToken) return { ok: false, message: "Connect Notion in settings to undo changes." };
  if (!isNotionUndoStep(change.undo)) return { ok: false, message: "This change cannot be undone automatically." };
  try {
    const result = await undoNotionChange(new NotionClient(settings.notionToken), change.undo);
    change.undone = result.ok;
    change.error = result.ok ? undefined : result.message;
    await writeChanges(changes);
    return result;
  } catch (error) {
    change.error = error instanceof Error ? error.message : String(error);
    await writeChanges(changes);
    return { ok: false, message: change.error };
  }
}

// ---------- one-off messages ----------

async function status(): Promise<Status> {
  const s = await loadSettings();
  return {
    configured: Boolean(activeApiKey(s)),
    provider: s.provider,
    providerLabel: shortModelLabel(s),
    hasNotion: Boolean(s.notionToken),
    webSearch: s.provider === "anthropic" && s.webSearch,
    aiShortcut: s.aiShortcut,
    selectionButton: s.selectionButton,
    floatingButton: s.floatingButton,
    version: VERSION,
  };
}

type PageHit = { id: string; title: string; url: string; kind: "page" | "database" };

async function searchPages(query: string): Promise<{ ok: boolean; pages?: PageHit[]; message?: string }> {
  const s = await loadSettings();
  if (!s.notionToken) return { ok: false, message: "Connect Notion in settings to mention pages." };
  try {
    const results = await new NotionClient(s.notionToken).search(query, undefined, 8);
    return {
      ok: true,
      pages: results.map((r) => {
        const object = (r as { object?: string }).object;
        const isDb = object === "data_source" || object === "database";
        return {
          id: r.id,
          title: isDb ? databaseTitle(r as NotionDataSource) : pageTitle(r as NotionPage),
          url: String((r as { url?: string }).url ?? ""),
          kind: isDb ? "database" : "page",
        };
      }),
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** The AI menu's "Insert below" when typing into the page did not take: write it through the API. */
async function insertAfterBlock(blockId: string, markdown: string): Promise<{ ok: boolean; message: string }> {
  const s = await loadSettings();
  if (!s.notionToken) return { ok: false, message: "Not connected to Notion." };
  try {
    const notion = new NotionClient(s.notionToken);
    const created = await notion.insertBlocksAfter(blockId, markdownToBlocks(markdown));
    const ids = created.map((b) => b.id);
    await recordChange({ kind: "block", action: "create", label: `Inserted ${ids.length} block${ids.length === 1 ? "" : "s"} from the AI menu`, undo: { type: "delete-blocks", blockIds: ids } });
    return { ok: true, message: `Inserted ${ids.length} blocks.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  switch (message.type) {
    case "open-options":
      void chrome.runtime.openOptionsPage();
      return false;
    case "get-status":
      void status().then(sendResponse);
      return true;
    case "search-pages":
      void searchPages(message.query).then(sendResponse);
      return true;
    case "insert-after-block":
      void insertAfterBlock(message.blockId, message.markdown).then(sendResponse);
      return true;
    case "undo-change":
      void undoStoredChange(message.id).then(sendResponse);
      return true;
    default:
      return false;
  }
});

// ---------- the chat and AI-menu port ----------

class SetupError extends Error {}

function createProvider(settings: Settings, history: unknown[] | null): Provider {
  if (settings.provider === "openai") {
    if (!settings.openaiApiKey) throw new SetupError("Add your OpenAI API key in Oracle settings to start.");
    return new OpenAIProvider({ apiKey: settings.openaiApiKey, model: settings.openaiModel, history });
  }
  if (!settings.anthropicApiKey) throw new SetupError("Add your Anthropic API key in Oracle settings to start.");
  return new AnthropicProvider({ apiKey: settings.anthropicApiKey, model: settings.anthropicModel, effort: settings.effort, history });
}

/**
 * A service worker is stopped after 30 seconds without extension events. A long tool call (a
 * workspace search reads many pages) sends none, so a cheap API call every 20 seconds keeps the
 * worker alive for the length of a turn.
 */
function keepAlive(): () => void {
  const timer = setInterval(() => void chrome.runtime.getPlatformInfo(), 20000);
  return () => clearInterval(timer);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CHAT_PORT_NAME) return;
  const tabId = port.sender?.tab?.id;
  let controller: AbortController | null = null;
  const post = (msg: BackgroundToPanel) => {
    try {
      port.postMessage(msg);
    } catch {
      // The panel went away; nothing to do.
    }
  };
  port.onDisconnect.addListener(() => controller?.abort());

  port.onMessage.addListener(async (message: PanelToBackground) => {
    if (message.type === "abort") {
      controller?.abort();
      return;
    }
    controller = new AbortController();
    const signal = controller.signal;
    const stop = keepAlive();
    const settings = await loadSettings();
    let provider: Provider | null = null;
    const events = {
      onText: (delta: string) => post({ type: "text", delta }),
      onToolStart: (id: string, name: string, input: unknown) => post({ type: "tool-start", id, name, input }),
      onToolEnd: (id: string, name: string, ok: boolean, summary: string) => post({ type: "tool-end", id, name, ok, summary }),
      onSources: (sources: Array<{ title: string; url: string }>) => post({ type: "sources", sources }),
    };
    try {
      provider = createProvider(settings, message.history);
      if (message.type === "inline") {
        await provider.send(message.prompt, { system: inlineSystemPrompt(settings.customInstructions), tools: [], execute: async () => ({ ok: false, content: "No tools here." }), signal, events });
      } else {
        if (tabId === undefined) throw new Error("Oracle must be used from a Notion tab.");
        const notion = settings.notionToken ? new NotionClient(settings.notionToken) : null;
        const execute = createToolExecutor({
          notion,
          currentPageId: message.context.includePage === false ? null : message.context.pageId,
          runPageTool: async (name, input) => {
            const res = (await chrome.tabs.sendMessage(tabId, { type: "page-tool", name, input } satisfies RuntimeMessage)) as PageToolResponse | undefined;
            return res ?? { ok: false, content: "The Notion tab did not respond." };
          },
          recordChange: (change) => void recordChange(change).then((stored) => post({ type: "change", change: stored })),
        });
        // The setting allows web search; the toggle in the composer can turn it off for a message.
        const webSearch = settings.provider === "anthropic" && settings.webSearch && message.webSearch !== false;
        const tools = notion ? [...PAGE_TOOLS, ...notionTools({ contentSearch: settings.workspaceSearch, bulkEdit: settings.bulkEdit })] : PAGE_TOOLS;
        await provider.send(buildUserTurn(message.text, message.context), {
          system: buildSystemPrompt({ hasNotionApi: Boolean(notion), workspaceSearch: settings.workspaceSearch, bulkEdit: settings.bulkEdit, webSearch, customInstructions: settings.customInstructions }),
          tools,
          execute,
          signal,
          webSearch,
          events,
        });
      }
      post({ type: "done", history: provider.exportHistory(), providerLabel: shortModelLabel(settings) });
    } catch (error) {
      const setup = error instanceof SetupError;
      const text = signal.aborted ? "Stopped." : setup ? (error as Error).message : settings.provider === "openai" ? describeOpenAIError(error) : describeAnthropicError(error);
      // Drop the dangling user turn so the next message starts from a consistent history.
      const history = provider ? trimDanglingTurn(provider.exportHistory()) : message.history;
      post({ type: "error", message: text, history, needsSetup: setup || /API key|settings/i.test(text) });
    } finally {
      stop();
      controller = null;
    }
  });
});

/** Drop trailing turns until the history ends with an assistant reply that is not waiting on tool results. */
function trimDanglingTurn(history: unknown[]): unknown[] {
  const out = [...history];
  while (out.length) {
    const last = out[out.length - 1] as { role?: string; content?: unknown; tool_calls?: unknown[] } | undefined;
    const waitingOnTools =
      (Array.isArray(last?.tool_calls) && last.tool_calls.length > 0) ||
      (Array.isArray(last?.content) && (last.content as Array<{ type?: string }>).some((b) => b.type === "tool_use"));
    if (last?.role === "assistant" && !waitingOnTools) break;
    out.pop();
  }
  return out;
}
