/** Shared types for messages between the page (content script), the settings page and the service worker. */

export type ProviderId = "anthropic" | "openai";

export interface Settings {
  /** Bumped when a default changes in a way stored settings should pick up. */
  version: number;
  provider: ProviderId;
  anthropicApiKey: string;
  anthropicModel: string;
  openaiApiKey: string;
  openaiModel: string;
  notionToken: string;
  /** Reasoning effort for Claude models that support it. */
  effort: "low" | "medium" | "high";
  /** Extra instructions the user wants Oracle to always follow. */
  customInstructions: string;
  /** Let Claude search the web when a question needs it (Claude only). */
  webSearch: boolean;
  /** Search inside pages, not just titles, to answer questions about the workspace. */
  workspaceSearch: boolean;
  /** Read and fill a property across many database rows at once. */
  bulkEdit: boolean;
  /** Cmd/Ctrl+J opens the AI menu, as it does in Notion AI. */
  aiShortcut: boolean;
  /** Show an "Ask AI" button under selected text. */
  selectionButton: boolean;
  /** Show the Oracle button in the corner of Notion. */
  floatingButton: boolean;
}

export const SETTINGS_VERSION = 2;

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  provider: "anthropic",
  anthropicApiKey: "",
  anthropicModel: "claude-opus-5-5",
  openaiApiKey: "",
  openaiModel: "gpt-5.5",
  notionToken: "",
  effort: "medium",
  customInstructions: "",
  webSearch: true,
  workspaceSearch: true,
  bulkEdit: true,
  aiShortcut: true,
  selectionButton: true,
  floatingButton: true,
};

export interface ModelChoice {
  id: string;
  label: string;
  note: string;
}

export const CLAUDE_MODELS: ModelChoice[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "Best for most work" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "Faster and cheaper" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", note: "Fastest, cheapest" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", note: "Most capable, costs more" },
];

export const OPENAI_MODELS: ModelChoice[] = [
  { id: "gpt-5.5", label: "GPT-5.5", note: "Best for most work" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini", note: "Faster and cheaper" },
];

/** What the page knows when a message is sent. */
export interface PageContext {
  url: string;
  title: string;
  pageId: string | null;
  selection: string;
  /** Pages the user @-mentioned in the message. */
  mentions?: Array<{ id: string; title: string }>;
  /** False when the user switched off "use this page" for the message. */
  includePage?: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  pageId: string | null;
  markdown: string;
}

/** Tools that must run inside the Notion tab (DOM access). */
export type PageToolName = "read_current_page" | "get_selection" | "insert_at_cursor" | "replace_selection";

export interface PageToolRequest {
  type: "page-tool";
  name: PageToolName;
  input: Record<string, unknown>;
}

export interface PageToolResponse {
  ok: boolean;
  content: string;
}

export interface Source {
  title: string;
  url: string;
}

/** Panel -> service worker, over a long-lived port. */
export type PanelToBackground =
  | { type: "chat"; text: string; context: PageContext; history: unknown[] | null; conversationId: string | null; webSearch?: boolean }
  | { type: "inline"; prompt: string; history: unknown[] | null }
  | { type: "abort" };

/** Service worker -> panel. */
export type BackgroundToPanel =
  | { type: "text"; delta: string }
  | { type: "tool-start"; id: string; name: string; input: unknown }
  | { type: "tool-end"; id: string; name: string; ok: boolean; summary: string }
  | { type: "sources"; sources: Source[] }
  | { type: "change"; change: StoredChange }
  | { type: "done"; history: unknown[]; providerLabel: string }
  | { type: "error"; message: string; history: unknown[] | null; needsSetup?: boolean };

/** A change Oracle made through the Notion API, with what it takes to reverse it. */
export interface StoredChange {
  id: string;
  at: string;
  label: string;
  url?: string;
  undo?: { type: string; [key: string]: unknown };
  undone?: boolean;
  /** Set when an undo was attempted and failed. */
  error?: string;
}

/** One-off runtime messages. */
export type RuntimeMessage =
  | { type: "toggle-panel" }
  | { type: "open-ai-menu" }
  | { type: "open-options" }
  | { type: "get-status" }
  | { type: "search-pages"; query: string }
  | { type: "insert-after-block"; blockId: string; markdown: string }
  | { type: "undo-change"; id: string }
  | PageToolRequest;

export interface Status {
  configured: boolean;
  provider: ProviderId;
  providerLabel: string;
  hasNotion: boolean;
  webSearch: boolean;
  aiShortcut: boolean;
  selectionButton: boolean;
  floatingButton: boolean;
  version: string;
}

export const CHAT_PORT_NAME = "notion-oracle-chat";
