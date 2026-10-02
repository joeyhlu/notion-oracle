/**
 * Turns tool calls into the line a person reads under a reply: "Searched Notion for “roadmap”"
 * rather than `search_notion {"query":"roadmap"}`.
 */

function quote(value: unknown, max = 48): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return `“${text.length > max ? `${text.slice(0, max)}…` : text}”`;
}

/** What a tool is doing, in the present-perfect a reader expects once it has finished. */
export function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "read_current_page": return "Read this page";
    case "get_selection": return "Read your selection";
    case "insert_at_cursor": return i.position === "end" ? "Added to the end of the page" : "Wrote at your cursor";
    case "replace_selection": return "Replaced your selection";
    case "search_notion": return i.query ? `Searched Notion for ${quote(i.query)}` : "Listed recent pages";
    case "search_page_contents": return `Searched inside pages for ${quote(i.query)}`;
    case "get_page": return "Read a page";
    case "read_page_blocks": return "Read the page's blocks";
    case "get_database": return "Read a database's columns";
    case "query_database": return "Looked through a database";
    case "read_database_rows": return "Read database rows";
    case "create_page": return i.title ? `Created ${quote(i.title)}` : "Created a page";
    case "create_database_entry": return "Added a database entry";
    case "update_page": return "Updated page properties";
    case "set_database_rows": return Array.isArray(i.updates) ? `Filled ${i.property ? `${quote(i.property)} on ` : ""}${i.updates.length} rows` : "Filled database rows";
    case "update_block": return "Edited a block";
    case "insert_after_block": return "Inserted blocks";
    case "delete_block": return "Deleted a block";
    case "append_to_page": return "Added to a page";
    case "web_search": return i.query ? `Searched the web for ${quote(i.query)}` : "Searched the web";
    case "web_fetch": return "Read a web page";
    default: return name.replace(/_/g, " ");
  }
}

/** Whether a tool changes anything, which the activity line marks so edits stand out. */
export function isWriteTool(name: string): boolean {
  return /^(insert|replace|create|update|set|delete|append)_/.test(name);
}
