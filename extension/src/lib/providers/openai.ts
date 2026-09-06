import OpenAI from "openai";
import { MAX_TOOL_ITERATIONS, summarizeToolResult, type Provider, type TurnContext } from "./types.ts";

export interface OpenAIOptions {
  apiKey: string;
  model: string;
  history?: unknown[] | null;
}

interface PendingCall {
  id: string;
  name: string;
  args: string;
}

/** Streams a turn with the OpenAI Chat Completions API and function calling. */
export class OpenAIProvider implements Provider {
  readonly label: string;
  private readonly client: OpenAI;
  private history: OpenAI.Chat.ChatCompletionMessageParam[];

  private readonly opts: OpenAIOptions;

  constructor(opts: OpenAIOptions) {
    this.opts = opts;
    this.client = new OpenAI({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
    this.history = (opts.history as OpenAI.Chat.ChatCompletionMessageParam[] | null | undefined) ?? [];
    this.label = `ChatGPT · ${opts.model}`;
  }

  exportHistory(): unknown[] {
    return this.history;
  }

  async send(userText: string, ctx: TurnContext): Promise<string> {
    // The system prompt is stable for the life of a conversation; refresh it in place.
    if (this.history[0]?.role === "system") this.history[0] = { role: "system", content: ctx.system };
    else this.history.unshift({ role: "system", content: ctx.system });
    this.history.push({ role: "user", content: userText });

    const tools: OpenAI.Chat.ChatCompletionTool[] = ctx.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));

    let text = "";
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const stream = await this.client.chat.completions.create(
        { model: this.opts.model, messages: this.history, tools, stream: true },
        { signal: ctx.signal },
      );
      let turnText = "";
      const calls = new Map<number, PendingCall>();
      let finishReason: string | null = null;
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (delta.content) {
          turnText += delta.content;
          text += delta.content;
          ctx.events.onText(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const slot = calls.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          calls.set(tc.index, slot);
        }
      }

      const toolCalls = [...calls.values()];
      this.history.push({
        role: "assistant",
        content: turnText || null,
        ...(toolCalls.length
          ? { tool_calls: toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.args } })) }
          : {}),
      });

      if (!toolCalls.length) {
        if (finishReason === "length") ctx.events.onText("\n\n_(response truncated: max tokens reached)_");
        break;
      }

      for (const call of toolCalls) {
        let input: Record<string, unknown> = {};
        let parseError: string | null = null;
        try {
          input = call.args ? (JSON.parse(call.args) as Record<string, unknown>) : {};
        } catch (e) {
          parseError = `Could not parse tool arguments: ${(e as Error).message}`;
        }
        ctx.events.onToolStart(call.id, call.name, input);
        const outcome = parseError ? { ok: false, content: parseError } : await ctx.execute(call.name, input);
        ctx.events.onToolEnd(call.id, call.name, outcome.ok, summarizeToolResult(outcome.content));
        this.history.push({ role: "tool", tool_call_id: call.id, content: outcome.ok ? outcome.content : `ERROR: ${outcome.content}` });
      }
      if (turnText) {
        text += "\n\n";
        ctx.events.onText("\n\n");
      }
    }
    return text;
  }
}

export function describeOpenAIError(error: unknown): string {
  if (error instanceof OpenAI.AuthenticationError) return "OpenAI rejected the API key. Check it in Oracle settings.";
  if (error instanceof OpenAI.RateLimitError) return "OpenAI rate limit hit. Wait a moment and try again.";
  if (error instanceof OpenAI.NotFoundError) return "OpenAI model not found. Check the model id in Oracle settings.";
  if (error instanceof OpenAI.APIError) return `OpenAI API error ${error.status}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
