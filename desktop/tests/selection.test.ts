import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SELECTION, normalizeSelection, selectionScript } from "../src/main/selection.ts";
import { buildSystemPrompt, buildUserTurn } from "../src/main/prompt.ts";

/*
 * The accessibility call itself needs a real Mac with the permission granted, so what is tested
 * here is everything around it: the script's shape, the trimming rules, and how a selection
 * reaches the model. The AppleScript is asserted structurally rather than executed.
 */

test("the script gives up quietly when Notion is not running", () => {
  const script = selectionScript();
  assert.match(script, /if not \(exists process "Notion"\) then return ""/);
});

test("every accessibility lookup is guarded", () => {
  // Asking for AXSelectedText on an element without it raises rather than returning missing
  // value, and an unhandled raise reads to the user like a permission failure when in fact
  // nothing was selected.
  const script = selectionScript();
  // `end try` also contains "try", so count the block terminators and the handlers.
  const blocks = script.match(/^\s*end try$/gm)?.length ?? 0;
  const handlers = script.match(/^\s*on error$/gm)?.length ?? 0;
  assert.equal(blocks, 2, "both the focused element and its selected text must be guarded");
  assert.equal(handlers, 2);
  assert.match(script, /if picked is missing value then return ""/);
});

test("the script never touches the clipboard", () => {
  // Cmd+C then read-the-pasteboard is the other way to do this, and it destroys whatever the
  // user had copied. A background overlay clobbering your clipboard is the worse bug.
  const script = selectionScript();
  assert.doesNotMatch(script, /keystroke|clipboard|key code|"c" using/i);
});

test("a whitespace-only selection counts as no selection", () => {
  // A click without a drag reports empty or whitespace; treating that as a pointer would attach
  // a stray fragment to every unrelated question.
  for (const empty of ["", "   ", "\n\n", "\t", null, undefined]) {
    assert.equal(normalizeSelection(empty), null, JSON.stringify(empty));
  }
});

test("a normal selection comes through trimmed, with newlines normalised", () => {
  assert.equal(normalizeSelection("  hello there \n"), "hello there");
  assert.equal(normalizeSelection("line one\r\nline two"), "line one\nline two");
});

test("an enormous selection is truncated and says so", () => {
  const long = normalizeSelection("x".repeat(MAX_SELECTION + 500))!;
  assert.ok(long.length < MAX_SELECTION + 40);
  assert.match(long, /selection truncated/);
});

test("a selection reaches the model in its own fenced block", () => {
  // Fenced rather than quoted: a selection can contain any characters, including quotes and
  // angle brackets, and the model has to see where the user's words end.
  const turn = buildUserTurn("make this shorter", { notionWindowTitle: "Q3 Planning", selection: "The quick brown fox." });
  assert.match(turn, /<selection>\nThe quick brown fox\.\n<\/selection>/);
  assert.ok(turn.indexOf("</context>") < turn.indexOf("make this shorter"), "the request follows the context");
});

test("no selection means no selection block at all", () => {
  for (const value of [null, undefined, ""]) {
    const turn = buildUserTurn("hello", { notionWindowTitle: "Notes", selection: value });
    assert.doesNotMatch(turn, /<selection>/, JSON.stringify(value));
  }
});

test("the system prompt tells the model to edit the selected block in place", () => {
  // Without this it appends a corrected copy, which is the behaviour that made a mess before.
  const prompt = buildSystemPrompt("");
  assert.match(prompt, /<selection>/);
  assert.match(prompt, /update_block/);
  assert.match(prompt, /rather than appending/);
});
