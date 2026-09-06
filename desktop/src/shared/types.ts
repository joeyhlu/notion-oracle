/** Contract between the Electron main process and the renderer. */

export type BrainId = "claude" | "codex";

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

export type ChatEvent =
  | { type: "status"; message: string }
  | { type: "text"; delta: string }
  | { type: "tool-start"; id: string; name: string; input: unknown }
  | { type: "tool-end"; id: string; name: string; ok: boolean; summary: string }
  | { type: "done"; threadId: string | null; text: string }
  | { type: "error"; message: string; threadId: string | null };

export interface ChatRequest {
  text: string;
  threadId: string | null;
}

export interface PageHint {
  /** Title of the Notion window in front, if the Notion desktop app is running. */
  notionWindowTitle: string | null;
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
