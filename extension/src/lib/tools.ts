/** Tool definitions shared by both providers, plus the executor that runs them. */

import type { PageToolName, PageToolResponse } from "../shared/types.ts";
import { markdownToBlocks } from "./markdown.ts";
import { coerceProperties, databaseTitle, findTitleProperty, normalizeId, pageTitle, summarizeProperties, type NotionClient, type NotionDataSource, type NotionPage } from "./notion.ts";
import type { ToolDefinition, ToolExecutor, ToolOutcome } from "./providers/types.ts";

const ID_DESC = "Notion id (32 hex chars, dashed UUID, or a full Notion URL).";

export const PAGE_TOOLS: ToolDefinition[] = [
  {
    name: "read_current_page",
    description:
      "Read the title and full text (as Markdown) of the Notion page currently open in the user's browser tab. Call this before summarizing, answering questions about, or editing the open page. Works without a Notion API token.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_selection",
    description: "Return the text the user currently has selected in the open Notion page, or an empty string if nothing is selected.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "insert_at_cursor",
    description:
      "Type Markdown into the open Notion page through the editor. position='cursor' inserts where the user's caret last was; position='end' appends after the last block. Best for short additions. For long content prefer append_to_page when a Notion token is configured.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Markdown to insert. Newlines create new blocks; '- ' bullets, '# ' headings and '[ ] ' to-dos are understood by Notion." },
        position: { type: "string", enum: ["cursor", "end"], description: "Where to insert. Defaults to 'cursor'." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "replace_selection",
    description: "Replace the text the user has selected in the open Notion page with new text. Use for rewriting, fixing grammar, translating or shortening a selection. Fails if nothing is selected.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", description: "Replacement text (Markdown)." } },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

export const NOTION_API_TOOLS: ToolDefinition[] = [
  {
    name: "search_notion",
    description: "Search the user's Notion workspace for pages and databases by title. Returns ids, titles and URLs. Only content shared with the Oracle integration is visible.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text. Use an empty string to list recently edited items." },
        object_type: { type: "string", enum: ["page", "database"], description: "Restrict to pages or databases." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_page",
    description: "Fetch a Notion page by id: its properties and full content as Markdown, including nested blocks and child page/database ids.",
    input_schema: {
      type: "object",
      properties: { page_id: { type: "string", description: ID_DESC } },
      required: ["page_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_database",
    description:
      "Fetch a database's schema: property names, types and options. Always call this before creating or updating database entries so you use the exact property names. Calendars, boards and tables in Notion are all databases. Accepts either a database id or a data source id; a Notion database holds one or more data sources, and this reports which one will be used plus any others to choose from.",
    input_schema: {
      type: "object",
      properties: { database_id: { type: "string", description: ID_DESC } },
      required: ["database_id"],
      additionalProperties: false,
    },
  },
  {
    name: "query_database",
    description: "List entries in a database, optionally filtered and sorted using the Notion API filter/sort syntax. Returns each entry's id, title, URL and properties. Accepts a database id or a data source id.",
    input_schema: {
      type: "object",
      properties: {
        database_id: { type: "string", description: ID_DESC },
        filter: { type: "object", description: "Notion API filter object, e.g. {\"property\":\"Date\",\"date\":{\"on_or_after\":\"2026-09-01\"}}." },
        sorts: { type: "array", items: { type: "object" }, description: "Notion API sorts array, e.g. [{\"property\":\"Date\",\"direction\":\"ascending\"}]." },
        page_size: { type: "integer", description: "Max entries to return (1-100, default 25)." },
      },
      required: ["database_id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_page",
    description: "Create a new page under a parent page, with a title and optional Markdown body. To add a row to a database (including calendar events) use create_database_entry instead.",
    input_schema: {
      type: "object",
      properties: {
        parent_page_id: { type: "string", description: `Parent page. ${ID_DESC} Defaults to the page currently open.` },
        title: { type: "string" },
        content_markdown: { type: "string", description: "Body of the page in Markdown (headings, lists, to-dos, quotes, code blocks supported)." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "create_database_entry",
    description:
      "Add an entry (row) to a database. A Notion calendar is a database with a date property, so calendar events are created with this tool: set the title property and the date property (ISO 8601, e.g. '2026-09-10' or '2026-09-10T14:00:00-04:00', or {\"start\":..., \"end\":...}). Call get_database first to learn property names. Values can be plain (strings, numbers, booleans, arrays of names) or raw Notion property payloads.",
    input_schema: {
      type: "object",
      properties: {
        database_id: { type: "string", description: `${ID_DESC} A data source id also works.` },
        values: { type: "object", description: "Map of property name to value, e.g. {\"Name\":\"Dentist\",\"Date\":\"2026-09-10T14:00:00\",\"Tags\":[\"Health\"]}." },
        content_markdown: { type: "string", description: "Optional page body in Markdown." },
      },
      required: ["database_id", "values"],
      additionalProperties: false,
    },
  },
  {
    name: "update_page",
    description: "Update properties of an existing page or database entry (rename, change a date, set a status, tick a checkbox). Same value format as create_database_entry.",
    input_schema: {
      type: "object",
      properties: {
        page_id: { type: "string", description: ID_DESC },
        values: { type: "object", description: "Map of property name to new value. Use null to clear a value." },
      },
      required: ["page_id", "values"],
      additionalProperties: false,
    },
  },
  {
    name: "read_page_blocks",
    description:
      "List a page's blocks with their ids, types and text. Call this before editing existing content: get_page returns the page as Markdown without ids, and every editing tool needs a block id to target. Defaults to the page currently open.",
    input_schema: {
      type: "object",
      properties: {
        page_id: { type: "string", description: `${ID_DESC} Defaults to the page currently open.` },
        depth: { type: "integer", description: "How many levels of nested blocks to include (0-2, default 1)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "update_block",
    description:
      "Replace the content of one existing block, editing the page in place. Use this to rewrite a paragraph, fix wording, translate a line, or convert a block to a different type (write Markdown: '# ' for a heading, '- ' for a bullet, '- [ ] ' for a to-do). If the Markdown expands to several blocks the first replaces the target and the rest are inserted after it. Changing a block's type replaces it in place and returns new block ids, since Notion cannot retype a block. Get block ids from read_page_blocks.",
    input_schema: {
      type: "object",
      properties: {
        block_id: { type: "string", description: "Id of the block to replace, from read_page_blocks." },
        markdown: { type: "string", description: "New content for the block, in Markdown." },
      },
      required: ["block_id", "markdown"],
      additionalProperties: false,
    },
  },
  {
    name: "insert_after_block",
    description: "Insert new Markdown content directly after a specific block, rather than at the end of the page. Use it to add a paragraph mid-document. Get block ids from read_page_blocks.",
    input_schema: {
      type: "object",
      properties: {
        block_id: { type: "string", description: "Insert after this block. Get it from read_page_blocks." },
        markdown: { type: "string", description: "Content to insert, in Markdown." },
      },
      required: ["block_id", "markdown"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_block",
    description: "Delete one block from a page. Notion moves it to the trash, so it can be restored. Confirm with the user before deleting anything they did not explicitly ask you to remove.",
    input_schema: {
      type: "object",
      properties: { block_id: { type: "string", description: "Id of the block to delete, from read_page_blocks." } },
      required: ["block_id"],
      additionalProperties: false,
    },
  },
  {
    name: "append_to_page",
    description: "Append Markdown content to the end of a page through the Notion API. Reliable for long or structured content. Defaults to the page currently open.",
    input_schema: {
      type: "object",
      properties: {
        page_id: { type: "string", description: `${ID_DESC} Defaults to the page currently open.` },
        content_markdown: { type: "string" },
      },
      required: ["content_markdown"],
      additionalProperties: false,
    },
  },
];

/**
 * Finds pages by what is written in them, not just what they are called.
 *
 * Notion's own /search endpoint matches titles. That is fine for "open my Roadmap" and useless
 * for "what did I decide about the budget" — the page is called Q3 Planning and nothing about it
 * says budget. Off by default because answering one question costs a read of every candidate page.
 */
export const CONTENT_SEARCH_TOOLS: ToolDefinition[] = [
  {
    name: "search_page_contents",
    description:
      "Search the TEXT INSIDE the user's Notion pages, not just their titles. Use this whenever the user asks about something they wrote but does not name the page — \"what did I decide about pricing\", \"where did I write about the trip\" — and when search_notion returns nothing useful. Returns each match with the page id, title, url and the lines that matched, so you can quote them or read the page in full. Slower than search_notion because it reads pages, so prefer search_notion when the user names a page.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for in the page text. Several words match pages containing more of them." },
        limit: { type: "number", description: "How many matching pages to return. Default 5, maximum 10." },
        scan: { type: "number", description: "How many recently edited pages to read while searching. Default 25, maximum 60. Raise it if an older page is being missed." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

/**
 * Reading and writing many database rows at once, which is what filling a column across a table
 * needs: "summarise every row into the Summary property", "tag these by topic".
 *
 * Notion AI does this with an always-on AI property. Oracle has no way to run on a schedule, so
 * this is the on-demand equivalent — the model reads the rows, writes the values, and says what it
 * changed. Off by default: one instruction can rewrite a whole table.
 */
export const BULK_EDIT_TOOLS: ToolDefinition[] = [
  {
    name: "read_database_rows",
    description:
      "Read rows from a database together with the text on each row's page. Use this before filling in a property across a table, so you are summarising or tagging what the row actually says rather than its title. Call get_database first for exact property names.",
    input_schema: {
      type: "object",
      properties: {
        database_id: { type: "string", description: "Database id or URL." },
        limit: { type: "number", description: "How many rows to read. Default 20, maximum 50." },
        include_content: { type: "boolean", description: "Include each row's page text. Default true. Set false when the properties are enough." },
        only_empty_property: { type: "string", description: "Return only rows whose named property is empty, so a second pass does not redo finished rows." },
      },
      required: ["database_id"],
      additionalProperties: false,
    },
  },
  {
    name: "set_database_rows",
    description:
      "Write one property on many rows in a single call, after reading them with read_database_rows. Each update names a page id and the value for that row. Tell the user how many rows you changed and what you wrote. Ask first if you are about to overwrite rows that already have a value.",
    input_schema: {
      type: "object",
      properties: {
        database_id: { type: "string", description: "The database the rows belong to, for resolving the property's type." },
        property: { type: "string", description: "Name of the property to set, exactly as get_database reports it." },
        updates: {
          type: "array",
          description: "One entry per row.",
          items: {
            type: "object",
            properties: {
              page_id: { type: "string", description: "Row page id, from read_database_rows." },
              value: { type: "string", description: "Value for this row. Coerced to the property's real type." },
            },
            required: ["page_id", "value"],
            additionalProperties: false,
          },
        },
      },
      required: ["database_id", "property", "updates"],
      additionalProperties: false,
    },
  },
];

/** The optional tool groups, by the setting that turns each one on. */
export const OPTIONAL_TOOL_GROUPS = {
  contentSearch: CONTENT_SEARCH_TOOLS,
  bulkEdit: BULK_EDIT_TOOLS,
} as const;

export type OptionalToolGroup = keyof typeof OPTIONAL_TOOL_GROUPS;

/** The Notion tools for a given set of enabled options. */
export function notionTools(enabled: Partial<Record<OptionalToolGroup, boolean>> = {}): ToolDefinition[] {
  const extra = (Object.keys(OPTIONAL_TOOL_GROUPS) as OptionalToolGroup[])
    .filter((key) => enabled[key])
    .flatMap((key) => OPTIONAL_TOOL_GROUPS[key]);
  return [...NOTION_API_TOOLS, ...extra];
}

export const ALL_TOOLS: ToolDefinition[] = [...PAGE_TOOLS, ...NOTION_API_TOOLS];

/** Normalises a search result into the shape the model sees. */
function describeSearchHit(r: NotionPage | NotionDataSource): Record<string, unknown> {
  const object = (r as { object?: string }).object;
  if (object === "data_source" || object === "database") {
    const ds = r as NotionDataSource;
    // `id` here is the data source id, which get_database and query_database both accept.
    return { object: "database", id: ds.id, title: databaseTitle(ds), url: (ds.url as string) ?? "", database_id: ds.database_parent?.database_id };
  }
  const page = r as NotionPage;
  return { object: "page", id: page.id, title: pageTitle(page), url: page.url, parent: page.parent };
}

export type PageToolRunner = (name: PageToolName, input: Record<string, unknown>) => Promise<PageToolResponse>;

/** What a mutating tool reports about itself, for the change journal. */
export interface RecordedChange {
  kind: "block" | "page" | "event";
  action: "create" | "update" | "delete";
  label: string;
  target?: string;
  url?: string;
  undo?: Record<string, unknown>;
}

export interface ExecutorDeps {
  notion: NotionClient | null;
  runPageTool: PageToolRunner;
  currentPageId: string | null;
  /**
   * Called after a tool changes something, with enough state to reverse it.
   *
   * It lives here rather than wrapping the executor from outside because the before-state — the
   * body a block had before it was overwritten, the properties a page had — is visible only at
   * the point of the call and is deliberately not in the result the model sees.
   */
  recordChange?: (change: RecordedChange) => void;
}

const ok = (content: unknown): ToolOutcome => ({ ok: true, content: typeof content === "string" ? content : JSON.stringify(content, null, 2) });
const fail = (message: string): ToolOutcome => ({ ok: false, content: message });

export function createToolExecutor(deps: ExecutorDeps): ToolExecutor {
  const requireNotion = (): NotionClient => {
    if (!deps.notion) throw new Error("No Notion integration token is configured. Ask the user to add one in Oracle settings, or use the page tools instead.");
    return deps.notion;
  };
  const record = (change: RecordedChange): void => {
    try {
      deps.recordChange?.(change);
    } catch {
      // Journalling is bookkeeping; never fail the user's edit over it.
    }
  };
  const resolvePageId = (given: unknown): string => {
    const id = typeof given === "string" && given.trim() ? given : deps.currentPageId;
    if (!id) throw new Error("No page id given and no Notion page is open in the current tab.");
    return normalizeId(id);
  };

  return async (name, input): Promise<ToolOutcome> => {
    try {
      switch (name) {
        case "read_current_page":
        case "get_selection":
        case "insert_at_cursor":
        case "replace_selection": {
          const res = await deps.runPageTool(name, input);
          return res.ok ? ok(res.content) : fail(res.content);
        }

        case "search_notion": {
          const notion = requireNotion();
          const results = await notion.search(String(input.query ?? ""), input.object_type as "page" | "database" | undefined);
          if (results.length) return ok(results.map(describeSearchHit));
          // A bare "no results" is a dead end: the user cannot tell whether the target is
          // named something else or was simply never shared. List what is reachable instead.
          const visible = await notion.search("", undefined, 15);
          if (!visible.length) {
            return ok(
              "No results, and this integration cannot see anything in the workspace at all. Tell the user to share pages with the Oracle integration in Notion: open a top-level page, ••• → Connections → add the integration. Everything nested under a shared page is included.",
            );
          }
          return ok({
            results: [],
            note: "Nothing matched that query. Below is everything the integration can currently see. If the item the user meant is not in this list, it has not been shared with the integration yet (••• → Connections in Notion). Offer the closest matches by name before asking them to share anything.",
            visible: visible.map(describeSearchHit),
          });
        }

        case "get_page": {
          const notion = requireNotion();
          const id = resolvePageId(input.page_id);
          const [page, markdown] = await Promise.all([notion.getPage(id), notion.getPageMarkdown(id)]);
          return ok({ id: page.id, title: pageTitle(page), url: page.url, parent: page.parent, properties: summarizeProperties(page.properties), content_markdown: markdown });
        }

        case "get_database": {
          const notion = requireNotion();
          const resolved = await notion.resolveDataSource(String(input.database_id));
          const properties = Object.values(resolved.properties).map((p) => {
            const detail = p[p.type] as { options?: Array<{ name: string }> } | undefined;
            return { name: p.name, type: p.type, ...(detail?.options ? { options: detail.options.map((o) => o.name) } : {}) };
          });
          return ok({
            database_id: resolved.databaseId,
            data_source_id: resolved.dataSourceId,
            title: resolved.title,
            url: resolved.url,
            properties,
            ...(resolved.available.length > 1
              ? {
                  note: `This database has ${resolved.available.length} data sources; "${resolved.available[0]?.name}" was used. Pass another data source id to target it instead.`,
                  data_sources: resolved.available,
                }
              : {}),
          });
        }

        case "query_database": {
          const notion = requireNotion();
          const body: Record<string, unknown> = { page_size: Math.min(100, Math.max(1, Number(input.page_size) || 25)) };
          if (input.filter) body.filter = input.filter;
          if (input.sorts) body.sorts = input.sorts;
          const { dataSourceId } = await notion.resolveDataSource(String(input.database_id));
          const pages = await notion.queryDataSource(dataSourceId, body);
          return ok(pages.map((p) => ({ id: p.id, title: pageTitle(p), url: p.url, properties: summarizeProperties(p.properties) })));
        }

        case "create_page": {
          const notion = requireNotion();
          const parentId = resolvePageId(input.parent_page_id);
          const page = await notion.createPage(
            { page_id: parentId },
            { title: { title: [{ type: "text", text: { content: String(input.title ?? "Untitled") } }] } },
            typeof input.content_markdown === "string" ? input.content_markdown : undefined,
          );
          record({ kind: "page", action: "create", label: `Created page "${String(input.title ?? "Untitled")}"`, target: page.id, url: page.url, undo: { type: "archive-page", pageId: page.id } });
          return ok({ created: true, id: page.id, url: page.url });
        }

        case "create_database_entry": {
          const notion = requireNotion();
          const resolved = await notion.resolveDataSource(String(input.database_id));
          const values = { ...((input.values ?? {}) as Record<string, unknown>) };
          const titleProp = findTitleProperty(resolved.properties);
          if (!(titleProp in values) && typeof input.title === "string") values[titleProp] = input.title;
          const properties = coerceProperties(resolved.properties, values);
          const page = await notion.createPage({ type: "data_source_id", data_source_id: resolved.dataSourceId }, properties, typeof input.content_markdown === "string" ? input.content_markdown : undefined);
          record({ kind: "page", action: "create", label: `Added "${String(values[titleProp] ?? input.title ?? "Untitled")}" to the database`, target: page.id, url: page.url, undo: { type: "archive-page", pageId: page.id } });
          return ok({ created: true, id: page.id, url: page.url, properties: summarizeProperties(page.properties) });
        }

        case "update_page": {
          const notion = requireNotion();
          const id = resolvePageId(input.page_id);
          const page = await notion.getPage(id);
          const values = (input.values ?? {}) as Record<string, unknown>;
          const parent = page.parent as { type?: string; database_id?: string; data_source_id?: string };
          let properties: Record<string, unknown>;
          const parentId = parent.data_source_id ?? parent.database_id;
          if ((parent.type === "data_source_id" || parent.type === "database_id") && parentId) {
            const resolved = await notion.resolveDataSource(parentId);
            properties = coerceProperties(resolved.properties, values);
          } else {
            const schema = Object.fromEntries(Object.entries(page.properties).map(([k, v]) => [k, { id: String(v.id ?? k), name: k, type: String(v.type) }]));
            properties = coerceProperties(schema, values);
          }
          const updated = await notion.updatePage(id, properties);
          // `page` was fetched above, so the values being overwritten are already in hand; only
          // the properties this call touches are kept, so undo restores those and nothing else.
          const before = Object.fromEntries(Object.keys(properties).filter((k) => k in page.properties).map((k) => [k, page.properties[k]]));
          record({ kind: "page", action: "update", label: `Updated ${Object.keys(properties).length} propert${Object.keys(properties).length === 1 ? "y" : "ies"} on "${pageTitle(updated)}"`, target: id, url: updated.url, undo: { type: "restore-page-properties", pageId: id, properties: before } });
          return ok({ updated: true, id: updated.id, url: updated.url, properties: summarizeProperties(updated.properties) });
        }

        case "read_page_blocks": {
          const notion = requireNotion();
          const id = resolvePageId(input.page_id);
          const depth = Math.max(0, Math.min(2, Number(input.depth ?? 1)));
          const outline = await notion.getBlockOutline(id, depth);
          if (!outline.length) return ok("That page has no blocks yet.");
          return ok(outline);
        }

        case "update_block": {
          const notion = requireNotion();
          const blocks = markdownToBlocks(String(input.markdown ?? ""));
          if (!blocks.length) return fail("The markdown was empty, so there is nothing to replace the block with. Use delete_block to remove a block.");
          const result = await notion.replaceBlock(String(input.block_id), blocks);
          record(result.converted
            ? { kind: "block", action: "update", label: `Changed a ${result.from} into a ${result.to}`, target: result.parentId, undo: { type: "delete-blocks", blockIds: result.blockIds, thenUnarchive: String(input.block_id) } }
            : { kind: "block", action: "update", label: `Rewrote a ${result.to}`, target: result.parentId, undo: result.previous ? { type: "restore-block", blockId: result.blockIds[0], block: result.previous } : undefined });
          return ok({
            updated: true,
            type: result.to,
            // A conversion archives the original, so the old id is dead. Handing back the new ids
            // keeps a follow-up edit from targeting a block that no longer exists.
            ...(result.converted
              ? { converted_from: result.from, block_ids: result.blockIds, note: "Type changed, so this is a new block; the original is in Notion's trash." }
              : { block_id: result.blockIds[0], inserted_after: result.blockIds.length - 1 }),
          });
        }

        case "insert_after_block": {
          const notion = requireNotion();
          const blocks = markdownToBlocks(String(input.markdown ?? ""));
          if (!blocks.length) return fail("The markdown was empty, so there is nothing to insert.");
          const created = await notion.insertBlocksAfter(String(input.block_id), blocks);
          if (created.length) record({ kind: "block", action: "create", label: `Inserted ${created.length} block${created.length === 1 ? "" : "s"}`, target: created.parentId, undo: { type: "delete-blocks", blockIds: created.map((b) => b.id) } });
          return ok({ inserted: created.length, after_block_id: input.block_id, block_ids: created.map((b) => b.id) });
        }

        case "delete_block": {
          const notion = requireNotion();
          await notion.deleteBlock(String(input.block_id));
          record({ kind: "block", action: "delete", label: "Deleted a block", undo: { type: "unarchive-block", blockId: String(input.block_id) } });
          return ok({ deleted: true, block_id: input.block_id, note: "Moved to Notion's trash; it can be restored from there." });
        }

        case "append_to_page": {
          const notion = requireNotion();
          const id = resolvePageId(input.page_id);
          const appended = await notion.appendMarkdown(id, String(input.content_markdown ?? ""));
          if (appended.length) record({ kind: "block", action: "create", label: `Appended ${appended.length} block${appended.length === 1 ? "" : "s"}`, target: id, undo: { type: "delete-blocks", blockIds: appended } });
          return ok({ appended_blocks: appended.length, page_id: id });
        }

        case "search_page_contents": {
          const notion = requireNotion();
          const query = String(input.query ?? "").trim();
          if (!query) return fail("Give some words to search for.");
          const scanned = Math.min(Math.max(Number(input.scan ?? 25), 1), 60);
          const matches = await notion.searchPageContents(query, Number(input.limit ?? 5), scanned);
          if (!matches.length) {
            // Say how far it looked, so "nothing found" is actionable rather than final.
            return ok(`No page among the ${scanned} most recently edited mentions ${JSON.stringify(query)}. Try different words, raise "scan" to look further back, or check the page is shared with the Oracle integration.`);
          }
          return ok({ matches, scanned, note: "Excerpts are the lines that matched. Call get_page or read_page_blocks for the full page." });
        }

        case "read_database_rows": {
          const notion = requireNotion();
          const resolved = await notion.resolveDataSource(String(input.database_id));
          const rows = await notion.readDatabaseRows(resolved.dataSourceId, {
            limit: Number(input.limit ?? 20),
            includeContent: input.include_content !== false,
            onlyEmpty: typeof input.only_empty_property === "string" ? input.only_empty_property : undefined,
          });
          return ok({
            database: resolved.title,
            properties: Object.fromEntries(Object.entries(resolved.properties).map(([k, v]) => [k, v.type])),
            rows: rows.map((r) => ({ page_id: r.id, title: r.title, url: r.url, properties: summarizeProperties(r.properties), content: r.content })),
          });
        }

        case "set_database_rows": {
          const notion = requireNotion();
          const property = String(input.property ?? "");
          const updates = Array.isArray(input.updates) ? (input.updates as Array<{ page_id?: unknown; value?: unknown }>) : [];
          if (!property) return fail("Name the property to set.");
          if (!updates.length) return fail("No rows were given to update.");
          const resolved = await notion.resolveDataSource(String(input.database_id));
          if (!(property in resolved.properties)) {
            return fail(`"${property}" is not a property of ${resolved.title}. It has: ${Object.keys(resolved.properties).join(", ")}`);
          }

          const done: string[] = [];
          const failed: Array<{ page_id: string; error: string }> = [];
          for (const update of updates) {
            const pageId = String(update.page_id ?? "");
            try {
              const page = await notion.getPage(pageId);
              const before = property in page.properties ? { [property]: page.properties[property] } : {};
              await notion.updatePage(pageId, coerceProperties(resolved.properties, { [property]: update.value }));
              // Recorded per row, so undoing one mistaken value does not revert the whole pass.
              record({ kind: "page", action: "update", label: `Set ${property} on "${pageTitle(page)}"`, target: pageId, url: page.url, undo: { type: "restore-page-properties", pageId, properties: before } });
              done.push(pageId);
            } catch (error) {
              // One bad row must not abandon the rest half-written.
              failed.push({ page_id: pageId, error: error instanceof Error ? error.message : String(error) });
            }
          }
          if (!done.length) return fail(`No rows could be updated. First error: ${failed[0]?.error ?? "unknown"}`);
          return ok({ updated: done.length, property, failed: failed.length ? failed : undefined });
        }

        default:
          return fail(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  };
}
