/**
 * MCP server exposing the Notion tools. Spawned by Claude Code / Codex with NOTION_TOKEN in
 * the environment.
 */

import { NotionClient } from "../../../extension/src/lib/notion.ts";
import { createToolExecutor, notionTools } from "../../../extension/src/lib/tools.ts";
import { StdioMcpServer } from "./stdio-server.ts";
import { appendChange } from "../shared/journal-file.ts";
import type { UndoStep } from "../shared/journal.ts";

// Set by the main process. Absent in the extension build and in tests, where nothing records.
const journal = process.env.ORACLE_JOURNAL ?? "";

const token = process.env.NOTION_TOKEN ?? "";
const notion = token ? new NotionClient(token) : null;

export const server = new StdioMcpServer({
  name: "notion-oracle",
  version: "0.1.0",
  instructions: notion
    ? "Tools for reading and writing the user's Notion workspace. Call get_database before creating or updating database entries, and read_page_blocks before editing existing content."
    : "No Notion token is configured; every tool will fail until the user adds one in Notion Oracle settings.",
  // Which optional groups are on is decided by the main process and arrives as environment flags,
  // the same way the journal path and the Notion token do.
  tools: notionTools({
    contentSearch: process.env.ORACLE_CONTENT_SEARCH === "1",
    bulkEdit: process.env.ORACLE_BULK_EDIT === "1",
  }),
  execute: createToolExecutor({
    notion,
    currentPageId: process.env.NOTION_CURRENT_PAGE_ID || null,
    runPageTool: async () => ({ ok: false, content: "Page tools are only available in the browser extension." }),
    recordChange: journal
      ? (change) => appendChange(journal, { tool: "notion", ...change, undo: change.undo as UndoStep | undefined })
      : undefined,
  }),
});

if (process.env.NOTION_ORACLE_MCP_TEST !== "1") server.serve();
