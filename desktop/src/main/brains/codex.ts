/**
 * Drives OpenAI's Codex CLI in non-interactive mode (`codex exec --json`), so the app uses the
 * user's ChatGPT sign-in. The MCP server is passed as config overrides so the user's own
 * ~/.codex/config.toml is left untouched.
 */

import type { ChatEvent } from "../../shared/types.ts";
import { spawnCli } from "../process.ts";
import { summarize, type Brain, type BrainResult, type BrainRunOptions } from "./types.ts";

export interface CodexParseState {
  threadId: string | null;
  text: string;
  done: boolean;
}

export function newCodexState(): CodexParseState {
  return { threadId: null, text: "", done: false };
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  server?: string;
  tool?: string;
  name?: string;
  arguments?: unknown;
  status?: string;
  result?: unknown;
  output?: unknown;
  error?: unknown;
}

/** Turn one `codex exec --json` line into UI events. Pure, so it is unit-testable. */
export function parseCodexLine(line: string, state: CodexParseState): ChatEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }
  const events: ChatEvent[] = [];
  const item = (msg.item ?? {}) as CodexItem;
  switch (msg.type) {
    case "thread.started":
      if (typeof msg.thread_id === "string") state.threadId = msg.thread_id;
      break;
    case "item.started":
      if (item.type === "mcp_tool_call") {
        events.push({ type: "tool-start", id: item.id ?? `${item.tool ?? item.name}`, name: item.tool ?? item.name ?? "tool", input: item.arguments });
      }
      break;
    case "item.completed":
      if (item.type === "mcp_tool_call") {
        const failed = item.status === "failed" || item.error !== undefined;
        events.push({ type: "tool-end", id: item.id ?? `${item.tool ?? item.name}`, name: item.tool ?? item.name ?? "tool", ok: !failed, summary: summarize(item.error ?? item.result ?? item.output ?? "") });
      } else if (item.type === "agent_message" && item.text) {
        const delta = (state.text ? "\n\n" : "") + item.text;
        state.text += delta;
        events.push({ type: "text", delta });
      }
      break;
    case "turn.completed":
      state.done = true;
      events.push({ type: "done", threadId: state.threadId, text: state.text });
      break;
    case "turn.failed":
    case "error": {
      const message = typeof msg.message === "string" ? msg.message : typeof (msg.error as { message?: string } | undefined)?.message === "string" ? (msg.error as { message: string }).message : "Codex reported an error.";
      events.push({ type: "error", message, threadId: state.threadId });
      break;
    }
    default:
      break;
  }
  return events;
}

/** TOML inline table for the MCP server env. */
export function tomlInlineTable(env: Record<string, string>): string {
  const entries = Object.entries(env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
  return `{ ${entries.join(", ")} }`;
}

export class CodexBrain implements Brain {
  readonly id = "codex" as const;

  run(opts: BrainRunOptions): Promise<BrainResult> {
    const key = `mcp_servers.${opts.mcp.name}`;
    const args = opts.threadId ? ["exec", "resume", opts.threadId] : ["exec"];
    args.push(
      "--json",
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "-C", opts.cwd,
      "-c", `${key}.command=${JSON.stringify(opts.mcp.command)}`,
      "-c", `${key}.args=${JSON.stringify(opts.mcp.args)}`,
      "-c", `${key}.env=${tomlInlineTable(opts.mcp.env)}`,
    );
    if (opts.model.trim()) args.push("--model", opts.model.trim());
    // Codex has no system-prompt flag for exec; carry the instructions in the first message of a thread.
    const prompt = opts.threadId ? opts.prompt : `<instructions>\n${opts.systemPrompt}\n</instructions>\n\n${opts.prompt}`;

    return new Promise((resolve, reject) => {
      const state = newCodexState();
      let stderr = "";
      let buffer = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      const child = spawnCli(opts.cliPath, args, { cwd: opts.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      const onAbort = () => child.kill();
      opts.signal.addEventListener("abort", onAbort, { once: true });

      const handleLine = (line: string) => {
        for (const event of parseCodexLine(line, state)) {
          opts.onEvent(event);
          if (event.type === "done") finish(() => resolve({ threadId: event.threadId, text: event.text }));
          if (event.type === "error") finish(() => reject(new Error(event.message)));
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          handleLine(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", (error) => finish(() => reject(new Error(`Could not start Codex: ${error.message}`))));
      child.on("close", (code) => {
        opts.signal.removeEventListener("abort", onAbort);
        if (buffer.trim()) handleLine(buffer);
        if (settled) return;
        if (opts.signal.aborted) return finish(() => reject(new Error("Stopped.")));
        if (state.done || (code === 0 && state.text)) return finish(() => resolve({ threadId: state.threadId, text: state.text }));
        const tail = stderr.trim().split("\n").slice(-4).join("\n");
        const hint = /not logged in|login|unauthorized|401/i.test(tail) ? " Sign in from Oracle settings (runs `codex login`)." : "";
        finish(() => reject(new Error(`Codex exited with code ${code ?? "?"}.${hint}${tail ? `\n${tail}` : ""}`)));
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(prompt);
    });
  }
}
