import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMANDS, GROUP_LABELS, LANGUAGES, PAGE_BUDGET, TONES, buildInlinePrompt, buildRefinement, commandById, commandsFor,
  filterCommands, filterOptions, inlineSystemPrompt, primaryAction, trimPage,
} from "../src/lib/commands.ts";

test("every command has a unique id, a group with a label, and at least one place to appear", () => {
  const ids = COMMANDS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of COMMANDS) {
    assert.ok(GROUP_LABELS[c.group], c.id);
    assert.ok(c.scope.length, c.id);
    assert.ok(c.instruction().length > 20, c.id);
  }
});

test("the selection menu has Notion AI's edits; the cursor menu has its drafts", () => {
  const selection = commandsFor("selection").map((c) => c.label);
  for (const label of ["Improve writing", "Fix spelling & grammar", "Make shorter", "Make longer", "Change tone", "Simplify language", "Translate", "Explain this", "Summarize", "Find action items", "Continue writing"]) {
    assert.ok(selection.includes(label), label);
  }
  const cursor = commandsFor("cursor").map((c) => c.label);
  for (const label of ["Continue writing", "Summarize", "Find action items", "Translate", "Brainstorm ideas", "Outline", "Blog post", "Meeting agenda", "Pros and cons list", "To-do list", "Email", "Social media post", "Press release", "Job description", "Essay", "Creative story", "Poem"]) {
    assert.ok(cursor.includes(label), label);
  }
  assert.ok(!cursor.includes("Make shorter"), "edits need a selection");
});

test("tones and languages match Notion AI's lists", () => {
  assert.deepEqual(TONES.map((t) => t.label), ["Professional", "Casual", "Straightforward", "Confident", "Friendly"]);
  for (const l of ["English", "Korean", "Japanese", "Spanish", "French", "German", "Portuguese", "Chinese (Simplified)"]) assert.ok(LANGUAGES.some((x) => x.label === l), l);
});

test("filtering matches word starts in labels and keywords", () => {
  assert.deepEqual(filterCommands("selection", "short").map((c) => c.id), ["shorter"]);
  assert.deepEqual(filterCommands("selection", "grammar").map((c) => c.id), ["fix"]);
  assert.deepEqual(filterCommands("selection", "typo").map((c) => c.id), ["fix"], "keywords count");
  assert.deepEqual(filterCommands("cursor", "blog").map((c) => c.id), ["blog"]);
  assert.ok(filterCommands("selection", "e").length < commandsFor("selection").length, "a single letter matches word starts only");
  assert.equal(filterCommands("selection", "").length, commandsFor("selection").length);
  assert.deepEqual(filterCommands("selection", "zzz"), []);
  assert.deepEqual(filterOptions(commandById("translate")!, "span").map((o) => o.value), ["Spanish"]);
  assert.deepEqual(filterOptions(commandById("translate")!, "chinese").map((o) => o.value), ["Chinese (Simplified)", "Chinese (Traditional)"]);
});

test("an edit of a selection sends the selection and leaves the page out", () => {
  const prompt = buildInlinePrompt({ command: commandById("shorter")!, selection: "A long sentence.", pageTitle: "Plan", pageMarkdown: "# Plan\nA long sentence." });
  assert.match(prompt, /<selection>\nA long sentence\.\n<\/selection>/);
  assert.doesNotMatch(prompt, /<page>/);
  assert.match(prompt, /<request>\nMake the selected text noticeably shorter.*Work on the text in <selection>\./s);
});

test("commands that need context, and anything at the cursor, send the page", () => {
  const explain = buildInlinePrompt({ command: commandById("explain")!, selection: "OKR", pageTitle: "Plan", pageMarkdown: "Our OKRs" });
  assert.match(explain, /<page>\nOur OKRs\n<\/page>/);
  const cont = buildInlinePrompt({ command: commandById("continue")!, selection: "", pageTitle: "Plan", pageMarkdown: "First line" });
  assert.match(cont, /<page>/);
  assert.match(cont, /Work on the page in <page>\. Continue from the end of the page\./);
});

test("options and topics reach the instruction", () => {
  const tone = buildInlinePrompt({ command: commandById("tone")!, option: "friendly", selection: "Hi.", pageTitle: "" });
  assert.match(tone, /in a friendly tone/);
  const lang = buildInlinePrompt({ command: commandById("translate")!, option: "Japanese", selection: "Hi.", pageTitle: "" });
  assert.match(lang, /into Japanese/);
  const draft = buildInlinePrompt({ command: commandById("blog")!, typed: "Write a blog post about onboarding", selection: "", pageTitle: "Plan", pageMarkdown: "x" });
  assert.match(draft, /Topic: Write a blog post about onboarding/);
  assert.equal(commandById("blog")!.topicPrefix, "Write a blog post about ");
});

test("free text is sent as the request, tied to the selection when there is one", () => {
  const prompt = buildInlinePrompt({ command: null, typed: "make it rhyme", selection: "Roses", pageTitle: "Poems", pageMarkdown: "Roses" });
  assert.match(prompt, /<request>\nmake it rhyme\n\(This is about the text in <selection>\.\)\n<\/request>/);
  assert.match(prompt, /<page>/, "a free request may need the page for context");
});

test("a long page is cut on a line boundary and says so", () => {
  const long = Array.from({ length: 5000 }, (_, i) => `line ${i} of the page`).join("\n");
  const cut = trimPage(long);
  assert.ok(cut.length < PAGE_BUDGET + 100);
  assert.match(cut, /\[… the rest of the page is not included\]$/);
  assert.equal(trimPage("short"), "short");
});

test("the result card leads with the action the command implies", () => {
  assert.equal(primaryAction(commandById("shorter")!, true), "replace");
  assert.equal(primaryAction(commandById("summarize")!, true), "insert");
  assert.equal(primaryAction(commandById("explain")!, true), "done");
  assert.equal(primaryAction(commandById("continue")!, false), "insert");
  assert.equal(primaryAction(null, true), "replace");
  assert.equal(primaryAction(null, false), "insert");
  assert.equal(primaryAction(commandById("translate")!, false), "insert", "translating the page goes below, it has nothing to replace");
});

test("the AI menu's system prompt asks for the text alone and carries the user's instructions", () => {
  const system = inlineSystemPrompt("Reply in French.");
  assert.match(system, /only the requested text/);
  assert.match(system, /Reply in French\.$/);
  assert.match(buildRefinement("shorter"), /<request>\nshorter\nApply this to your previous result/);
});
