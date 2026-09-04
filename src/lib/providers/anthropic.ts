import Anthropic from "@anthropic-ai/sdk";
import { MAX_TOOL_ITERATIONS, summarizeToolResult, type Provider, type TurnContext } from "./types.ts";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high";
  history?: unknown[] | null;
}

/** Streams a turn with the Claude Messages API, running tools in a manual loop so the panel gets live text and tool events. */
export class AnthropicProvider implements Provider {
  readonly label: string;
  private readonly client: Anthropic;
  private history: Anthropic.Beta.BetaMessageParam[];

  private readonly opts: AnthropicOptions;

  constructor(opts: AnthropicOptions) {
    this.opts = opts;
    this.client = new Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
    this.history = (opts.history as Anthropic.Beta.BetaMessageParam[] | null | undefined) ?? [];
    this.label = `Claude · ${opts.model}`;
  }

  exportHistory(): unknown[] {
    return this.history;
  }

  async send(userText: string, ctx: TurnContext): Promise<string> {
    this.history.push({ role: "user", content: userText });
    const tools: Anthropic.Beta.BetaTool[] = ctx.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
    const model = this.opts.model;
    const supportsEffort = !/haiku|sonnet-4-5|opus-4-5/.test(model);
    const supportsFallbacks = /^claude-(opus-5|fable)/.test(model);

    let text = "";
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const stream = this.client.beta.messages.stream(
        {
          model,
          max_tokens: 16000,
          system: [{ type: "text", text: ctx.system, cache_control: { type: "ephemeral" } }],
          tools,
          messages: this.history,
          ...(supportsEffort ? { output_config: { effort: this.opts.effort } } : {}),
          // Server-side refusal fallback: if the primary model declines for policy reasons the
          // request is re-run on a fallback model inside the same call.
          ...(supportsFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
        },
        { signal: ctx.signal },
      );
      stream.on("text", (delta) => {
        text += delta;
        ctx.events.onText(delta);
      });
      const message = await stream.finalMessage();
      this.history.push({ role: "assistant", content: message.content });

      if (message.stop_reason === "pause_turn") continue;
      if (message.stop_reason === "refusal") {
        const why = message.stop_details?.type === "refusal" ? message.stop_details.explanation : undefined;
        throw new Error(`Claude declined this request${why ? `: ${why}` : "."}`);
      }
      if (message.stop_reason === "max_tokens") {
        ctx.events.onText("\n\n_(response truncated: max tokens reached)_");
        break;
      }
      if (message.stop_reason !== "tool_use") break;

      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of toolUses) {
        ctx.events.onToolStart(use.id, use.name, use.input);
        const outcome = await ctx.execute(use.name, (use.input ?? {}) as Record<string, unknown>);
        ctx.events.onToolEnd(use.id, use.name, outcome.ok, summarizeToolResult(outcome.content));
        results.push({ type: "tool_result", tool_use_id: use.id, content: outcome.content, is_error: !outcome.ok });
      }
      this.history.push({ role: "user", content: results });
      if (text) {
        text += "\n\n";
        ctx.events.onText("\n\n");
      }
    }
    return text;
  }
}

export function describeAnthropicError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key. Check it in Oracle settings.";
  if (error instanceof Anthropic.RateLimitError) return "Anthropic rate limit hit. Wait a moment and try again.";
  if (error instanceof Anthropic.NotFoundError) return "Anthropic model not found. Check the model id in Oracle settings.";
  if (error instanceof Anthropic.APIError) return `Anthropic API error ${error.status}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
