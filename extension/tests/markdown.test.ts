import { test } from "node:test";
import assert from "node:assert/strict";
import { blocksToMarkdown, markdownToBlocks, markdownToHtml, parseInline } from "../src/lib/markdown.ts";

test("parseInline handles bold, code, links and plain text", () => {
  const rich = parseInline("Hello **world** and `code` at [site](https://x.y)");
  assert.deepEqual(rich.map((r) => r.text.content), ["Hello ", "world", " and ", "code", " at ", "site"]);
  assert.equal(rich[1]?.annotations?.bold, true);
  assert.equal(rich[3]?.annotations?.code, true);
  assert.equal(rich[5]?.text.link?.url, "https://x.y");
});

test("markdownToBlocks maps block types", () => {
  const md = ["# Title", "", "Para one", "continues", "- [x] done", "- [ ] todo", "- bullet", "1. first", "> quoted", "---", "```ts", "let a = 1;", "```"].join("\n");
  const blocks = markdownToBlocks(md);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["heading_1", "paragraph", "to_do", "to_do", "bulleted_list_item", "numbered_list_item", "quote", "divider", "code"],
  );
  assert.equal((blocks[2] as unknown as { to_do: { checked: boolean } }).to_do.checked, true);
  assert.equal((blocks[8] as unknown as { code: { language: string } }).code.language, "typescript");
});

test("blocksToMarkdown round-trips common blocks", () => {
  const blocks = markdownToBlocks("## Heading\n- item\n1. one\n2. two\n- [ ] task").map((b, i) => ({ ...b, id: String(i) }));
  assert.equal(blocksToMarkdown(blocks as never), "## Heading\n- item\n1. one\n2. two\n- [ ] task");
});

test("markdownToHtml escapes and renders", () => {
  const html = markdownToHtml("# Hi <b>\n\n- one **two**\n\n`x<y`");
  assert.ok(html.includes("<h3>Hi &lt;b&gt;</h3>"));
  assert.ok(html.includes("<ul><li>one <strong>two</strong></li></ul>"));
  assert.ok(html.includes("<code>x&lt;y</code>"));
});
