/**
 * Drives Claude Code in headless mode (`claude -p --output-format stream-json`), so the app
 * uses the user's own Claude Code sign-in (Pro/Max subscription) and never an API key.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatEvent } from "../../shared/types.ts";
import { spawnCli } from "../process.ts";
import { displayToolName, summarize, type Brain, type BrainResult, type BrainRunOptions } from "./types.ts";

export interface ClaudeParseState {
  sessionId: string | null;
  text: string;
  /** Text deltas seen for the assistant message currently streaming; used to avoid duplicating text. */
  streamedThisMessage: boolean;
  pendingTools: Map<string, string>;
  resultSeen: boolean;
  mcpConnected: boolean | null;
}

export function newClaudeState(): ClaudeParseState {
  return { sessionId: null, text: "", streamedThisMessage: false, pendingTools: new Map(), resultSeen: false, mcpConnected: null };
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** Turn one stream-json line into UI events. Pure, so it is unit-testable. */
export function parseClaudeLine(line: string, state: ClaudeParseState): ChatEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }
  const events: ChatEvent[] = [];
  if (typeof msg.session_id === "string") state.sessionId = msg.session_id;

  switch (msg.type) {
    case "system": {
      if (msg.subtype === "init") {
        const servers = (msg.mcp_servers as Array<{ name: string; status: string }> | undefined) ?? [];
        const notion = servers.find((s) => s.name === "notion");
        state.mcpConnected = notion ? notion.status === "connected" : false;
        events.push({ type: "status", message: state.mcpConnected ? "Connected to Notion" : "Notion tools unavailable (tool server did not start)" });
      }
      break;
    }
    case "stream_event": {
      const event = msg.event as { type: string; delta?: { type: string; text?: string }; content_block?: ContentBlock } | undefined;
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
        state.text += event.delta.text;
        state.streamedThisMessage = true;
        events.push({ type: "text", delta: event.delta.text });
      } else if (event?.type === "message_start") {
        state.streamedThisMessage = false;
      }
      break;
    }
    case "assistant": {
      const message = msg.message as { content?: ContentBlock[] } | undefined;
      for (const block of message?.content ?? []) {
        if (block.type === "text" && block.text && !state.streamedThisMessage) {
          // No partial deltas were delivered for this message; fall back to the full text.
          state.text += block.text;
          events.push({ type: "text", delta: block.text });
        } else if (block.type === "tool_use" && block.id && block.name) {
          state.pendingTools.set(block.id, block.name);
          events.push({ type: "tool-start", id: block.id, name: displayToolName(block.name), input: block.input });
        }
      }
      state.streamedThisMessage = false;
      break;
    }
    case "user": {
      const message = msg.message as { content?: ContentBlock[] | string } | undefined;
      if (Array.isArray(message?.content)) {
        for (const block of message.content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const name = state.pendingTools.get(block.tool_use_id) ?? "tool";
            state.pendingTools.delete(block.tool_use_id);
            events.push({ type: "tool-end", id: block.tool_use_id, name: displayToolName(name), ok: !block.is_error, summary: summarize(block.content) });
          }
        }
      }
      break;
    }
    case "result": {
      state.resultSeen = true;
      const isError = Boolean(msg.is_error) || (typeof msg.subtype === "string" && msg.subtype.startsWith("error"));
      const result = typeof msg.result === "string" ? msg.result : "";
      if (isError) {
        events.push({ type: "error", message: result || `Claude Code stopped: ${String(msg.subtype ?? "unknown error")}`, threadId: state.sessionId });
      } else {
        if (!state.text && result) {
          state.text = result;
          events.push({ type: "text", delta: result });
        }
        events.push({ type: "done", threadId: state.sessionId, text: state.text });
      }
      break;
    }
    default:
      break;
  }
  return events;
}

export class ClaudeBrain implements Brain {
  readonly id = "claude" as const;

  run(opts: BrainRunOptions): Promise<BrainResult> {
    const mcpConfigPath = join(opts.tempDir, "mcp-config.json");
    const systemPromptPath = join(opts.tempDir, "system-prompt.txt");
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { [opts.mcp.name]: { command: opts.mcp.command, args: opts.mcp.args, env: opts.mcp.env } } }));
    writeFileSync(systemPromptPath, opts.systemPrompt);

    const allowed = opts.mcp.toolNames.map((t) => `mcp__${opts.mcp.name}__${t}`);
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--strict-mcp-config",
      "--mcp-config", mcpConfigPath,
      "--tools", "",
      "--allowedTools", ...allowed,
      "--permission-mode", "dontAsk",
      "--append-system-prompt-file", systemPromptPath,
      "--max-turns", "40",
    ];
    if (opts.threadId) args.push("--resume", opts.threadId);
    if (opts.model.trim()) args.push("--model", opts.model.trim());

    return new Promise((resolve, reject) => {
      const state = newClaudeState();
      let stderr = "";
      let buffer = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      // Strip variables that would make a nested Claude Code think it is inside another session.
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/^CLAUDE(CODE|_CODE|_)/.test(key) && key !== "CLAUDE_CODE_OAUTH_TOKEN") delete env[key];
      const child = spawnCli(opts.cliPath, args, { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });

      const onAbort = () => child.kill();
      opts.signal.addEventListener("abort", onAbort, { once: true });

      const handleLine = (line: string) => {
        for (const event of parseClaudeLine(line, state)) {
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
      child.on("error", (error) => finish(() => reject(new Error(`Could not start Claude Code: ${error.message}`))));
      child.on("close", (code) => {
        opts.signal.removeEventListener("abort", onAbort);
        if (buffer.trim()) handleLine(buffer);
        if (settled) return;
        if (opts.signal.aborted) return finish(() => reject(new Error("Stopped.")));
        if (state.resultSeen) return finish(() => resolve({ threadId: state.sessionId, text: state.text }));
        const tail = stderr.trim().split("\n").slice(-4).join("\n");
        const hint = /not logged in|login|authenticat|invalid api key/i.test(tail) ? " Sign in from Oracle settings (runs `claude auth login`)." : "";
        finish(() => reject(new Error(`Claude Code exited with code ${code ?? "?"}.${hint}${tail ? `\n${tail}` : ""}`)));
      });

      child.stdin?.on("error", () => undefined);
      child.stdin?.end(opts.prompt);
    });
  }
}
