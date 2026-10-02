import Anthropic from "@anthropic-ai/sdk";
import { MAX_TOOL_ITERATIONS, summarizeToolResult, type Provider, type TurnContext } from "./types.ts";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high";
  history?: unknown[] | null;
}

/** Models that take `output_config.effort`. Haiku 4.5 and the 4.5 generation reject it. */
export function supportsEffort(model: string): boolean {
  return !/haiku|sonnet-4-5|opus-4-5/.test(model);
}

/**
 * Models with server-side refusal fallbacks: if a safety classifier declines, the request is
 * re-run on a fallback model inside the same call instead of failing.
 */
export function supportsFallbacks(model: string): boolean {
  return /^claude-(opus-5|fable|sonnet-5-5)/.test(model);
}

/**
 * The web search tool version a model accepts. The 2026-02-09 version filters results with code
 * execution and needs Opus/Sonnet 4.6 or later; everything else takes the basic version.
 */
export function webSearchToolType(model: string): "web_search_20260209" | "web_search_20250305" {
  return /^claude-(opus-(5|4-[6-9])|sonnet-(5|4-[6-9]))/.test(model) ? "web_search_20260209" : "web_search_20250305";
}

/** The request parameters for one turn, apart from messages. Pure, so it is unit-tested. */
export function requestParams(model: string, effort: AnthropicOptions["effort"], ctx: Pick<TurnContext, "system" | "tools" | "webSearch">) {
  const tools: Anthropic.Beta.BetaToolUnion[] = ctx.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  if (ctx.webSearch) tools.push({ type: webSearchToolType(model), name: "web_search", max_uses: 5 } as Anthropic.Beta.BetaToolUnion);
  return {
    model,
    max_tokens: 32000,
    system: [{ type: "text" as const, text: ctx.system, cache_control: { type: "ephemeral" as const } }],
    ...(tools.length ? { tools } : {}),
    ...(supportsEffort(model) ? { output_config: { effort } } : {}),
    ...(supportsFallbacks(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
  };
}

type SearchResultBlock = { type: "web_search_tool_result"; tool_use_id: string; content: unknown };

/** Titles and URLs from a web search result block; an error result yields none. */
export function searchResultSources(block: SearchResultBlock): Array<{ title: string; url: string }> {
  if (!Array.isArray(block.content)) return [];
  return (block.content as Array<{ type?: string; title?: string; url?: string }>)
    .filter((r) => r.type === "web_search_result" && r.url)
    .map((r) => ({ title: r.title || r.url!, url: r.url! }));
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
    const params = requestParams(this.opts.model, this.opts.effort, ctx);

    let text = "";
    const cited = new Map<string, { title: string; url: string }>();
    const found = new Map<string, { title: string; url: string }>();
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const stream = this.client.beta.messages.stream({ ...params, messages: this.history } as Anthropic.Beta.MessageCreateParamsStreaming, { signal: ctx.signal });
      stream.on("text", (delta) => {
        text += delta;
        ctx.events.onText(delta);
      });
      stream.on("citation", (citation) => {
        const c = citation as { url?: string; title?: string };
        if (c.url) cited.set(c.url, { title: c.title || c.url, url: c.url });
      });
      // Server-side tools (web search) run inside the request; surface them like client tools.
      stream.on("contentBlock", (block) => {
        if (block.type === "server_tool_use") {
          ctx.events.onToolStart(block.id, block.name, block.input);
        } else if (block.type === "web_search_tool_result") {
          const sources = searchResultSources(block as unknown as SearchResultBlock);
          for (const s of sources) found.set(s.url, s);
          const ok = Array.isArray(block.content);
          ctx.events.onToolEnd(block.tool_use_id, "web_search", ok, ok ? `${sources.length} results` : "The search failed.");
        }
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
      if (text && !text.endsWith("\n\n")) {
        text += "\n\n";
        ctx.events.onText("\n\n");
      }
    }
    // Prefer what the answer actually cited; fall back to what the searches returned.
    const sources = [...(cited.size ? cited : found).values()].slice(0, 8);
    if (sources.length) ctx.events.onSources?.(sources);
    return text;
  }
}

export function describeAnthropicError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key. Check it in Oracle settings.";
  if (error instanceof Anthropic.PermissionDeniedError) return "This Anthropic key is not allowed to use that model. Pick another model in Oracle settings.";
  if (error instanceof Anthropic.NotFoundError) return "Anthropic model not found. Pick another model in Oracle settings.";
  if (error instanceof Anthropic.RateLimitError) return "Anthropic rate limit hit. Wait a moment and try again.";
  if (error instanceof Anthropic.APIError) {
    if (/credit balance/i.test(error.message)) return "Your Anthropic account is out of credit. Add credit at console.anthropic.com, then try again.";
    return `Anthropic API error ${error.status ?? ""}: ${error.message}`.trim();
  }
  if (error instanceof Anthropic.APIConnectionError) return "Could not reach Anthropic. Check your internet connection.";
  return error instanceof Error ? error.message : String(error);
}
