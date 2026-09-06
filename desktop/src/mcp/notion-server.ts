/**
 * MCP server exposing the Notion tools. Spawned by Claude Code / Codex with NOTION_TOKEN in
 * the environment.
 */

import { NotionClient } from "../../../extension/src/lib/notion.ts";
import { NOTION_API_TOOLS, createToolExecutor } from "../../../extension/src/lib/tools.ts";
import { StdioMcpServer } from "./stdio-server.ts";

const token = process.env.NOTION_TOKEN ?? "";
const notion = token ? new NotionClient(token) : null;

export const server = new StdioMcpServer({
  name: "notion-oracle",
  version: "0.1.0",
  instructions: notion
    ? "Tools for reading and writing the user's Notion workspace. Call get_database before creating or updating database entries, and read_page_blocks before editing existing content."
    : "No Notion token is configured; every tool will fail until the user adds one in Notion Oracle settings.",
  tools: NOTION_API_TOOLS,
  execute: createToolExecutor({
    notion,
    currentPageId: process.env.NOTION_CURRENT_PAGE_ID || null,
    runPageTool: async () => ({ ok: false, content: "Page tools are only available in the browser extension." }),
  }),
});

if (process.env.NOTION_ORACLE_MCP_TEST !== "1") server.serve();
