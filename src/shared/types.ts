/** Shared types for messages between the panel (content script) and the service worker. */

export type ProviderId = "anthropic" | "openai";

export interface Settings {
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
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "anthropic",
  anthropicApiKey: "",
  anthropicModel: "claude-opus-5",
  openaiApiKey: "",
  openaiModel: "gpt-5.5",
  notionToken: "",
  effort: "medium",
  customInstructions: "",
};

/** What the panel knows about the open page when a message is sent. */
export interface PageContext {
  url: string;
  title: string;
  pageId: string | null;
  selection: string;
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

/** Panel -> service worker, over a long-lived port. */
export type PanelToBackground =
  | { type: "chat"; text: string; context: PageContext; history: unknown[] | null }
  | { type: "abort" };

/** Service worker -> panel. */
export type BackgroundToPanel =
  | { type: "text"; delta: string }
  | { type: "tool-start"; id: string; name: string; input: unknown }
  | { type: "tool-end"; id: string; name: string; ok: boolean; summary: string }
  | { type: "done"; history: unknown[]; providerLabel: string }
  | { type: "error"; message: string; history: unknown[] | null };

/** One-off runtime messages. */
export type RuntimeMessage =
  | { type: "toggle-panel" }
  | { type: "open-options" }
  | { type: "get-provider-label" }
  | PageToolRequest;

export const CHAT_PORT_NAME = "notion-oracle-chat";
