import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEventScript, deleteEventScript, describePowerShellError, findEventScript,
  listCalendarsScript, listEventsScript, moveEventScript, outlookDate, psLiteral, recurrenceStatements, updateEventScript,
} from "../src/mcp/win-calendar.ts";
import { parseEvents } from "../src/mcp/calendar-record.ts";

/*
 * Outlook COM needs a real Windows machine with Outlook installed, so what is tested here is the
 * PowerShell these functions generate: quoting, the date format Restrict actually accepts, and
 * that the output can be parsed by the same code the macOS backend feeds.
 */

test("a title with a quote cannot break out of its literal", () => {
  assert.equal(psLiteral("Bob's 1:1"), "'Bob''s 1:1'");
  assert.equal(psLiteral("plain"), "'plain'");
});

test("single quotes stop PowerShell interpolating a title", () => {
  // A title like $(Get-Date) or one with a backtick is data. Double quotes would run it.
  for (const nasty of ["$(Remove-Item C:\\)", "back`tick", "$env:USERNAME", '"; whoami; "']) {
    const script = createEventScript({ title: nasty, start: "2026-09-14T09:00:00" });
    assert.ok(script.includes(psLiteral(nasty)), nasty);
    assert.doesNotMatch(script, /Subject = "/, "never a double-quoted subject");
  }
});

test("Restrict dates use the US format Outlook demands whatever the locale", () => {
  // Restrict() parses with the user's short-date setting, so an ISO filter silently matches
  // nothing on a machine set to dd/MM/yyyy. This is the documented workaround.
  assert.equal(outlookDate(new Date(2026, 8, 14, 9, 5)), "09/14/2026 09:05 AM");
  assert.equal(outlookDate(new Date(2026, 8, 14, 13, 0)), "09/14/2026 01:00 PM");
  assert.equal(outlookDate(new Date(2026, 0, 2, 0, 30)), "01/02/2026 12:30 AM", "midnight is 12 AM, not 00");
  assert.equal(outlookDate(new Date(2026, 0, 2, 12, 30)), "01/02/2026 12:30 PM", "noon is 12 PM");
});

test("listing events expands recurring series", () => {
  // Without both of these, in this order, a weekly standup shows up once on the day it was made.
  const script = listEventsScript(new Date(2026, 8, 14), new Date(2026, 8, 21));
  const recurrences = script.indexOf("IncludeRecurrences = $true");
  const sort = script.indexOf("Sort('[Start]')");
  assert.ok(recurrences > -1 && sort > recurrences, "IncludeRecurrences must be set before Sort");
  assert.match(script, /Restrict\(\$filter\)/);
});

test("every script fails with an actionable message when Outlook is absent", () => {
  for (const script of [listCalendarsScript(), listEventsScript(new Date(), new Date()), deleteEventScript("x")]) {
    assert.match(script, /OUTLOOK_MISSING/);
  }
  const help = describePowerShellError("Write-Error: OUTLOOK_MISSING");
  assert.match(help, /Outlook is not installed/);
  assert.match(help, /Notion Calendar/, "it names the fallback the user can switch to");
});

test("the COM class-factory failure is recognised as a missing Outlook", () => {
  // The real error on a PC without Outlook is an HRESULT, not our sentinel.
  assert.match(describePowerShellError("Retrieving the COM class factory for component ... failed 80040154"), /Outlook is not installed/);
});

test("a stale event id is reported as stale, not as a crash", () => {
  assert.match(describePowerShellError("EVENT_NOT_FOUND"), /List the events again/);
});

test("update only touches the fields that were passed", () => {
  const script = updateEventScript({ uid: "abc", calendar: "Work", title: "Renamed" });
  assert.match(script, /\$item\.Subject = 'Renamed'/);
  for (const untouched of ["$item.Start", "$item.End", "$item.Location", "$item.Body"]) {
    assert.ok(!script.includes(`${untouched} =`), `${untouched} must be left alone`);
  }
  assert.match(script, /\$item\.Save\(\)/);
});

test("clearing a field is different from not mentioning it", () => {
  // "" is an instruction to empty the location; undefined is an instruction to leave it.
  assert.match(updateEventScript({ uid: "a", calendar: "c", location: "" }), /\$item\.Location = ''/);
  assert.ok(!updateEventScript({ uid: "a", calendar: "c" }).includes("$item.Location ="));
});

test("an all-day event sets the flag, a timed one does not", () => {
  assert.match(createEventScript({ title: "Holiday", start: "2026-12-25", allDay: true }), /AllDayEvent = \$true/);
  assert.doesNotMatch(createEventScript({ title: "Standup", start: "2026-09-14T09:00:00" }), /AllDayEvent/);
});

test("the calendar folder is found by id, not by its English name", () => {
  // Outlook names the folder in the user's language — Kalender, Calendrier, カレンダー — so
  // Folders.Item('Calendar') finds nothing outside an English install. GetDefaultFolder takes a
  // numeric id and is locale-independent; the name lookup stays only as a fallback.
  for (const script of [listCalendarsScript(), listEventsScript(new Date(), new Date(), "Work")]) {
    const byId = script.indexOf("GetDefaultFolder(9)");
    const byName = script.indexOf("Folders.Item('Calendar')");
    assert.ok(byId > -1, "must look the folder up by its numeric id");
    if (byName > -1) assert.ok(byId < byName, "the id lookup must come first, with the name as fallback");
  }
});

test("moving an event goes through Outlook's own Move, not a copy and delete", () => {
  // Unlike AppleScript, Outlook can move an item between folders, so nothing is duplicated.
  const script = moveEventScript("abc", "Personal");
  assert.match(script, /\$item\.Move\(\$folder\)/);
  assert.doesNotMatch(script, /\$item\.Delete\(\)/);
});

test("what the scripts print is what the shared parser reads", () => {
  // The emitted record format is the contract between the two backends and the tools above them.
  const script = findEventScript("abc");
  assert.match(script, /-join \[char\]31/);
  assert.match(script, /\[char\]30/);
  const sample = ["abc", "Work", "Standup", "2026-09-14T09:00:00", "2026-09-14T09:15:00", "true", "Room 2"]
    .join(String.fromCharCode(31)) + String.fromCharCode(30);
  assert.deepEqual(parseEvents(sample), [{
    uid: "abc", calendar: "Work", title: "Standup",
    start: "2026-09-14T09:00:00", end: "2026-09-14T09:15:00", allDay: true, location: "Room 2", notes: "", recurrence: "",
  }]);
});

test("a repeat rule becomes an Outlook pattern, type first, with the weekday mask and an end", () => {
  const weekly = recurrenceStatements("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE");
  assert.equal(weekly[0], "$rp = $item.GetRecurrencePattern()");
  assert.equal(weekly[1], "$rp.RecurrenceType = 1", "RecurrenceType must be set before anything else on the pattern");
  assert.ok(weekly.includes("$rp.Interval = 2"));
  assert.ok(weekly.includes("$rp.DayOfWeekMask = 10"), "Monday is 2, Wednesday is 8");
  assert.ok(weekly.includes("$rp.NoEndDate = $true"));
  assert.ok(recurrenceStatements("FREQ=DAILY;COUNT=5").includes("$rp.Occurrences = 5"));
  assert.ok(recurrenceStatements("FREQ=MONTHLY;UNTIL=20261231").some((l) => l.startsWith("$rp.PatternEndDate = [datetime]::Parse('2026-12-31')")));
  assert.deepEqual(recurrenceStatements(""), ["$item.ClearRecurrencePattern()"]);
  assert.throws(() => recurrenceStatements("FREQ=HOURLY"), /Could not read/);
});

test("create and update carry the pattern; update can stop a series", () => {
  const created = createEventScript({ title: "Standup", start: "2026-09-14T09:00:00", recurrence: "FREQ=WEEKLY;BYDAY=MO" });
  assert.ok(created.indexOf("$rp.RecurrenceType = 1") < created.indexOf("$item.Save()"), "pattern before Save");
  const cleared = updateEventScript({ uid: "id", calendar: "Calendar", recurrence: "" });
  assert.match(cleared, /ClearRecurrencePattern/);
  assert.match(updateEventScript({ uid: "id", calendar: "Calendar", allDay: true }), /\$item\.AllDayEvent = \$true/);
});

test("every event record reports notes and rebuilds the repeat rule from the pattern", () => {
  for (const script of [listEventsScript(new Date(2026, 8, 14), new Date(2026, 8, 21)), findEventScript("id")]) {
    assert.match(script, /\$item\.IsRecurring/);
    assert.match(script, /FREQ=\$freq/);
    assert.match(script, /DayOfWeekMask -band 2\) \{ \$days \+= 'MO' \}/);
    assert.match(script, /\$notes = \[string\]\$item\.Body/);
    assert.match(script, /"\$notes", "\$rr"\)|\$notes, \$rr\)/);
  }
});
