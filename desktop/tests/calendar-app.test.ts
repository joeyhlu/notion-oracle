import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appleScriptString,
  buildCreateEventPlan,
  dateUrl,
  describePlan,
  isDateOnly,
  naturalPhrase,
  parseWhen,
  planToAppleScript,
  planToPowerShell,
  sendKeysEscape,
  type CreateEventInput,
  type Step,
} from "../src/mcp/calendar-app.ts";

/** Narrows a step at `i` to the given variant, failing loudly if the shape doesn't match. */
function stepAt<T extends Step["type"]>(steps: Step[], i: number, type: T): Extract<Step, { type: T }> {
  const s = steps[i];
  assert.ok(s, `expected a step at index ${i}, got ${steps.length} steps`);
  assert.equal(s.type, type, `step ${i} should be "${type}"`);
  return s as Extract<Step, { type: T }>;
}

// ---------- isDateOnly ----------

test("isDateOnly recognizes bare dates and rejects datetimes", () => {
  assert.equal(isDateOnly("2026-09-07"), true);
  assert.equal(isDateOnly("2026-09-07T14:00:00"), false);
  assert.equal(isDateOnly(" 2026-09-07 "), true); // trims surrounding whitespace
});

// ---------- parseWhen ----------

test("parseWhen treats a date-only start as all-day, at local midnight", () => {
  const { start, allDay, end } = parseWhen({ title: "Birthday", start: "2026-09-07" });
  assert.equal(allDay, true);
  assert.equal(start.getFullYear(), 2026);
  assert.equal(start.getMonth(), 8); // 0-based: September
  assert.equal(start.getDate(), 7);
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
  assert.equal(start.getSeconds(), 0);
  assert.equal(end, null);
});

test("parseWhen treats a datetime start as timed unless allDay is set", () => {
  const timed = parseWhen({ title: "Dentist", start: "2026-09-07T14:00:00" });
  assert.equal(timed.allDay, false);
  assert.equal(timed.start.getHours(), 14);

  const forcedAllDay = parseWhen({ title: "Dentist", start: "2026-09-07T14:00:00", allDay: true });
  assert.equal(forcedAllDay.allDay, true);
  // allDay is a flag on the input; parseWhen does not re-snap a datetime start to midnight for it.
  assert.equal(forcedAllDay.start.getHours(), 14);
});

test("parseWhen throws a message naming ISO 8601 for an unparsable start", () => {
  assert.throws(() => parseWhen({ title: "x", start: "not-a-date" }), /ISO 8601/);
});

test("parseWhen throws for an unparsable end", () => {
  assert.throws(() => parseWhen({ title: "x", start: "2026-09-07T14:00:00", end: "also-not-a-date" }), /Could not parse end/);
});

// ---------- naturalPhrase ----------

test("naturalPhrase renders title, date and a time range", () => {
  const phrase = naturalPhrase({ title: "Dentist", start: "2026-09-07T14:00:00", end: "2026-09-07T15:30:00" });
  assert.equal(phrase, "Dentist Sep 7 2026 2pm-3:30pm");
});

test("naturalPhrase omits the time for all-day (date-only) events", () => {
  const phrase = naturalPhrase({ title: "Birthday", start: "2026-09-07" });
  assert.equal(phrase, "Birthday Sep 7 2026");
});

test("naturalPhrase shows minutes only when they are non-zero", () => {
  assert.equal(naturalPhrase({ title: "Standup", start: "2026-01-05T09:00:00" }), "Standup Jan 5 2026 9am");
  assert.equal(naturalPhrase({ title: "Standup", start: "2026-01-05T09:15:00" }), "Standup Jan 5 2026 9:15am");
});

test("naturalPhrase renders noon and half-past-midnight correctly", () => {
  assert.equal(naturalPhrase({ title: "Lunch", start: "2026-01-05T12:00:00" }), "Lunch Jan 5 2026 12pm");
  assert.equal(naturalPhrase({ title: "Vigil", start: "2026-01-05T00:30:00" }), "Vigil Jan 5 2026 12:30am");
});

// ---------- dateUrl ----------

test("dateUrl builds a cron:// deep link with 1-based, unpadded month and day", () => {
  const url = dateUrl(new Date(2026, 8, 7)); // month 8 = September (0-based Date constructor)
  assert.match(url, /^cron:\/\/\.\/2026\/9\/7\?t=\d+$/);
});

// ---------- buildCreateEventPlan ----------

test("buildCreateEventPlan rejects an empty or whitespace-only title", () => {
  const opts = { strategy: "new-event-key" as const, save: false };
  assert.throws(() => buildCreateEventPlan({ title: "", start: "2026-09-07" }, opts), /The event needs a title\./);
  assert.throws(() => buildCreateEventPlan({ title: "   ", start: "2026-09-07" }, opts), /The event needs a title\./);
});

test('buildCreateEventPlan for "new-event-key" without save: activate, jump to day, press C, type title, no Enter', () => {
  const input: CreateEventInput = { title: "  Standup  ", start: "2026-09-07T09:00:00" };
  const steps = buildCreateEventPlan(input, { strategy: "new-event-key", save: false });

  assert.deepEqual(
    steps.map((s) => s.type),
    ["activate", "delay", "open-url", "delay", "keys", "delay", "type", "delay"],
  );
  stepAt(steps, 0, "activate");
  assert.match(stepAt(steps, 2, "open-url").url, /^cron:\/\/\.\/2026\/9\/7\?t=\d+$/);
  assert.equal(stepAt(steps, 4, "keys").combo, "c");
  assert.equal(stepAt(steps, 6, "type").text, "Standup"); // trimmed
  assert.ok(!steps.some((s) => s.type === "keys" && s.combo === "enter"), "should not press Enter when save is false");
});

test('buildCreateEventPlan for "new-event-key" with save: ends by pressing Enter', () => {
  const input: CreateEventInput = { title: "Standup", start: "2026-09-07T09:00:00" };
  const steps = buildCreateEventPlan(input, { strategy: "new-event-key", save: true });

  assert.deepEqual(
    steps.map((s) => s.type),
    ["activate", "delay", "open-url", "delay", "keys", "delay", "type", "delay", "keys"],
  );
  const last = stepAt(steps, steps.length - 1, "keys");
  assert.equal(last.combo, "enter");
});

test('buildCreateEventPlan for "command-bar" types the natural-language phrase via Cmd+K, no open-url', () => {
  const input: CreateEventInput = { title: "Dentist", start: "2026-09-07T14:00:00", end: "2026-09-07T15:30:00" };
  const steps = buildCreateEventPlan(input, { strategy: "command-bar", save: false });

  assert.deepEqual(
    steps.map((s) => s.type),
    ["activate", "delay", "keys", "delay", "type", "delay"],
  );
  assert.equal(stepAt(steps, 2, "keys").combo, "cmd+k");
  assert.equal(stepAt(steps, 4, "type").text, naturalPhrase(input));
  assert.ok(!steps.some((s) => s.type === "open-url"), "command-bar strategy should never jump via a deep link");
});

test('buildCreateEventPlan for "command-bar" with save: appends Enter', () => {
  const input: CreateEventInput = { title: "Dentist", start: "2026-09-07T14:00:00" };
  const steps = buildCreateEventPlan(input, { strategy: "command-bar", save: true });
  const last = stepAt(steps, steps.length - 1, "keys");
  assert.equal(last.combo, "enter");
});

// ---------- describePlan ----------

test("describePlan drops delay steps and describes the rest in plain language", () => {
  const steps: Step[] = [
    { type: "activate" },
    { type: "delay", ms: 700 },
    { type: "open-url", url: "cron://./2026/9/7?t=1234567890" },
    { type: "delay", ms: 1200 },
    { type: "keys", combo: "c" },
    { type: "delay", ms: 600 },
    { type: "type", text: "Standup" },
    { type: "keys", combo: "cmd+k" },
    { type: "keys", combo: "enter" },
    { type: "keys", combo: "escape" },
  ];
  const lines = describePlan(steps);
  assert.ok(!lines.some((l) => /delay/i.test(l)), "delay steps must not appear in the description");
  assert.equal(lines[0], "Brought Notion Calendar to the front");
  assert.equal(lines[1], "Opened cron://./2026/9/7 (jumped to the day)"); // cache-buster stripped
  assert.equal(lines[2], "Pressed C (new event)");
  assert.equal(lines[3], 'Typed "Standup"');
  assert.equal(lines[4], "Opened the command bar (Cmd+K)");
  assert.equal(lines[5], "Pressed Enter (saved)");
  assert.equal(lines[6], "Pressed Escape");
});

// ---------- appleScriptString ----------

test("appleScriptString escapes backslashes and double quotes for an AppleScript literal", () => {
  assert.equal(appleScriptString('say "hi" \\ bye'), '"say \\"hi\\" \\\\ bye"');
  assert.equal(appleScriptString("plain"), '"plain"');
});

// ---------- sendKeysEscape ----------

test("sendKeysEscape wraps SendKeys-special characters in braces", () => {
  assert.equal(sendKeysEscape("a+b (c)"), "a{+}b {(}c{)}");
  assert.equal(sendKeysEscape("plain text"), "plain text");
  assert.equal(sendKeysEscape("^%~{}[]"), "{^}{%}{~}{{}{}}{[}{]}");
});

// ---------- planToAppleScript ----------

test("planToAppleScript renders activate, delay, keys and ASCII typing", () => {
  const steps: Step[] = [
    { type: "activate" },
    { type: "delay", ms: 700 },
    { type: "keys", combo: "enter" },
    { type: "type", text: "Standup" },
  ];
  const lines = planToAppleScript(steps);
  assert.equal(lines[0], 'tell application "Notion Calendar" to activate');
  assert.equal(lines[1], "delay 0.70");
  assert.equal(lines[2], 'tell application "System Events" to key code 36');
  assert.equal(lines[3], 'tell application "System Events" to keystroke "Standup"');
});

test("planToAppleScript routes non-ASCII typed text through the clipboard", () => {
  const lines = planToAppleScript([{ type: "type", text: "Café ☕" }]);
  assert.equal(lines[0], 'set the clipboard to "Café ☕"');
  assert.equal(lines[1], 'tell application "System Events" to keystroke "v" using command down');
});

// ---------- planToPowerShell ----------

test("planToPowerShell loads Windows Forms and renders SendKeys for keys and typed text", () => {
  const steps: Step[] = [
    { type: "keys", combo: "cmd+k" },
    { type: "keys", combo: "enter" },
    { type: "type", text: "a+b" },
    { type: "type", text: "it's mine" },
  ];
  const script = planToPowerShell(steps);
  assert.match(script, /Add-Type -AssemblyName System\.Windows\.Forms/);
  assert.match(script, /SendWait\('\^k'\)/);
  assert.match(script, /SendWait\('\{ENTER\}'\)/);
  assert.match(script, /SendWait\('a\{\+\}b'\)/);
  // single quotes in typed text are doubled for embedding in the PowerShell single-quoted literal
  assert.match(script, /SendWait\('it''s mine'\)/);
});
