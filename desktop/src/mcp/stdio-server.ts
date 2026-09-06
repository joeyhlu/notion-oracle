/**
 * Minimal MCP (Model Context Protocol) server over stdio: newline-delimited JSON-RPC 2.0 with
 * the initialize / tools/list / tools/call handshake. Dependency-free and shared by every tool
 * server the desktop app ships.
 */

import { createInterface } from "node:readline";
import type { ToolDefinition, ToolExecutor } from "../../../extension/src/lib/providers/types.ts";

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface StdioServerOptions {
  name: string;
  version: string;
  instructions: string;
  tools: ToolDefinition[];
  execute: ToolExecutor;
  /** Output sink; defaults to stdout. Injectable for tests. */
  write?: (line: string) => void;
}

export class StdioMcpServer {
  private readonly options: StdioServerOptions;
  private readonly write: (line: string) => void;

  constructor(options: StdioServerOptions) {
    this.options = options;
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  }

  private send(message: Record<string, unknown>): void {
    this.write(JSON.stringify(message));
  }

  private reply(id: JsonRpcRequest["id"], result: unknown): void {
    this.send({ jsonrpc: "2.0", id: id ?? null, result });
  }

  private fail(id: JsonRpcRequest["id"], code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  }

  async handle(request: JsonRpcRequest): Promise<void> {
    const { id, method, params = {} } = request;
    const isNotification = id === undefined;
    switch (method) {
      case "initialize": {
        const requested = String(params.protocolVersion ?? "");
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
        this.reply(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.options.name, version: this.options.version },
          instructions: this.options.instructions,
        });
        return;
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return;
      case "ping":
        this.reply(id, {});
        return;
      case "tools/list":
        this.reply(id, { tools: this.options.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) });
        return;
      case "tools/call": {
        const name = String(params.name ?? "");
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (!this.options.tools.some((t) => t.name === name)) {
          this.fail(id, -32602, `Unknown tool: ${name}`);
          return;
        }
        const outcome = await this.options.execute(name, args);
        this.reply(id, { content: [{ type: "text", text: outcome.content }], isError: !outcome.ok });
        return;
      }
      default:
        if (!isNotification) this.fail(id, -32601, `Method not found: ${method}`);
    }
  }

  /** Read requests from stdin until it closes, answering everything still in flight before exiting. */
  serve(): void {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const inFlight = new Set<Promise<void>>();
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(trimmed) as JsonRpcRequest;
      } catch {
        this.fail(null, -32700, "Parse error");
        return;
      }
      const task = this.handle(request).catch((error) => this.fail(request.id, -32603, error instanceof Error ? error.message : String(error)));
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    });
    rl.on("close", () => {
      void Promise.allSettled([...inFlight]).then(() => process.exit(0));
    });
  }
}
