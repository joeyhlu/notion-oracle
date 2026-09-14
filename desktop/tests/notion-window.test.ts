import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOsascriptError } from "../src/main/notion-window.ts";
import { describeWindow } from "../src/main/prompt.ts";

/*
 * The bug this guards: reading Notion's window title needs the Automation permission, while the
 * overlay's own "is Notion in front" check goes through lsappinfo and needs nothing. So the pill
 * appeared correctly, the title came back as a bare null, and Oracle announced "Notion isn't
 * showing up on my end" to someone looking at an open Notion window.
 */

test("a denied Apple Event is not mistaken for a closed app", () => {
  for (const denied of [
    "execution error: Not authorized to send Apple events to Notion. (-1743)",
    "osascript is not allowed assistive access. (-25211)",
  ]) {
    assert.equal(classifyOsascriptError(denied), "no-permission", denied);
  }
});

test("a genuinely closed app is reported as closed", () => {
  for (const closed of [
    "execution error: Notion got an error: Application isn't running. (-600)",
    "execution error: (-10814)",
  ]) {
    assert.equal(classifyOsascriptError(closed), "not-running", closed);
  }
});

test("an unrecognised failure does not send the user to a permissions pane", () => {
  // Sending someone to fix a permission that is already correct wastes their time and teaches
  // them to distrust the message.
  assert.equal(classifyOsascriptError("execution error: Can't get window 1. (-1728)"), "no-title");
  assert.equal(classifyOsascriptError(""), "no-title");
});

test("a blocked read tells the model Notion IS open, and what to fix", () => {
  const text = describeWindow({ notionWindowTitle: null, windowStatus: "no-permission" });
  assert.match(text, /Notion IS open/);
  assert.match(text, /Do not tell the user Notion is closed/);
  assert.match(text, /Privacy & Security → Automation/);
});

test("the other states each say something different and actionable", () => {
  assert.equal(describeWindow({ notionWindowTitle: "Q3 Planning" }), '"Q3 Planning"');
  assert.match(describeWindow({ notionWindowTitle: null, windowStatus: "no-title" }), /blank or new window/);
  assert.match(describeWindow({ notionWindowTitle: null, windowStatus: "not-running" }), /does not appear to be running/);
  // No status at all (an older cached hint) must not claim a permission problem.
  assert.match(describeWindow({ notionWindowTitle: null }), /does not appear to be running/);
});
