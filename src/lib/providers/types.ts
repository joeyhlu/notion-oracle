/** Provider-neutral contracts for the agent loop. */

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

export interface ToolOutcome {
  ok: boolean;
  content: string;
}

export type ToolExecutor = (name: string, input: Record<string, unknown>) => Promise<ToolOutcome>;

export interface TurnEvents {
  onText(delta: string): void;
  onToolStart(id: string, name: string, input: unknown): void;
  onToolEnd(id: string, name: string, ok: boolean, summary: string): void;
}

export interface TurnContext {
  system: string;
  tools: ToolDefinition[];
  execute: ToolExecutor;
  events: TurnEvents;
  signal: AbortSignal;
}

/**
 * A chat provider owns its own message history in the provider's native format so
 * that tool calls, tool results and thinking blocks round-trip exactly. The history is
 * exposed as opaque JSON so the panel can persist it across service-worker restarts.
 */
export interface Provider {
  readonly label: string;
  send(userText: string, ctx: TurnContext): Promise<string>;
  exportHistory(): unknown[];
}

export const MAX_TOOL_ITERATIONS = 24;

export function summarizeToolResult(content: string, max = 160): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
