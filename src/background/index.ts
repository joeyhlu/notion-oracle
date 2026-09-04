/** Service worker: runs the agent loop and brokers page tools to the Notion tab. */

import { AnthropicProvider, describeAnthropicError } from "../lib/providers/anthropic.ts";
import { OpenAIProvider, describeOpenAIError } from "../lib/providers/openai.ts";
import type { Provider } from "../lib/providers/types.ts";
import { NotionClient } from "../lib/notion.ts";
import { buildSystemPrompt, buildUserTurn } from "../lib/prompt.ts";
import { ALL_TOOLS, PAGE_TOOLS, createToolExecutor } from "../lib/tools.ts";
import { activeApiKey, loadSettings, providerLabel } from "../shared/settings.ts";
import { CHAT_PORT_NAME, type BackgroundToPanel, type PageToolResponse, type PanelToBackground, type RuntimeMessage, type Settings } from "../shared/types.ts";

const NOTION_HOST = /^https:\/\/(www\.notion\.so|[^/]+\.notion\.site)\//;

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    const settings = await loadSettings();
    if (!activeApiKey(settings)) void chrome.runtime.openOptionsPage();
  }
});

async function togglePanel(tab?: chrome.tabs.Tab) {
  const target = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!target?.id || !target.url || !NOTION_HOST.test(target.url)) {
    void chrome.runtime.openOptionsPage();
    return;
  }
  try {
    await chrome.tabs.sendMessage(target.id, { type: "toggle-panel" } satisfies RuntimeMessage);
  } catch {
    // Content script not loaded yet (tab opened before install); reload injects it.
    await chrome.tabs.reload(target.id);
  }
}

chrome.action.onClicked.addListener((tab) => void togglePanel(tab));
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-panel") void togglePanel();
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type === "open-options") {
    void chrome.runtime.openOptionsPage();
    return false;
  }
  if (message.type === "get-provider-label") {
    void loadSettings().then((s) => sendResponse(providerLabel(s)));
    return true;
  }
  return false;
});

function createProvider(settings: Settings, history: unknown[] | null): Provider {
  if (settings.provider === "openai") {
    if (!settings.openaiApiKey) throw new Error("No OpenAI API key configured. Open Oracle settings (gear icon) to add one.");
    return new OpenAIProvider({ apiKey: settings.openaiApiKey, model: settings.openaiModel, history });
  }
  if (!settings.anthropicApiKey) throw new Error("No Anthropic API key configured. Open Oracle settings (gear icon) to add one.");
  return new AnthropicProvider({ apiKey: settings.anthropicApiKey, model: settings.anthropicModel, effort: settings.effort, history });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CHAT_PORT_NAME) return;
  const tabId = port.sender?.tab?.id;
  let controller: AbortController | null = null;
  const post = (msg: BackgroundToPanel) => {
    try {
      port.postMessage(msg);
    } catch {
      // Panel went away; nothing to do.
    }
  };

  port.onMessage.addListener(async (message: PanelToBackground) => {
    if (message.type === "abort") {
      controller?.abort();
      return;
    }
    if (message.type !== "chat") return;
    if (tabId === undefined) {
      post({ type: "error", message: "Oracle must be used from a Notion tab.", history: message.history });
      return;
    }
    controller = new AbortController();
    const settings = await loadSettings();
    let provider: Provider | null = null;
    try {
      provider = createProvider(settings, message.history);
      const notion = settings.notionToken ? new NotionClient(settings.notionToken) : null;
      const execute = createToolExecutor({
        notion,
        currentPageId: message.context.pageId,
        runPageTool: async (name, input) => {
          const res = (await chrome.tabs.sendMessage(tabId, { type: "page-tool", name, input } satisfies RuntimeMessage)) as PageToolResponse | undefined;
          return res ?? { ok: false, content: "The Notion tab did not respond." };
        },
      });
      await provider.send(buildUserTurn(message.text, message.context), {
        system: buildSystemPrompt({ hasNotionApi: Boolean(notion), customInstructions: settings.customInstructions }),
        tools: notion ? ALL_TOOLS : PAGE_TOOLS,
        execute,
        signal: controller.signal,
        events: {
          onText: (delta) => post({ type: "text", delta }),
          onToolStart: (id, name, input) => post({ type: "tool-start", id, name, input }),
          onToolEnd: (id, name, ok, summary) => post({ type: "tool-end", id, name, ok, summary }),
        },
      });
      post({ type: "done", history: provider.exportHistory(), providerLabel: provider.label });
    } catch (error) {
      const aborted = controller.signal.aborted;
      const message_ = aborted ? "Stopped." : settings.provider === "openai" ? describeOpenAIError(error) : describeAnthropicError(error);
      // Drop the dangling user turn so the next message starts from a consistent history.
      const history = provider ? trimDanglingTurn(provider.exportHistory()) : message.history;
      post({ type: "error", message: message_, history });
    } finally {
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
