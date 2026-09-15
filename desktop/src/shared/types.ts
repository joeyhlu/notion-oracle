/** Contract between the Electron main process and the renderer. */

import type { Change } from "./journal.ts";
import type { Conversation, ConversationSummary } from "./conversations.ts";

export type { Change } from "./journal.ts";
export type { Conversation, ConversationSummary, Message } from "./conversations.ts";

export type BrainId = "claude" | "codex";

export type Theme = "system" | "light" | "dark";

export const THEMES: readonly Theme[] = ["system", "light", "dark"];

/** Narrows an unvalidated value (a DOM dataset, a hand-edited settings file) to a Theme. */
export function asTheme(value: unknown): Theme {
  return THEMES.includes(value as Theme) ? (value as Theme) : "system";
}

export interface Settings {
  brain: BrainId;
  /** Explicit CLI paths; empty means auto-detect. */
  claudePath: string;
  codexPath: string;
  notionToken: string;
  /** Optional model override passed to the CLI. Empty uses the CLI's default. */
  model: string;
  hotkey: string;
  customInstructions: string;
  /** Show the overlay only while the Notion app is in the foreground. */
  followNotion: boolean;
  /** Let Oracle operate the Notion Calendar desktop app to create events. */
  calendarAutomation: boolean;
  /** Press Enter to save created events instead of leaving them open for the user to confirm. */
  calendarAutoSave: boolean;
  /** How to drive the app: jump-to-day + C, or the Cmd+K natural-language command bar. */
  calendarStrategy: "new-event-key" | "command-bar";
  /**
   * "system" scripts the macOS Calendar app: real create/read/update/delete against the user's
   * account. "notion-app" falls back to typing into Notion Calendar, which cannot read anything.
   */
  calendarBackend: "system" | "notion-app";
  /**
   * Search the text inside pages, not just their titles.
   *
   * Off by default because answering one question reads every candidate page, which is slower and
   * uses more of the AI subscription than a title search.
   */
  contentSearch: boolean;
  /**
   * Read and write many database rows at once, for filling a property across a table.
   *
   * Off by default because one instruction can rewrite a whole table. Every row it writes is
   * journalled separately, so a single wrong value can be undone without reverting the pass.
   */
  bulkEdit: boolean;
  /** "system" follows the OS appearance; the other two override it. */
  theme: Theme;
  /**
   * Read the text highlighted in Notion and include it with the message.
   *
   * Separate from everything else because it needs the macOS Accessibility permission, which is
   * broader than the rest of what Oracle does: it is the one grant that could read other apps.
   *
   * Off until asked for. Reading the selection is what triggers the permission prompt, and it
   * happens on every panel open, so defaulting it on would greet an upgrading user with a
   * request to control their computer that they never went looking for.
   */
  readSelection: boolean;
  setupComplete: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  brain: "claude",
  claudePath: "",
  codexPath: "",
  notionToken: "",
  model: "",
  hotkey: "CommandOrControl+Shift+Space",
  customInstructions: "",
  followNotion: true,
  calendarAutomation: true,
  calendarAutoSave: false,
  calendarStrategy: "new-event-key",
  calendarBackend: "system",
  contentSearch: false,
  bulkEdit: false,
  theme: "system",
  readSelection: false,
  setupComplete: false,
};

export interface BrainStatus {
  brain: BrainId;
  installed: boolean;
  path: string | null;
  version: string | null;
  /** null = could not determine */
  loggedIn: boolean | null;
  detail: string;
}

/** Every event carries the run it belongs to; the renderer ignores any other. */
export type ChatEvent = { runId?: string } & (
  | { type: "status"; message: string }
  | { type: "text"; delta: string }
  | { type: "tool-start"; id: string; name: string; input: unknown }
  | { type: "tool-end"; id: string; name: string; ok: boolean; summary: string }
  /** `changes` is attached by the main process; a brain does not know what its tools touched. */
  | { type: "done"; threadId: string | null; text: string; changes?: Change[]; conversationId?: string }
  | { type: "error"; message: string; threadId: string | null }
);

export interface ChatRequest {
  text: string;
  /**
   * Identifies this run, echoed back on every event it produces.
   *
   * Without it the renderer cannot tell a late event from a current one: aborting a reply and
   * starting a new chat leaves the old run finishing in the main process, and its "done" would
   * land on the new turn and hand it back the thread it was told to forget.
   */
  runId: string;
  threadId: string | null;
  /** Which saved conversation this turn belongs to, so the main process can record it. */
  conversationId: string | null;
}

export interface PageHint {
  /** Title of the Notion window in front, if the Notion desktop app is running. */
  notionWindowTitle: string | null;
  /** Why the title is missing, so the model can say what to fix rather than "I can't see it". */
  windowStatus?: "ok" | "not-running" | "no-permission" | "no-title";
  /** Text highlighted in the Notion app, when macOS accessibility permission allows reading it. */
  selection?: string | null;
}

export type OverlayMode = "collapsed" | "expanded";

export const BRAIN_LABELS: Record<BrainId, string> = { claude: "Claude (via Claude Code)", codex: "ChatGPT (via Codex CLI)" };

export const INSTALL_DOCS: Record<BrainId, string> = {
  claude: "https://code.claude.com/docs/en/quickstart",
  codex: "https://developers.openai.com/codex/cli",
};

export const INSTALL_COMMANDS: Record<BrainId, { mac: string; win: string; npm: string }> = {
  claude: { mac: "curl -fsSL https://claude.ai/install.sh | bash", win: "irm https://claude.ai/install.ps1 | iex", npm: "npm install -g @anthropic-ai/claude-code" },
  codex: { mac: "brew install codex", win: "npm install -g @openai/codex", npm: "npm install -g @openai/codex" },
};

export const SIGN_IN_COMMANDS: Record<BrainId, string> = { claude: "claude auth login", codex: "codex login" };

/** API exposed to the renderer by the preload script. */
export interface OracleApi {
  getSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  checkBrain(brain: BrainId, pathOverride?: string): Promise<BrainStatus>;
  openSignIn(brain: BrainId): Promise<void>;
  openExternal(url: string): Promise<void>;
  testNotion(token: string): Promise<{ ok: boolean; message: string }>;
  getPageHint(): Promise<PageHint>;
  platform(): Promise<NodeJS.Platform>;
  chatSend(request: ChatRequest): Promise<void>;
  chatAbort(): Promise<void>;
  /** Everything Oracle has changed, newest first. */
  getChanges(): Promise<Change[]>;
  undoChange(id: string): Promise<{ ok: boolean; message: string }>;
  clearChanges(): Promise<void>;
  listConversations(): Promise<ConversationSummary[]>;
  getConversation(id: string): Promise<Conversation | null>;
  deleteConversation(id: string): Promise<void>;
  onChatEvent(callback: (event: ChatEvent) => void): () => void;
  setMode(mode: OverlayMode): Promise<void>;
  onMode(callback: (mode: OverlayMode) => void): () => void;
  quit(): Promise<void>;
}

declare global {
  interface Window {
    oracle: OracleApi;
  }
}
