import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseTarget, dayWindow, defaultWindow, describeWhen, expandListing, matchScore, planTimes, rankMatches } from "../src/mcp/calendar-edit.ts";
import type { CalendarEvent } from "../src/mcp/calendar-record.ts";

function event(overrides: Partial<CalendarEvent> & { uid: string; title: string; start: string }): CalendarEvent {
  const end = overrides.end ?? `${overrides.start.slice(0, 11)}${String(Number(overrides.start.slice(11, 13)) + 1).padStart(2, "0")}${overrides.start.slice(13)}`;
  return { calendar: "Work", allDay: false, location: "", notes: "", recurrence: "", end, ...overrides };
}

// ---------- finding by name ----------

test("matchScore: exact beats prefix beats contains beats scattered words", () => {
  assert.equal(matchScore("Dentist", "dentist"), 3);
  assert.equal(matchScore("Dentist appointment", "dentist"), 2);
  assert.equal(matchScore("Annual dentist appointment", "dentist"), 1);
  assert.equal(matchScore("Dentist: Dr Chen", "dentist chen"), 1, "every word present somewhere");
  assert.equal(matchScore("Lunch with Sam", "dentist"), 0);
  assert.equal(matchScore("Anything", ""), 0);
  assert.equal(matchScore("1:1 — Priya", "1 1 priya"), 3, "punctuation does not count");
});

test("rankMatches orders best first, then soonest", () => {
  const events = [
    event({ uid: "a", title: "Dentist appointment", start: "2026-09-20T10:00:00" }),
    event({ uid: "b", title: "Dentist", start: "2026-09-25T10:00:00" }),
    event({ uid: "c", title: "Dentist", start: "2026-09-18T10:00:00" }),
    event({ uid: "d", title: "Lunch", start: "2026-09-16T12:00:00" }),
  ];
  assert.deepEqual(rankMatches(events, "dentist").map((e) => e.uid), ["c", "b", "a"]);
});

test("chooseTarget: one match is the answer, none is none, several is a question", () => {
  const only = [event({ uid: "a", title: "Dentist", start: "2026-09-20T10:00:00" })];
  assert.deepEqual(chooseTarget(only, "dentist"), { kind: "one", event: only[0] });
  assert.deepEqual(chooseTarget([], "dentist"), { kind: "none" });
  const several = [
    event({ uid: "a", title: "Lunch with Sam", start: "2026-09-16T12:00:00" }),
    event({ uid: "b", title: "Lunch with Priya", start: "2026-09-17T12:00:00" }),
  ];
  const choice = chooseTarget(several, "lunch");
  assert.equal(choice.kind, "many");
  assert.equal(choice.kind === "many" && choice.candidates.length, 2);
});

test("chooseTarget: an exact title wins over partial ones; occurrences of one series count once", () => {
  const events = [
    event({ uid: "series", title: "Standup", start: "2026-09-14T09:00:00", recurrence: "FREQ=WEEKLY" }),
    event({ uid: "series", title: "Standup", start: "2026-09-21T09:00:00", recurrence: "FREQ=WEEKLY" }),
    event({ uid: "x", title: "Standup retro", start: "2026-09-18T09:00:00" }),
  ];
  const choice = chooseTarget(rankMatches(events, "standup"), "standup");
  assert.equal(choice.kind, "one");
  assert.equal(choice.kind === "one" && choice.event.uid, "series");
  // Without an exact match the two series-occurrences still collapse to one candidate.
  const partial = chooseTarget(rankMatches(events, "stand"), "stand");
  assert.equal(partial.kind, "many");
  assert.deepEqual(partial.kind === "many" && partial.candidates.map((c) => c.uid), ["series", "x"]);
});

test("chooseTarget: `on` narrows to a day, which settles a recurring title", () => {
  const events = [
    event({ uid: "a", title: "Lunch", start: "2026-09-16T12:00:00" }),
    event({ uid: "b", title: "Lunch", start: "2026-09-17T12:00:00" }),
  ];
  const choice = chooseTarget(events, "lunch", { on: "2026-09-17" });
  assert.equal(choice.kind === "one" && choice.event.uid, "b");
  assert.equal(chooseTarget(events, "lunch", { on: "2026-09-18" }).kind, "none");
});

test("the default search window runs a week back and three months ahead; a day window is that day", () => {
  const { from, to } = defaultWindow(new Date(2026, 8, 15, 14, 30));
  assert.equal(from.toDateString(), new Date(2026, 8, 8).toDateString());
  assert.equal(to.toDateString(), new Date(2026, 8, 15 + 91).toDateString());
  const day = dayWindow("2026-09-17");
  assert.equal(day.from.getHours(), 0);
  assert.equal(day.to.getTime() - day.from.getTime(), 24 * 60 * 60 * 1000);
});

// ---------- expanding a listing ----------

test("expandListing turns a series into its occurrences and leaves one-offs alone", () => {
  const listed = [
    event({ uid: "one", title: "Dentist", start: "2026-09-16T10:00:00" }),
    event({ uid: "series", title: "Standup", start: "2026-01-05T09:00:00", end: "2026-01-05T09:15:00", recurrence: "FREQ=WEEKLY;BYDAY=MO,WE" }),
  ];
  const out = expandListing(listed, new Date(2026, 8, 14), new Date(2026, 8, 21));
  assert.deepEqual(out.map((e) => `${e.uid} ${e.start}`), ["series 2026-09-14T09:00:00", "series 2026-09-16T09:00:00", "one 2026-09-16T10:00:00"]);
  assert.equal(out[0]!.seriesStart, "2026-01-05T09:00:00");
  assert.equal(out[0]!.end, "2026-09-14T09:15:00");
  assert.equal(out[2]!.seriesStart, undefined);
});

test("expandListing drops a series with no occurrence in range, keeps a master dated inside it, and dedupes", () => {
  const ended = event({ uid: "s", title: "Old", start: "2026-01-05T09:00:00", recurrence: "FREQ=WEEKLY;UNTIL=20260301" });
  const odd = event({ uid: "o", title: "Odd rule", start: "2026-09-15T09:00:00", recurrence: "FREQ=MONTHLY;BYDAY=2TU" });
  const twice = event({ uid: "t", title: "Twice", start: "2026-09-16T09:00:00" });
  const out = expandListing([ended, odd, twice, twice], new Date(2026, 8, 14), new Date(2026, 8, 21));
  assert.deepEqual(out.map((e) => e.uid), ["o", "t"]);
});

// ---------- planning times ----------

const dentist = event({ uid: "d", title: "Dentist", start: "2026-09-16T10:00:00", end: "2026-09-16T10:45:00" });

test("a new start keeps the event's length", () => {
  assert.deepEqual(planTimes(dentist, { start: "2026-09-18T15:00:00" }), { start: "2026-09-18T15:00:00", end: "2026-09-18T15:45:00" });
});

test("shift moves both ends; duration changes only the end; an explicit end is taken as given", () => {
  assert.deepEqual(planTimes(dentist, { shiftMinutes: 60 }), { start: "2026-09-16T11:00:00", end: "2026-09-16T11:45:00" });
  assert.deepEqual(planTimes(dentist, { shiftMinutes: -30 }), { start: "2026-09-16T09:30:00", end: "2026-09-16T10:15:00" });
  assert.deepEqual(planTimes(dentist, { durationMinutes: 90 }), { end: "2026-09-16T11:30:00" });
  assert.deepEqual(planTimes(dentist, { start: "2026-09-16T10:00:00", end: "2026-09-16T12:00:00" }), { end: "2026-09-16T12:00:00" });
});

test("nothing asked, or the same time again, plans nothing; an end before the start is refused", () => {
  assert.deepEqual(planTimes(dentist, {}), {});
  assert.deepEqual(planTimes(dentist, { start: "2026-09-16T10:00:00" }), {});
  assert.throws(() => planTimes(dentist, { end: "2026-09-16T09:00:00" }), /end must be after its start/);
  assert.throws(() => planTimes(dentist, { start: "2026-09-16T11:00:00", end: "2026-09-16T10:30:00" }), /end must be after/);
});

test("a bare date makes a timed event all-day; a time makes an all-day event timed for an hour", () => {
  assert.deepEqual(planTimes(dentist, { start: "2026-09-18" }), { start: "2026-09-18T00:00:00", end: "2026-09-19T00:00:00", allDay: true });
  const trip = event({ uid: "t", title: "Trip", start: "2026-09-20T00:00:00", end: "2026-09-22T00:00:00", allDay: true });
  assert.deepEqual(planTimes(trip, { start: "2026-09-27" }), { start: "2026-09-27T00:00:00", end: "2026-09-29T00:00:00" }, "two days stay two days");
  assert.deepEqual(planTimes(trip, { start: "2026-09-20T09:00:00" }), { start: "2026-09-20T09:00:00", end: "2026-09-20T10:00:00", allDay: false });
  assert.deepEqual(planTimes(dentist, { allDay: true }), { start: "2026-09-16T00:00:00", end: "2026-09-17T00:00:00", allDay: true });
  assert.deepEqual(planTimes(trip, { allDay: true }), {}, "already all-day");
});

test("on a repeating series only the time of day moves, and the user is told why", () => {
  const standup = event({ uid: "s", title: "Standup", start: "2026-09-14T09:00:00", end: "2026-09-14T09:15:00", recurrence: "FREQ=WEEKLY", seriesStart: "2026-01-05T09:00:00", seriesEnd: "2026-01-05T09:15:00" });
  const plan = planTimes(standup, { start: "2026-09-14T10:00:00" });
  assert.equal(plan.start, "2026-01-05T10:00:00", "the series keeps its first date");
  assert.equal(plan.end, "2026-01-05T10:15:00");
  assert.match(plan.note ?? "", /repeating event/);
  assert.match(plan.note ?? "", /2026-01-05/);
  // Same day as the master: no note needed, the request was literal.
  assert.equal(planTimes({ ...standup, start: standup.seriesStart!, end: standup.seriesEnd!, seriesStart: undefined, seriesEnd: undefined }, { start: "2026-01-05T10:00:00" }).note, undefined);
  const shifted = planTimes(standup, { shiftMinutes: 30 });
  assert.equal(shifted.start, "2026-01-05T09:30:00");
  assert.match(shifted.note ?? "", /every occurrence/);
});

test("describeWhen is a readable line for results and candidate lists", () => {
  const line = describeWhen(dentist);
  for (const part of ["Wed", "16", "Sep"]) assert.ok(line.includes(part), `${line} should mention ${part}`);
  assert.match(describeWhen(dentist), /10:00|10:00 AM/);
  assert.match(describeWhen(event({ uid: "t", title: "Trip", start: "2026-09-20T00:00:00", end: "2026-09-21T00:00:00", allDay: true })), /all day/);
});
