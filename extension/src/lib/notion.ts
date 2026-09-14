/** Thin client for the Notion public API, used with an internal integration token. */

import { blocksToMarkdown, markdownToBlocks, richTextToMarkdown, richTextToPlain, type FetchedBlock, type NotionBlock, type RichText } from "./markdown.ts";

// 2025-09-03 introduced data sources: a database is a container for one or more data
// sources, and schema/query operations moved to /v1/data_sources. Older versions error
// outright on databases that have more than one data source.
export const NOTION_API_VERSION = "2025-09-03";
const BASE_URL = "https://api.notion.com/v1";
const MAX_CHILDREN_PER_REQUEST = 100;

export class NotionApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "NotionApiError";
    this.status = status;
    this.code = code;
  }
}

/** Accepts a raw 32-char id, a dashed UUID, or a Notion URL and returns the dashed UUID. */
export function normalizeId(input: string): string {
  const trimmed = input.trim();
  const dashed = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (dashed.test(trimmed)) return trimmed.toLowerCase();
  const match = /([0-9a-f]{32})(?![0-9a-f])/i.exec(trimmed.replace(/-/g, ""))?.[1] ?? /([0-9a-f]{32})/i.exec(trimmed)?.[1];
  if (!match) throw new Error(`"${input}" is not a Notion id or URL`);
  const h = match.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface NotionPage {
  id: string;
  url: string;
  parent: Record<string, unknown>;
  properties: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export interface DataSourceReference {
  id: string;
  name: string;
}

/** A database is now a container; its rows and schema live on its data sources. */
export interface NotionDatabase {
  id: string;
  url: string;
  title: RichText[];
  data_sources?: DataSourceReference[];
  [key: string]: unknown;
}

export type PropertySchema = Record<string, { id: string; name: string; type: string; [key: string]: unknown }>;

/** A data source holds the property schema and the rows. */
export interface NotionDataSource {
  id: string;
  name?: string;
  title?: RichText[];
  database_parent?: { database_id?: string };
  properties: PropertySchema;
  [key: string]: unknown;
}

/** A database plus the data source that schema and row operations should target. */
export interface ContentMatch {
  id: string;
  title: string;
  url: string;
  /** How many of the search terms appear at all — the primary ranking signal. */
  termsMatched: number;
  /** Total occurrences across all terms. */
  hits: number;
  /** The lines that matched, so an answer can quote the page rather than paraphrase it. */
  excerpts: string[];
}

export interface DatabaseRow {
  id: string;
  url: string;
  title: string;
  properties: NotionPage["properties"];
  content?: string;
}

/**
 * Scores one page's text against the search terms, and pulls out the lines that matched.
 *
 * The title counts too: a page called "Budget" is a match for "budget" even when the body never
 * repeats the word.
 */
export function scoreText(text: string, title: string, terms: string[]): { termsMatched: number; hits: number; excerpts: string[] } | null {
  const haystack = `${title}\n${text}`.toLowerCase();
  let termsMatched = 0;
  let hits = 0;
  for (const term of terms) {
    const found = haystack.split(term).length - 1;
    if (found) {
      termsMatched++;
      hits += found;
    }
  }
  if (!termsMatched) return null;

  const excerpts: string[] = [];
  for (const line of text.split("\n")) {
    const lower = line.toLowerCase();
    if (!terms.some((t) => lower.includes(t))) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    excerpts.push(trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed);
    if (excerpts.length === 3) break;
  }
  return { termsMatched, hits, excerpts };
}

/** True when a property holds nothing, so a fill pass can skip rows that are already done. */
export function isEmptyProperty(property: Record<string, unknown> | undefined): boolean {
  if (!property) return true;
  const value = property[String(property.type)];
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.trim() === "";
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

export interface ReplaceResult {
  /** True when the block's type changed, which means the original id no longer exists. */
  converted: boolean;
  from: string;
  to: string;
  /** Ids of the blocks now holding the content, in order. */
  blockIds: string[];
  /** The body that was overwritten, for undo. Absent when the block was replaced, not patched. */
  previous?: Record<string, unknown>;
  /** The page or block the target sits in, so a change can record where it happened. */
  parentId?: string;
}

export interface ResolvedDataSource {
  databaseId: string;
  dataSourceId: string;
  /** Every data source on the parent database, so callers can report ambiguity. */
  available: DataSourceReference[];
  title: string;
  url: string;
  properties: PropertySchema;
}

interface Paginated<T> {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export class NotionClient {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  async request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Notion-Version": NOTION_API_VERSION,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = json as { message?: string; code?: string } | null;
      throw new NotionApiError(err?.message ?? `Notion API ${res.status}`, res.status, err?.code);
    }
    return json as T;
  }

  me(): Promise<{ name?: string; type: string }> {
    return this.request("GET", "/users/me");
  }

  /** `object_type` accepts "database" as an alias for "data_source", which is what the API filters on now. */
  async search(query: string, objectType?: "page" | "database" | "data_source", pageSize = 10): Promise<Array<NotionPage | NotionDataSource>> {
    const body: Record<string, unknown> = { query, page_size: pageSize, sort: { direction: "descending", timestamp: "last_edited_time" } };
    if (objectType) body.filter = { property: "object", value: objectType === "page" ? "page" : "data_source" };
    const res = await this.request<Paginated<NotionPage | NotionDataSource>>("POST", "/search", body);
    return res.results;
  }

  getPage(pageId: string): Promise<NotionPage> {
    return this.request("GET", `/pages/${normalizeId(pageId)}`);
  }

  getDatabase(databaseId: string): Promise<NotionDatabase> {
    return this.request("GET", `/databases/${normalizeId(databaseId)}`);
  }

  getDataSource(dataSourceId: string): Promise<NotionDataSource> {
    return this.request("GET", `/data_sources/${normalizeId(dataSourceId)}`);
  }

  /**
   * Accepts either a database id or a data source id and returns the data source to operate on.
   * Models expect to pass around "the database", but schema and rows live on a data source, so
   * this resolves one to the other. When a database has several, the first is used and the rest
   * are reported so the caller can ask the user which they meant.
   */
  async resolveDataSource(id: string): Promise<ResolvedDataSource> {
    const normalized = normalizeId(id);
    let database: NotionDatabase | null = null;
    try {
      database = await this.getDatabase(normalized);
    } catch (error) {
      // Not a database id (or not reachable as one) - fall through and try it as a data source.
      if (!(error instanceof NotionApiError) || (error.status !== 404 && error.status !== 400)) throw error;
    }

    if (database) {
      const available = database.data_sources ?? [];
      const first = available[0];
      if (!first) throw new Error(`Database "${databaseTitle(database)}" has no data sources to read or write.`);
      const dataSource = await this.getDataSource(first.id);
      return {
        databaseId: database.id,
        dataSourceId: first.id,
        available,
        title: databaseTitle(database),
        url: database.url,
        properties: dataSource.properties,
      };
    }

    const dataSource = await this.getDataSource(normalized);
    const databaseId = dataSource.database_parent?.database_id ?? normalized;
    return {
      databaseId,
      dataSourceId: dataSource.id,
      available: [{ id: dataSource.id, name: dataSource.name ?? richTextToPlain(dataSource.title) }],
      title: (dataSource.name ?? richTextToPlain(dataSource.title)) || "Untitled",
      url: (dataSource.url as string) ?? "",
      properties: dataSource.properties,
    };
  }

  async queryDataSource(dataSourceId: string, body: Record<string, unknown>): Promise<NotionPage[]> {
    const res = await this.request<Paginated<NotionPage>>("POST", `/data_sources/${normalizeId(dataSourceId)}/query`, body);
    return res.results;
  }

  /** Fetch all children of a block, recursing into nested blocks up to `depth` levels. */
  async getBlockChildren(blockId: string, depth = 2): Promise<FetchedBlock[]> {
    const all: FetchedBlock[] = [];
    let cursor: string | null = null;
    do {
      const qs = cursor ? `?page_size=100&start_cursor=${cursor}` : "?page_size=100";
      const res: Paginated<FetchedBlock> = await this.request("GET", `/blocks/${normalizeId(blockId)}/children${qs}`);
      all.push(...res.results);
      cursor = res.has_more ? res.next_cursor : null;
    } while (cursor);
    if (depth > 0) {
      for (const b of all) {
        if (b.has_children && b.type !== "child_page" && b.type !== "child_database") {
          b.children = await this.getBlockChildren(b.id, depth - 1);
        }
      }
    }
    return all;
  }

  async getPageMarkdown(pageId: string): Promise<string> {
    const blocks = await this.getBlockChildren(pageId, 2);
    return blocksToMarkdown(blocks);
  }

  async createPage(parent: Record<string, unknown>, properties: Record<string, unknown>, markdown?: string): Promise<NotionPage> {
    const blocks = markdown ? markdownToBlocks(markdown) : [];
    const page = await this.request<NotionPage>("POST", "/pages", {
      parent,
      properties,
      children: blocks.slice(0, MAX_CHILDREN_PER_REQUEST),
    });
    if (blocks.length > MAX_CHILDREN_PER_REQUEST) await this.appendBlocks(page.id, blocks.slice(MAX_CHILDREN_PER_REQUEST));
    return page;
  }

  /** Returns the ids Notion assigned, in order, so a caller can undo the append. */
  async appendBlocks(blockId: string, blocks: NotionBlock[]): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < blocks.length; i += MAX_CHILDREN_PER_REQUEST) {
      const page = await this.request<{ results?: FetchedBlock[] }>(
        "PATCH", `/blocks/${normalizeId(blockId)}/children`, { children: blocks.slice(i, i + MAX_CHILDREN_PER_REQUEST) });
      for (const created of page.results ?? []) ids.push(created.id);
    }
    return ids;
  }

  appendMarkdown(blockId: string, markdown: string): Promise<string[]> {
    return this.appendBlocks(blockId, markdownToBlocks(markdown));
  }

  getBlock(blockId: string): Promise<FetchedBlock & { parent?: Record<string, unknown> }> {
    return this.request("GET", `/blocks/${normalizeId(blockId)}`);
  }

  /**
   * Flat listing of a page's blocks with their ids, which is what in-place editing needs:
   * blocksToMarkdown deliberately drops ids, so the model has nothing to target.
   */
  async getBlockOutline(pageId: string, depth = 1): Promise<Array<{ id: string; type: string; text: string; has_children: boolean }>> {
    const blocks = await this.getBlockChildren(pageId, depth);
    const flat: Array<{ id: string; type: string; text: string; has_children: boolean }> = [];
    const walk = (list: FetchedBlock[], prefix: string) => {
      for (const b of list) {
        const body = (b[b.type] ?? {}) as Record<string, unknown>;
        const text = richTextToMarkdown(body.rich_text as RichText[] | undefined);
        flat.push({ id: b.id, type: b.type, text: prefix + text, has_children: Boolean(b.has_children) });
        if (b.children?.length) walk(b.children, `${prefix}  `);
      }
    };
    walk(blocks, "");
    return flat;
  }

  /** Replace a block's content. Passing a different type converts the block. */
  updateBlock(blockId: string, block: NotionBlock): Promise<FetchedBlock> {
    const type = block.type;
    const body = { type, [type]: (block as Record<string, unknown>)[type] };
    return this.request("PATCH", `/blocks/${normalizeId(blockId)}`, body);
  }

  /** Notion archives rather than destroys, so a deleted block is recoverable from the trash. */
  deleteBlock(blockId: string): Promise<FetchedBlock> {
    return this.request("DELETE", `/blocks/${normalizeId(blockId)}`);
  }

  private static parentIdOf(block: { parent?: Record<string, unknown> }): string {
    const parent = (block.parent ?? {}) as { type?: string; page_id?: string; block_id?: string };
    const parentId = parent.page_id ?? parent.block_id;
    if (!parentId) throw new Error("Could not determine which page or block contains that block.");
    return parentId;
  }

  /**
   * Insert blocks directly after an existing sibling, rather than at the end of the page.
   *
   * `known` lets a caller that has already fetched the target skip a second round trip.
   */
  async insertBlocksAfter(blockId: string, blocks: NotionBlock[], known?: FetchedBlock & { parent?: Record<string, unknown> }): Promise<FetchedBlock[] & { parentId?: string }> {
    if (!blocks.length) return [];
    const target = normalizeId(blockId);
    const parentId = NotionClient.parentIdOf(known ?? await this.getBlock(target));
    // `after` positions the insert; without it Notion appends to the end of the parent.
    const response = await this.request<{ results?: FetchedBlock[] }>(
      "PATCH", `/blocks/${normalizeId(parentId)}/children`, { children: blocks, after: target });
    const created = (response.results ?? []) as FetchedBlock[] & { parentId?: string };
    created.parentId = parentId;
    return created;
  }

  /**
   * Replace a block's content, changing its type when the new Markdown asks for one.
   *
   * Notion's PATCH /blocks/{id} can only rewrite a block as the type it already is: sending a
   * `to_do` body to a paragraph fails with "Block type mismatch: this block is a `paragraph`".
   * Converting between types is the common case — "turn this into a checklist", "make that a
   * heading" — so a mismatch is emulated rather than reported: the replacement goes in directly
   * after the target and the target is archived, which keeps the position and leaves the original
   * recoverable from Notion's trash.
   *
   * Same-type edits still go through PATCH, which preserves the block's id and any children.
   */
  async replaceBlock(blockId: string, blocks: NotionBlock[]): Promise<ReplaceResult> {
    const first = blocks[0];
    if (!first) throw new Error("No replacement content was given.");
    const target = normalizeId(blockId);
    const existing = await this.getBlock(target);

    if (existing.type === first.type) {
      const previous = { type: existing.type, [existing.type]: (existing as Record<string, unknown>)[existing.type] };
      await this.updateBlock(target, first);
      const extra = await this.insertBlocksAfter(target, blocks.slice(1), existing);
      return { converted: false, from: existing.type, to: first.type, blockIds: [target, ...extra.map((b) => b.id)], previous, parentId: NotionClient.parentIdOf(existing) };
    }

    const created = await this.insertBlocksAfter(target, blocks, existing);
    await this.deleteBlock(target);
    return { converted: true, from: existing.type, to: first.type, blockIds: created.map((b) => b.id), parentId: NotionClient.parentIdOf(existing) };
  }

  /** Notion keeps archived blocks, so a delete Oracle made can be taken back. */
  unarchiveBlock(blockId: string): Promise<FetchedBlock> {
    return this.request("PATCH", `/blocks/${normalizeId(blockId)}`, { archived: false });
  }

  /** Sends a page Oracle created to the trash, which is the reverse of creating it. */
  archivePage(pageId: string): Promise<NotionPage> {
    return this.request("PATCH", `/pages/${normalizeId(pageId)}`, { archived: true });
  }

  /** Writes a raw block body back, bypassing the type check replaceBlock does. */
  restoreBlock(blockId: string, body: Record<string, unknown>): Promise<FetchedBlock> {
    return this.request("PATCH", `/blocks/${normalizeId(blockId)}`, body);
  }

  /**
   * Finds pages by the words inside them.
   *
   * Notion has no content-search endpoint, so this reads candidate pages and scores them locally.
   * Candidates are the most recently edited pages, which is the ordering /search already returns
   * and a good proxy for "the thing I was just working on". Reads run in small batches: a burst of
   * sixty parallel requests trips Notion's rate limiter, and a strictly serial scan is slow enough
   * that the model gives up on it.
   */
  async searchPageContents(query: string, limit = 5, scan = 25): Promise<ContentMatch[]> {
    const terms = query.toLowerCase().split(/\s+/).map((t) => t.replace(/[^\w'-]/g, "")).filter((t) => t.length > 1);
    if (!terms.length) return [];

    const candidates = (await this.search("", "page", Math.min(Math.max(scan, 1), 60))) as NotionPage[];
    const matches: ContentMatch[] = [];
    const BATCH = 5;
    for (let i = 0; i < candidates.length; i += BATCH) {
      const slice = candidates.slice(i, i + BATCH);
      const read = await Promise.all(slice.map(async (page) => {
        try {
          return { page, text: await this.getPageMarkdown(page.id) };
        } catch {
          // One unreadable page must not sink the search.
          return null;
        }
      }));
      for (const item of read) {
        if (!item) continue;
        const scored = scoreText(item.text, pageTitle(item.page), terms);
        if (scored) matches.push({ id: item.page.id, title: pageTitle(item.page), url: item.page.url, ...scored });
      }
    }
    // Most terms matched first, then most occurrences: a page mentioning every word beats one
    // that repeats a single word.
    matches.sort((a, b) => b.termsMatched - a.termsMatched || b.hits - a.hits);
    return matches.slice(0, Math.min(Math.max(limit, 1), 10));
  }

  /** Rows of a database with their page text, for filling a property across a table. */
  async readDatabaseRows(dataSourceId: string, options: { limit?: number; includeContent?: boolean; onlyEmpty?: string } = {}): Promise<DatabaseRow[]> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
    const res = await this.request<Paginated<NotionPage>>("POST", `/data_sources/${normalizeId(dataSourceId)}/query`, { page_size: limit });
    const rows: DatabaseRow[] = [];
    for (const page of res.results) {
      if (options.onlyEmpty && !isEmptyProperty(page.properties?.[options.onlyEmpty])) continue;
      rows.push({
        id: page.id,
        url: page.url,
        title: pageTitle(page),
        properties: page.properties,
        content: options.includeContent === false ? undefined : await this.getPageMarkdown(page.id).catch(() => ""),
      });
    }
    return rows;
  }

  updatePage(pageId: string, properties: Record<string, unknown>): Promise<NotionPage> {
    return this.request("PATCH", `/pages/${normalizeId(pageId)}`, { properties });
  }
}

// ---------- Property helpers ----------

export function pageTitle(page: NotionPage): string {
  for (const prop of Object.values(page.properties ?? {})) {
    if (prop.type === "title") return richTextToPlain(prop.title as RichText[]) || "Untitled";
  }
  return "Untitled";
}

export function databaseTitle(db: NotionDatabase | NotionDataSource): string {
  const named = (db as NotionDataSource).name;
  if (typeof named === "string" && named) return named;
  return richTextToPlain(db.title as RichText[] | undefined) || "Untitled database";
}

/** Flatten a page's property values into readable JSON. */
export function summarizeProperties(properties: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(properties ?? {})) {
    const type = prop.type as string;
    const value = prop[type];
    switch (type) {
      case "title":
      case "rich_text":
        out[name] = richTextToPlain(value as RichText[]);
        break;
      case "select":
      case "status":
        out[name] = (value as { name?: string } | null)?.name ?? null;
        break;
      case "multi_select":
        out[name] = ((value as Array<{ name: string }>) ?? []).map((v) => v.name);
        break;
      case "date":
        out[name] = value;
        break;
      case "people":
        out[name] = ((value as Array<{ name?: string; id: string }>) ?? []).map((p) => p.name ?? p.id);
        break;
      case "relation":
        out[name] = ((value as Array<{ id: string }>) ?? []).map((r) => r.id);
        break;
      case "formula":
      case "rollup": {
        const v = value as Record<string, unknown>;
        out[name] = v?.[v.type as string] ?? null;
        break;
      }
      default:
        out[name] = value;
    }
  }
  return out;
}

const TEXT_VALUE = (s: string): RichText[] => [{ type: "text", text: { content: s.slice(0, 2000) } }];

/**
 * Convert simple values ({"Name": "Dentist", "Date": "2026-09-10T14:00:00"}) into Notion property
 * payloads using the database schema. Values already shaped like Notion payloads pass through.
 */
export function coerceProperties(schema: PropertySchema, values: Record<string, unknown>): Record<string, unknown> {
  const byLowerName = new Map(Object.values(schema).map((p) => [p.name.toLowerCase(), p] as const));
  const out: Record<string, unknown> = {};
  for (const [rawName, value] of Object.entries(values)) {
    const prop = schema[rawName] ?? byLowerName.get(rawName.toLowerCase());
    if (!prop) {
      const known = Object.values(schema).map((p) => `${p.name} (${p.type})`).join(", ");
      throw new Error(`Property "${rawName}" does not exist. Available: ${known}`);
    }
    if (value && typeof value === "object" && !Array.isArray(value) && prop.type in (value as object)) {
      out[prop.name] = value; // already a Notion payload
      continue;
    }
    out[prop.name] = coerceValue(prop.type, value, prop.name);
  }
  return out;
}

function coerceValue(type: string, value: unknown, name: string): unknown {
  const str = value == null ? "" : String(value);
  switch (type) {
    case "title":
      return { title: TEXT_VALUE(str) };
    case "rich_text":
      return { rich_text: TEXT_VALUE(str) };
    case "number":
      return { number: value == null || value === "" ? null : Number(value) };
    case "select":
      return { select: str ? { name: str } : null };
    case "status":
      return { status: { name: str } };
    case "multi_select": {
      const names = Array.isArray(value) ? value.map(String) : str.split(",").map((s) => s.trim()).filter(Boolean);
      return { multi_select: names.map((n) => ({ name: n })) };
    }
    case "date": {
      if (value == null || value === "") return { date: null };
      if (typeof value === "object") return { date: value };
      return { date: { start: str } };
    }
    case "checkbox":
      return { checkbox: typeof value === "string" ? /^(true|yes|1|x)$/i.test(value) : Boolean(value) };
    case "url":
      return { url: str || null };
    case "email":
      return { email: str || null };
    case "phone_number":
      return { phone_number: str || null };
    case "people": {
      const ids = Array.isArray(value) ? value.map(String) : str.split(",").map((s) => s.trim()).filter(Boolean);
      return { people: ids.map((id) => ({ object: "user", id })) };
    }
    case "relation": {
      const ids = Array.isArray(value) ? value.map(String) : str.split(",").map((s) => s.trim()).filter(Boolean);
      return { relation: ids.map((id) => ({ id: normalizeId(id) })) };
    }
    default:
      throw new Error(`Property "${name}" has type "${type}", which cannot be set through the API.`);
  }
}

export function findTitleProperty(schema: PropertySchema): string {
  const title = Object.values(schema).find((p) => p.type === "title");
  return title?.name ?? "Name";
}
