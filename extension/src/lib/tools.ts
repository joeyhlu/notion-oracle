/** Tool definitions shared by both providers, plus the executor that runs them. */

import type { PageToolName, PageToolResponse } from "../shared/types.ts";
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

export interface ExecutorDeps {
  notion: NotionClient | null;
  runPageTool: PageToolRunner;
  currentPageId: string | null;
}

const ok = (content: unknown): ToolOutcome => ({ ok: true, content: typeof content === "string" ? content : JSON.stringify(content, null, 2) });
const fail = (message: string): ToolOutcome => ({ ok: false, content: message });

export function createToolExecutor(deps: ExecutorDeps): ToolExecutor {
  const requireNotion = (): NotionClient => {
    if (!deps.notion) throw new Error("No Notion integration token is configured. Ask the user to add one in Oracle settings, or use the page tools instead.");
    return deps.notion;
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
          return ok({ updated: true, id: updated.id, url: updated.url, properties: summarizeProperties(updated.properties) });
        }

        case "append_to_page": {
          const notion = requireNotion();
          const id = resolvePageId(input.page_id);
          const count = await notion.appendMarkdown(id, String(input.content_markdown ?? ""));
          return ok({ appended_blocks: count, page_id: id });
        }

        default:
          return fail(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  };
}
