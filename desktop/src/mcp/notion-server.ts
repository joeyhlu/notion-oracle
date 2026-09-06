/**
 * Minimal MCP (Model Context Protocol) server over stdio that exposes the Notion tools.
 * Spawned by Claude Code / Codex with NOTION_TOKEN in the environment. Dependency-free:
 * the protocol is newline-delimited JSON-RPC 2.0.
 */

import { createInterface } from "node:readline";
import { NotionClient } from "../../../extension/src/lib/notion.ts";
import { NOTION_API_TOOLS, createToolExecutor } from "../../../extension/src/lib/tools.ts";

const SERVER_NAME = "notion-oracle";
const SERVER_VERSION = "0.1.0";
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const token = process.env.NOTION_TOKEN ?? "";
const notion = token ? new NotionClient(token) : null;
const execute = createToolExecutor({
  notion,
  currentPageId: process.env.NOTION_CURRENT_PAGE_ID || null,
  runPageTool: async () => ({ ok: false, content: "Page tools are only available in the browser extension." }),
});

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: JsonRpcRequest["id"], result: unknown): void {
  send({ jsonrpc: "2.0", id: id ?? null, result });
}

function fail(id: JsonRpcRequest["id"], code: number, message: string): void {
  send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

export async function handle(request: JsonRpcRequest): Promise<void> {
  const { id, method, params = {} } = request;
  const isNotification = id === undefined;
  switch (method) {
    case "initialize": {
      const requested = String(params.protocolVersion ?? "");
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
      reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: notion
          ? "Tools for reading and writing the user's Notion workspace. Call get_database before creating or updating database entries."
          : "No Notion token is configured; every tool will fail until the user adds one in Notion Oracle settings.",
      });
      return;
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, {
        tools: NOTION_API_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })),
      });
      return;
    case "tools/call": {
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (!NOTION_API_TOOLS.some((t) => t.name === name)) {
        fail(id, -32602, `Unknown tool: ${name}`);
        return;
      }
      const outcome = await execute(name, args);
      reply(id, { content: [{ type: "text", text: outcome.content }], isError: !outcome.ok });
      return;
    }
    default:
      if (!isNotification) fail(id, -32601, `Method not found: ${method}`);
  }
}

function main(): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const inFlight = new Set<Promise<void>>();
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      fail(null, -32700, "Parse error");
      return;
    }
    const task = handle(request).catch((error) => fail(request.id, -32603, error instanceof Error ? error.message : String(error)));
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  });
  // The client closes stdin to shut us down; finish answering anything still running first.
  rl.on("close", () => {
    void Promise.allSettled([...inFlight]).then(() => process.exit(0));
  });
}

if (process.env.NOTION_ORACLE_MCP_TEST !== "1") main();
