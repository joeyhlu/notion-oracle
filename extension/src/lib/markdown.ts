/**
 * Markdown <-> Notion block conversion, plus a small Markdown -> HTML renderer
 * for the chat panel. Deliberately dependency-free.
 */

// ---------- Notion rich text ----------

export interface RichText {
  type: "text";
  text: { content: string; link?: { url: string } | null };
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
    color?: string;
  };
  plain_text?: string;
  href?: string | null;
}

const MAX_RICH_TEXT_CHARS = 2000;

/** Parse inline Markdown (bold, italic, code, strikethrough, links) into Notion rich text. */
export function parseInline(text: string): RichText[] {
  const out: RichText[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|~~[^~]+~~|\*[^*\n]+\*|_[^_\n]+_)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) pushText(out, text.slice(last, index), {});
    const token = match[0];
    if (token.startsWith("**")) pushText(out, token.slice(2, -2), { bold: true });
    else if (token.startsWith("`")) pushText(out, token.slice(1, -1), { code: true });
    else if (token.startsWith("~~")) pushText(out, token.slice(2, -2), { strikethrough: true });
    else if (token.startsWith("[")) {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (m) pushText(out, m[1] ?? "", {}, m[2]);
    } else pushText(out, token.slice(1, -1), { italic: true });
    last = index + token.length;
  }
  if (last < text.length) pushText(out, text.slice(last), {});
  return out;
}

function pushText(out: RichText[], content: string, annotations: RichText["annotations"], link?: string) {
  for (let i = 0; i < content.length; i += MAX_RICH_TEXT_CHARS) {
    const chunk = content.slice(i, i + MAX_RICH_TEXT_CHARS);
    const rt: RichText = { type: "text", text: { content: chunk } };
    if (link) rt.text.link = { url: link };
    if (annotations && Object.keys(annotations).length) rt.annotations = annotations;
    out.push(rt);
  }
}

export function richTextToMarkdown(rich: RichText[] | undefined): string {
  if (!rich) return "";
  return rich
    .map((rt) => {
      let s = rt.plain_text ?? rt.text?.content ?? "";
      const a = rt.annotations ?? {};
      if (a.code) s = `\`${s}\``;
      if (a.bold) s = `**${s}**`;
      if (a.italic) s = `*${s}*`;
      if (a.strikethrough) s = `~~${s}~~`;
      const url = rt.href ?? rt.text?.link?.url;
      if (url) s = `[${s}](${url})`;
      return s;
    })
    .join("");
}

export function richTextToPlain(rich: RichText[] | undefined): string {
  return (rich ?? []).map((rt) => rt.plain_text ?? rt.text?.content ?? "").join("");
}

// ---------- Markdown -> blocks ----------

export type NotionBlock = Record<string, unknown> & { object: "block"; type: string };

function block(type: string, body: Record<string, unknown>): NotionBlock {
  return { object: "block", type, [type]: body };
}

/** Convert Markdown to a list of Notion API block objects (one level deep; nesting is flattened). */
export function markdownToBlocks(markdown: string): NotionBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: NotionBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (trimmed === "") {
      i++;
      continue;
    }

    // Fenced code
    const fence = /^```(\w*)\s*$/.exec(trimmed);
    if (fence) {
      const language = fence[1] || "plain text";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test((lines[i] ?? "").trim())) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++; // closing fence
      blocks.push(
        block("code", {
          language: normalizeLanguage(language),
          rich_text: [{ type: "text", text: { content: body.join("\n").slice(0, MAX_RICH_TEXT_CHARS) } }],
        }),
      );
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push(block("divider", {}));
      i++;
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = (heading[1] ?? "#").length;
      blocks.push(block(`heading_${level}`, { rich_text: parseInline(heading[2] ?? "") }));
      i++;
      continue;
    }

    const todo = /^[-*+]\s+\[( |x|X)\]\s+(.*)$/.exec(trimmed);
    if (todo) {
      blocks.push(block("to_do", { rich_text: parseInline(todo[2] ?? ""), checked: (todo[1] ?? " ").toLowerCase() === "x" }));
      i++;
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      blocks.push(block("bulleted_list_item", { rich_text: parseInline(bullet[1] ?? "") }));
      i++;
      continue;
    }

    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (numbered) {
      blocks.push(block("numbered_list_item", { rich_text: parseInline(numbered[1] ?? "") }));
      i++;
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      const parts = [quote[1] ?? ""];
      i++;
      while (i < lines.length && /^>\s?/.test((lines[i] ?? "").trim())) {
        parts.push((lines[i] ?? "").trim().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(block("quote", { rich_text: parseInline(parts.join("\n")) }));
      continue;
    }

    // Paragraph: gather consecutive plain lines.
    const parts = [trimmed];
    i++;
    while (i < lines.length) {
      const next = (lines[i] ?? "").trim();
      if (next === "" || isBlockStart(next)) break;
      parts.push(next);
      i++;
    }
    blocks.push(block("paragraph", { rich_text: parseInline(parts.join("\n")) }));
  }
  return blocks;
}

function isBlockStart(line: string): boolean {
  return /^(#{1,3}\s|[-*+]\s|\d+[.)]\s|>|```|(-{3,}|\*{3,}|_{3,})$)/.test(line);
}

const KNOWN_LANGUAGES = new Set([
  "bash", "c", "c++", "c#", "css", "diff", "go", "graphql", "html", "java", "javascript", "json", "kotlin",
  "markdown", "plain text", "python", "ruby", "rust", "shell", "sql", "swift", "typescript", "yaml", "xml",
]);

function normalizeLanguage(lang: string): string {
  const l = lang.toLowerCase();
  const aliases: Record<string, string> = { js: "javascript", ts: "typescript", py: "python", sh: "shell", yml: "yaml", cpp: "c++", cs: "c#", md: "markdown", txt: "plain text" };
  const resolved = aliases[l] ?? l;
  return KNOWN_LANGUAGES.has(resolved) ? resolved : "plain text";
}

// ---------- Blocks -> Markdown ----------

export interface FetchedBlock {
  id: string;
  type: string;
  has_children?: boolean;
  children?: FetchedBlock[];
  [key: string]: unknown;
}

/** Render Notion API blocks (with optional nested `children`) as Markdown. */
export function blocksToMarkdown(blocks: FetchedBlock[], depth = 0): string {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  let numbered = 0;
  for (const b of blocks) {
    const body = (b[b.type] ?? {}) as Record<string, unknown>;
    const text = richTextToMarkdown(body.rich_text as RichText[] | undefined);
    if (b.type !== "numbered_list_item") numbered = 0;
    switch (b.type) {
      case "paragraph":
        lines.push(indent + text);
        break;
      case "heading_1":
        lines.push(`${indent}# ${text}`);
        break;
      case "heading_2":
        lines.push(`${indent}## ${text}`);
        break;
      case "heading_3":
        lines.push(`${indent}### ${text}`);
        break;
      case "bulleted_list_item":
        lines.push(`${indent}- ${text}`);
        break;
      case "numbered_list_item":
        numbered++;
        lines.push(`${indent}${numbered}. ${text}`);
        break;
      case "to_do":
        lines.push(`${indent}- [${body.checked ? "x" : " "}] ${text}`);
        break;
      case "toggle":
        lines.push(`${indent}▸ ${text}`);
        break;
      case "quote":
        lines.push(`${indent}> ${text.replace(/\n/g, `\n${indent}> `)}`);
        break;
      case "callout":
        lines.push(`${indent}> 💡 ${text}`);
        break;
      case "code":
        lines.push(`${indent}\`\`\`${(body.language as string) ?? ""}\n${richTextToPlain(body.rich_text as RichText[])}\n${indent}\`\`\``);
        break;
      case "divider":
        lines.push(`${indent}---`);
        break;
      case "child_page":
        lines.push(`${indent}📄 [${(body.title as string) ?? "Untitled"}] (child page id: ${b.id})`);
        break;
      case "child_database":
        lines.push(`${indent}🗄 [${(body.title as string) ?? "Untitled"}] (database id: ${b.id})`);
        break;
      case "image": {
        const src = (body.external as { url?: string } | undefined)?.url ?? (body.file as { url?: string } | undefined)?.url ?? "";
        lines.push(`${indent}![image](${src})`);
        break;
      }
      case "bookmark":
        lines.push(`${indent}🔖 ${(body.url as string) ?? ""}`);
        break;
      case "equation":
        lines.push(`${indent}$$${(body.expression as string) ?? ""}$$`);
        break;
      case "table_row": {
        const cells = (body.cells as RichText[][] | undefined) ?? [];
        lines.push(`${indent}| ${cells.map((c) => richTextToMarkdown(c)).join(" | ")} |`);
        break;
      }
      case "table":
      case "column_list":
      case "column":
      case "synced_block":
        break; // children carry the content
      default:
        if (text) lines.push(indent + text);
    }
    if (b.children?.length) lines.push(blocksToMarkdown(b.children, b.type === "column_list" || b.type === "column" || b.type === "table" ? depth : depth + 1));
  }
  return lines.join("\n");
}

// ---------- Markdown -> HTML (panel rendering) ----------

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inlineHtml(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return html;
}

/** Minimal, safe Markdown renderer for assistant replies. */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(inlineHtml).join("<br>")}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const t = line.trim();
    if (t.startsWith("```")) {
      flushPara();
      closeList();
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++;
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (t === "") {
      flushPara();
      closeList();
      i++;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(t);
    if (heading) {
      flushPara();
      closeList();
      const level = (heading[1] ?? "#").length + 2; // h3..h5 inside the panel
      out.push(`<h${level}>${inlineHtml(heading[2] ?? "")}</h${level}>`);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      flushPara();
      closeList();
      out.push("<hr>");
      i++;
      continue;
    }
    const todo = /^[-*+]\s+\[( |x|X)\]\s+(.*)$/.exec(t);
    const bullet = todo ? null : /^[-*+]\s+(.*)$/.exec(t);
    const numbered = todo || bullet ? null : /^\d+[.)]\s+(.*)$/.exec(t);
    if (todo || bullet || numbered) {
      flushPara();
      const kind: "ul" | "ol" = numbered ? "ol" : "ul";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      const content = todo ? `${(todo[1] ?? " ").toLowerCase() === "x" ? "☑" : "☐"} ${todo[2] ?? ""}` : (bullet?.[1] ?? numbered?.[1] ?? "");
      out.push(`<li>${inlineHtml(content)}</li>`);
      i++;
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(t);
    if (quote) {
      flushPara();
      closeList();
      out.push(`<blockquote>${inlineHtml(quote[1] ?? "")}</blockquote>`);
      i++;
      continue;
    }
    closeList();
    para.push(t);
    i++;
  }
  flushPara();
  closeList();
  return out.join("");
}
