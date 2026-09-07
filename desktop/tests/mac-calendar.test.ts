import { test } from "node:test";
import assert from "node:assert/strict";
import { asString, createEventScript, dateStatements, deleteEventScript, describeAppleScriptError, findEventScript, isDateOnly, listCalendarsScript, listEventsScript, parseCalendars, parseEvents, parseIso, pickDefaultCalendar, scoreCalendar, updateEventScript } from "../src/mcp/mac-calendar.ts";

// Field/record separators used by the AppleScript output format. Built with fromCharCode
// (never pasted as literal control characters) to mirror how the module itself builds them.
const FS = String.fromCharCode(31);
const RS = String.fromCharCode(30);

// ---------- asString ----------

test("asString wraps in double quotes", () => {
  assert.equal(asString("hello"), '"hello"');
  assert.equal(asString(""), '""');
});

test("asString escapes backslashes and double quotes", () => {
  // Input characters: a " b \ c
  const input = 'a"b\\c';
  const actual = asString(input);
  // Expected characters, spelled out with escapes so the intent is unambiguous:
  // a literal double quote, "a", a literal backslash, a literal double quote, "b",
  // two literal backslashes, "c", a literal double quote.
  const expected = "\"a\\\"b\\\\c\"";
  assert.equal(actual, expected);
  // Sanity-check the expected literal really is the 9 characters described above.
  assert.deepEqual(
    [...expected],
    ['"', "a", "\\", '"', "b", "\\", "\\", "c", '"'],
  );
});

// ---------- isDateOnly ----------

test("isDateOnly recognizes YYYY-MM-DD, trimmed", () => {
  assert.equal(isDateOnly("2026-09-12"), true);
  assert.equal(isDateOnly("  2026-09-12  "), true);
});

test("isDateOnly rejects datetimes and garbage", () => {
  assert.equal(isDateOnly("2026-09-12T14:00:00"), false);
  assert.equal(isDateOnly("not-a-date"), false);
});

// ---------- parseIso ----------

test("parseIso reads a date-only value as local midnight", () => {
  const d = parseIso("2026-09-12", "start");
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8); // 0-based: September
  assert.equal(d.getDate(), 12);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getSeconds(), 0);
});

test("parseIso reads a full datetime's components", () => {
  const d = parseIso("2026-09-12T14:30:05", "start");
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 12);
  assert.equal(d.getHours(), 14);
  assert.equal(d.getMinutes(), 30);
  assert.equal(d.getSeconds(), 5);
});

test("parseIso throws a labeled ISO 8601 error for unparseable input", () => {
  assert.throws(
    () => parseIso("not-a-date", "start"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /ISO 8601/);
      assert.match(err.message, /start/);
      return true;
    },
  );
  assert.throws(
    () => parseIso("also nonsense", "from"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /ISO 8601/);
      assert.match(err.message, /from/);
      return true;
    },
  );
});

// ---------- dateStatements ----------

test("dateStatements emits 8 lines, in order, day-before-month, 1-based month", () => {
  const d = new Date(2026, 8, 12, 14, 30); // September 12, 2026, 14:30 (getMonth() === 8)
  const lines = dateStatements("s", d);
  assert.equal(lines.length, 8);
  assert.deepEqual(lines, [
    "set s to current date",
    "set day of s to 1",
    "set year of s to 2026",
    "set month of s to 9",
    "set day of s to 12",
    "set hours of s to 14",
    "set minutes of s to 30",
    "set seconds of s to 0",
  ]);

  // Guards a real bug: setting month while day is still 31 (from a prior date) can roll into
  // the next month, so "day to 1" must happen before "month to ...".
  const dayResetIndex = lines.indexOf("set day of s to 1");
  const monthIndex = lines.findIndex((l) => l.startsWith("set month of s to"));
  assert.ok(dayResetIndex >= 0 && monthIndex >= 0);
  assert.ok(dayResetIndex < monthIndex, "day must be reset to 1 before month is set");
});

test("dateStatements uses the given variable name throughout", () => {
  const lines = dateStatements("d0", new Date(2026, 0, 1, 0, 0));
  for (const l of lines) {
    assert.match(l, /\bd0\b/);
  }
});

// ---------- listCalendarsScript ----------

test("listCalendarsScript contains the expected AppleScript fragments", () => {
  const script = listCalendarsScript();
  assert.equal(typeof script, "string");
  assert.ok(script.length > 0);
  assert.match(script, /every calendar/);
  assert.match(script, /writable of c/);
  assert.match(script, /character id 31/);
  assert.match(script, /character id 30/);
});

// ---------- listEventsScript ----------

test("listEventsScript scopes to a named calendar when given one", () => {
  const from = new Date(2026, 8, 1);
  const to = new Date(2026, 8, 30);
  const script = listEventsScript(from, to, "Work");
  assert.match(script, /calendar "Work"/);
  assert.ok(!script.includes("every calendar"));
});

test("listEventsScript scans every calendar when none is given", () => {
  const from = new Date(2026, 8, 1);
  const to = new Date(2026, 8, 30);
  const script = listEventsScript(from, to);
  assert.match(script, /every calendar/);
});

test("listEventsScript always filters by start date, exposes uid, and coerces to ISO", () => {
  const from = new Date(2026, 8, 1);
  const to = new Date(2026, 8, 30);
  const script = listEventsScript(from, to, "Work");
  assert.match(script, /whose start date/);
  assert.match(script, /uid of ev/);
  // French quotes copied verbatim from the source's isoOf() coercion.
  assert.ok(script.includes("as «class isot» as string"));
});

test("listEventsScript builds both d0 and d1 via dateStatements", () => {
  const from = new Date(2026, 8, 1, 9, 0);
  const to = new Date(2026, 8, 30, 17, 0);
  const script = listEventsScript(from, to);
  assert.match(script, /set year of d0 to/);
  assert.match(script, /set year of d1 to/);
});

// ---------- createEventScript ----------

test("createEventScript: timed event with no end defaults to +1 hour", () => {
  const script = createEventScript({ title: "Standup", start: "2026-09-12T14:00:00" }, "Work");
  assert.match(script, /set hours of e to 15/);
  assert.ok(!script.includes("allday event:true"));
});

test("createEventScript: date-only start makes an all-day event ending 24h later", () => {
  const script = createEventScript({ title: "Trip", start: "2026-09-12" }, "Work");
  assert.ok(script.includes("allday event:true"));
  // Start day 12 -> end defaults to +24h -> day 13.
  assert.match(script, /set day of e to 13/);
});

test("createEventScript: explicit allDay:true with a datetime start also yields allday event:true", () => {
  const script = createEventScript({ title: "Offsite", start: "2026-09-12T09:00:00", allDay: true }, "Work");
  assert.ok(script.includes("allday event:true"));
});

test("createEventScript: location and notes are included only when provided", () => {
  const withBoth = createEventScript(
    { title: "Lunch", start: "2026-09-12T12:00:00", location: "Room 5", notes: "bring laptop" },
    "Work",
  );
  assert.ok(withBoth.includes(`location:${asString("Room 5")}`));
  assert.ok(withBoth.includes(`description:${asString("bring laptop")}`));

  const withNeither = createEventScript({ title: "Lunch", start: "2026-09-12T12:00:00" }, "Work");
  assert.ok(!withNeither.includes("location:"));
  assert.ok(!withNeither.includes("description:"));
});

test("createEventScript: title is escaped via asString", () => {
  const title = 'Meet "Bob"';
  const script = createEventScript({ title, start: "2026-09-12T12:00:00" }, "Work");
  assert.ok(script.includes(`summary:${asString(title)}`));
  // And the raw unescaped quote-adjacent form must not appear unescaped.
  assert.ok(!script.includes('summary:"Meet "Bob""'));
});

test("createEventScript: reloads calendars and returns the new uid", () => {
  const script = createEventScript({ title: "Standup", start: "2026-09-12T14:00:00" }, "Work");
  assert.match(script, /reload calendars/);
  assert.match(script, /set theUid to uid of newEvent/);
  assert.match(script, /return theUid/);
});

test("createEventScript: end at or before start throws", () => {
  assert.throws(
    () =>
      createEventScript(
        { title: "Bad", start: "2026-09-12T10:00:00", end: "2026-09-12T09:00:00" },
        "Work",
      ),
    /The event's end must be after its start\./,
  );
  // Equal start and end must also throw (condition is <=, not <).
  assert.throws(
    () =>
      createEventScript(
        { title: "Bad", start: "2026-09-12T10:00:00", end: "2026-09-12T10:00:00" },
        "Work",
      ),
    /The event's end must be after its start\./,
  );
});

test("createEventScript: calendar name is escaped and used in `tell calendar`", () => {
  const calendarName = 'My "Cal"';
  const script = createEventScript({ title: "Standup", start: "2026-09-12T14:00:00" }, calendarName);
  assert.ok(script.includes(`tell calendar ${asString(calendarName)}`));
});

// ---------- updateEventScript ----------

test("updateEventScript: only a title changes summary, not dates", () => {
  const script = updateEventScript({ uid: "u1", calendar: "Work", title: "New Title" });
  assert.match(script, /set summary of ev to/);
  assert.ok(!script.includes("set start date of ev"));
  assert.ok(!script.includes("set end date of ev"));
  assert.ok(!script.includes("set year of s to"));
  assert.ok(!script.includes("set year of e to"));
});

test("updateEventScript: start and end emit both date blocks and both setters", () => {
  const script = updateEventScript({
    uid: "u1",
    calendar: "Work",
    start: "2026-09-12T10:00:00",
    end: "2026-09-12T11:00:00",
  });
  assert.match(script, /set year of s to/);
  assert.match(script, /set year of e to/);
  assert.match(script, /set start date of ev to s/);
  assert.match(script, /set end date of ev to e/);
});

test("updateEventScript: nothing to change throws", () => {
  assert.throws(() => updateEventScript({ uid: "u1", calendar: "Work" }), /Nothing to change/);
});

test("updateEventScript: matches the event by uid", () => {
  const script = updateEventScript({ uid: "abc-123", calendar: "Work", title: "T" });
  assert.ok(script.includes(`first event whose uid = ${asString("abc-123")}`));
});

// ---------- deleteEventScript ----------

test("deleteEventScript deletes by escaped uid within the escaped calendar, then reloads", () => {
  const script = deleteEventScript("uid-1", 'My "Cal"');
  assert.ok(script.includes(`delete (first event whose uid = ${asString("uid-1")})`));
  assert.ok(script.includes(`tell calendar ${asString('My "Cal"')}`));
  assert.match(script, /reload calendars/);
});

// ---------- parseCalendars ----------

test("parseCalendars parses multiple records in order", () => {
  const rec1 = ["Home", "true", "Personal stuff"].join(FS);
  const rec2 = ["Work", "false", ""].join(FS);
  const input = rec1 + RS + rec2 + RS; // trailing record separator, as osascript would emit
  assert.deepEqual(parseCalendars(input), [
    { name: "Home", writable: true, description: "Personal stuff" },
    { name: "Work", writable: false, description: "" },
  ]);
});

test("parseCalendars maps writable 'true' to boolean true, anything else to false", () => {
  const trueRec = ["A", "true", ""].join(FS);
  const falseRec = ["B", "false", ""].join(FS);
  const otherRec = ["C", "maybe", ""].join(FS);
  const input = [trueRec, falseRec, otherRec].join(RS);
  const parsed = parseCalendars(input);
  assert.deepEqual(
    parsed.map((c) => c.writable),
    [true, false, false],
  );
});

test("parseCalendars: empty input yields no records", () => {
  assert.deepEqual(parseCalendars(""), []);
});

test("parseCalendars: missing trailing fields default to empty strings", () => {
  assert.deepEqual(parseCalendars("OnlyName"), [{ name: "OnlyName", writable: false, description: "" }]);
});

// ---------- parseEvents ----------

test("parseEvents parses multiple records in order", () => {
  const rec1 = ["uid-1", "Work", "Standup", "2026-09-12T14:00:00", "2026-09-12T15:00:00", "false", "Room 1"].join(FS);
  const rec2 = ["uid-2", "Home", "Trip", "2026-09-13T00:00:00", "2026-09-14T00:00:00", "true", ""].join(FS);
  const input = rec1 + RS + rec2 + RS;
  assert.deepEqual(parseEvents(input), [
    {
      uid: "uid-1",
      calendar: "Work",
      title: "Standup",
      start: "2026-09-12T14:00:00",
      end: "2026-09-12T15:00:00",
      allDay: false,
      location: "Room 1",
    },
    {
      uid: "uid-2",
      calendar: "Home",
      title: "Trip",
      start: "2026-09-13T00:00:00",
      end: "2026-09-14T00:00:00",
      allDay: true,
      location: "",
    },
  ]);
});

test("parseEvents maps allDay 'true' to boolean true, anything else to false", () => {
  const trueRec = ["u1", "c", "t", "s", "e", "true", ""].join(FS);
  const falseRec = ["u2", "c", "t", "s", "e", "false", ""].join(FS);
  const otherRec = ["u3", "c", "t", "s", "e", "nope", ""].join(FS);
  const parsed = parseEvents([trueRec, falseRec, otherRec].join(RS));
  assert.deepEqual(
    parsed.map((e) => e.allDay),
    [true, false, false],
  );
});

test("parseEvents: empty input yields no records", () => {
  assert.deepEqual(parseEvents(""), []);
});

test("parseEvents: missing trailing fields default to empty strings", () => {
  assert.deepEqual(parseEvents("uid-only"), [
    { uid: "uid-only", calendar: "", title: "", start: "", end: "", allDay: false, location: "" },
  ]);
});

// ---------- describeAppleScriptError ----------

test("describeAppleScriptError: permission errors mention Automation", () => {
  const byCode = describeAppleScriptError("execution error: -1743");
  assert.match(byCode, /Automation/);
  const byText = describeAppleScriptError("Not authorized to send Apple events to Calendar");
  assert.match(byText, /Automation/);
});

test("describeAppleScriptError: missing-app errors mention Internet Accounts", () => {
  const byCode = describeAppleScriptError("execution error: -600");
  assert.match(byCode, /Internet Accounts/);
  const byText = describeAppleScriptError("Calendar isn't running");
  assert.match(byText, /Internet Accounts/);
});

test("describeAppleScriptError: anything else is passed through with a prefix", () => {
  const message = describeAppleScriptError("some unrelated stderr text");
  assert.ok(message.startsWith("Calendar scripting failed"));
  assert.ok(message.includes("some unrelated stderr text"));
});

// ---------- default calendar selection ----------

test("an account calendar named after an email beats a bare local one", () => {
  assert.ok(scoreCalendar("lujoey886@gmail.com") > scoreCalendar("Untitled"));
  assert.ok(scoreCalendar("lujoey886@gmail.com") > scoreCalendar("Joey Work Calendar"));
  assert.ok(scoreCalendar("Joey Work Calendar") > scoreCalendar("Untitled"));
  assert.equal(scoreCalendar("Calendar"), scoreCalendar("Untitled"));
  assert.equal(scoreCalendar("  "), -100);
});

test("pickDefaultCalendar skips read-only calendars and never picks Untitled over an account", () => {
  const calendars = [
    { name: "Untitled", writable: true, description: "" },
    { name: "Holidays in Canada", writable: false, description: "" },
    { name: "lujoey886@gmail.com", writable: true, description: "" },
    { name: "Joey Work Calendar", writable: true, description: "" },
  ];
  assert.equal(pickDefaultCalendar(calendars)?.name, "lujoey886@gmail.com");
  // The bug this guards: taking the first writable calendar put events in a local one that
  // never syncs anywhere the user can see.
  assert.notEqual(pickDefaultCalendar(calendars)?.name, "Untitled");
});

test("pickDefaultCalendar falls back to a plain name when there is no account calendar", () => {
  assert.equal(pickDefaultCalendar([{ name: "Untitled", writable: true, description: "" }, { name: "Home", writable: true, description: "" }])?.name, "Home");
  assert.equal(pickDefaultCalendar([{ name: "Holidays", writable: false, description: "" }]), undefined);
});

test("findEventScript targets one event by uid and returns the list record shape", () => {
  const script = findEventScript("5AF6D260-DA6F", "lujoey886@gmail.com");
  assert.match(script, /first event whose uid = "5AF6D260-DA6F"/);
  assert.match(script, /tell calendar "lujoey886@gmail\.com"/);
  assert.ok(script.includes("as «class isot» as string"));
});
