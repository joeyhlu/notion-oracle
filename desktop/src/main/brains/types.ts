import type { BrainId, ChatEvent } from "../../shared/types.ts";

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  toolNames: string[];
}

export interface BrainRunOptions {
  cliPath: string;
  prompt: string;
  systemPrompt: string;
  threadId: string | null;
  mcp: McpServerSpec;
  model: string;
  cwd: string;
  /** Directory for temp files (mcp config, system prompt). */
  tempDir: string;
  signal: AbortSignal;
  onEvent: (event: ChatEvent) => void;
}

export interface BrainResult {
  threadId: string | null;
  text: string;
}

export interface Brain {
  readonly id: BrainId;
  run(options: BrainRunOptions): Promise<BrainResult>;
}

export function summarize(content: unknown, max = 160): string {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : JSON.stringify(c))).join(" ") : JSON.stringify(content ?? "");
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Strip the mcp__server__ prefix for display. */
export function displayToolName(name: string): string {
  return name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
}
