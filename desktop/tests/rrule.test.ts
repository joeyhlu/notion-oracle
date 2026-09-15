import { test } from "node:test";
import assert from "node:assert/strict";
import { describeRRule, expandOccurrences, formatRRule, parseRRule, toRRule } from "../src/mcp/rrule.ts";

// ---------- what people say → RRULE ----------

test("plain words become the rule a calendar expects", () => {
  assert.equal(toRRule("daily"), "FREQ=DAILY");
  assert.equal(toRRule("every day"), "FREQ=DAILY");
  assert.equal(toRRule("Weekly"), "FREQ=WEEKLY");
  assert.equal(toRRule("every week"), "FREQ=WEEKLY");
  assert.equal(toRRule("monthly"), "FREQ=MONTHLY");
  assert.equal(toRRule("every month"), "FREQ=MONTHLY");
  assert.equal(toRRule("yearly"), "FREQ=YEARLY");
  assert.equal(toRRule("annually"), "FREQ=YEARLY");
  assert.equal(toRRule("every year"), "FREQ=YEARLY");
});

test("weekdays, intervals and named days", () => {
  assert.equal(toRRule("every weekday"), "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
  assert.equal(toRRule("weekdays"), "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
  assert.equal(toRRule("every 2 weeks"), "FREQ=WEEKLY;INTERVAL=2");
  assert.equal(toRRule("every other week"), "FREQ=WEEKLY;INTERVAL=2");
  assert.equal(toRRule("biweekly"), "FREQ=WEEKLY;INTERVAL=2");
  assert.equal(toRRule("every 3 months"), "FREQ=MONTHLY;INTERVAL=3");
  assert.equal(toRRule("every other day"), "FREQ=DAILY;INTERVAL=2");
  assert.equal(toRRule("every monday"), "FREQ=WEEKLY;BYDAY=MO");
  assert.equal(toRRule("mondays and wednesdays"), "FREQ=WEEKLY;BYDAY=MO,WE");
  assert.equal(toRRule("every week on Tuesday, Thursday"), "FREQ=WEEKLY;BYDAY=TU,TH");
  assert.equal(toRRule("every 2 weeks on friday"), "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR");
  assert.equal(toRRule("every other friday"), "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR");
  // Days are sorted Sunday-first however they were said.
  assert.equal(toRRule("friday and monday"), "FREQ=WEEKLY;BYDAY=MO,FR");
});

test("never and empty clear the rule; nonsense is refused with the accepted forms", () => {
  assert.equal(toRRule("never"), "");
  assert.equal(toRRule(""), "");
  assert.equal(toRRule("  none "), "");
  assert.throws(() => toRRule("whenever I feel like it"), /Could not read the repeat/);
  assert.throws(() => toRRule("every 2 months on monday"), /Could not read the repeat/, "named days only make sense weekly");
});

test("an end is expressed as COUNT or UNTIL, never both", () => {
  assert.equal(toRRule("weekly", { count: 10 }), "FREQ=WEEKLY;COUNT=10");
  const until = toRRule("weekly", { until: "2026-12-31" });
  assert.match(until, /^FREQ=WEEKLY;UNTIL=\d{8}T\d{6}Z$/);
  // The UNTIL instant is the end of that local day, so the last occurrence on the 31st counts.
  const rule = parseRRule(until)!;
  assert.equal(rule.until!.getFullYear(), 2026);
  assert.equal(rule.until!.getMonth(), 11);
  assert.equal(rule.until!.getDate(), 31);
  assert.equal(rule.until!.getHours(), 23);
  assert.throws(() => toRRule("weekly", { count: 3, until: "2026-12-31" }), /not both/);
  assert.throws(() => toRRule("weekly", { count: 0 }), /at least 1/);
});

test("a raw RRULE passes through untouched, so a rule set in Google is never flattened", () => {
  assert.equal(toRRule("FREQ=MONTHLY;BYDAY=2TU"), "FREQ=MONTHLY;BYDAY=2TU");
  assert.equal(toRRule("RRULE:FREQ=WEEKLY;BYDAY=MO"), "FREQ=WEEKLY;BYDAY=MO");
  assert.throws(() => toRRule("FREQ=HOURLY"), /Could not read the repeat rule/);
});

// ---------- parsing and describing ----------

test("parseRRule reads the parts this module models and flags the rest as approximate", () => {
  assert.deepEqual(parseRRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,MO"), { freq: "WEEKLY", interval: 2, byDay: ["MO", "WE"] });
  assert.equal(parseRRule("FREQ=MONTHLY;BYDAY=2TU")?.approximate, true);
  assert.equal(parseRRule("FREQ=MONTHLY;BYMONTHDAY=15")?.approximate, true);
  assert.equal(parseRRule("FREQ=WEEKLY;WKST=MO")?.approximate, undefined, "WKST is harmless");
  assert.equal(parseRRule(""), null);
  assert.equal(parseRRule("FREQ=SECONDLY"), null);
  assert.equal(formatRRule({ freq: "DAILY", interval: 1 }), "FREQ=DAILY");
});

test("describeRRule reads back as a sentence fragment the user would say", () => {
  assert.equal(describeRRule("FREQ=WEEKLY"), "every week");
  assert.equal(describeRRule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"), "every weekday");
  assert.equal(describeRRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH"), "every 2 weeks on Tuesday and Thursday");
  assert.equal(describeRRule("FREQ=DAILY;COUNT=5"), "every day, 5 times");
  assert.match(describeRRule("FREQ=MONTHLY;UNTIL=20261231"), /^every month until .*2026$/);
  assert.match(describeRRule("FREQ=MONTHLY;BYDAY=2TU"), /custom rule/);
  assert.equal(describeRRule(""), "");
});

// ---------- expanding a series into dates ----------

const week = (from: string, to: string) => [new Date(`${from}T00:00:00`), new Date(`${to}T00:00:00`)] as const;

test("a weekly standup created in January shows up in a September week", () => {
  const master = { start: "2026-01-05T09:00:00", end: "2026-01-05T09:15:00" };
  const [from, to] = week("2026-09-14", "2026-09-21");
  assert.deepEqual(expandOccurrences(master, "FREQ=WEEKLY", from, to), [{ start: "2026-09-14T09:00:00", end: "2026-09-14T09:15:00" }]);
});

test("BYDAY gives one occurrence per named day, and the length is kept", () => {
  const master = { start: "2026-09-01T10:00:00", end: "2026-09-01T11:30:00" };
  const [from, to] = week("2026-09-14", "2026-09-21");
  assert.deepEqual(
    expandOccurrences(master, "FREQ=WEEKLY;BYDAY=MO,WE", from, to).map((o) => o.start),
    ["2026-09-14T10:00:00", "2026-09-16T10:00:00"],
  );
  assert.equal(expandOccurrences(master, "FREQ=WEEKLY;BYDAY=MO,WE", from, to)[0]!.end, "2026-09-14T11:30:00");
});

test("INTERVAL=2 skips alternate weeks, counted from the series' own week", () => {
  const master = { start: "2026-09-07T10:00:00", end: "2026-09-07T11:00:00" };
  const [from, to] = week("2026-09-07", "2026-10-05");
  assert.deepEqual(
    expandOccurrences(master, "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", from, to).map((o) => o.start.slice(0, 10)),
    ["2026-09-07", "2026-09-21"],
  );
});

test("COUNT counts occurrences before the window too, and UNTIL ends the series", () => {
  const master = { start: "2026-09-01T08:00:00", end: "2026-09-01T09:00:00" };
  const [from, to] = week("2026-09-01", "2026-09-30");
  assert.equal(expandOccurrences(master, "FREQ=DAILY;COUNT=3", from, to).length, 3);
  assert.equal(expandOccurrences(master, "FREQ=DAILY;COUNT=3", new Date("2026-09-03T00:00:00"), to).length, 1, "two of the three were before the window");
  assert.deepEqual(
    expandOccurrences(master, "FREQ=DAILY;UNTIL=20260903", from, to).map((o) => o.start.slice(0, 10)),
    ["2026-09-01", "2026-09-02", "2026-09-03"],
  );
});

test("monthly on the 31st skips short months and yearly on 29 Feb skips common years", () => {
  const monthly = { start: "2026-01-31T12:00:00", end: "2026-01-31T13:00:00" };
  assert.deepEqual(
    expandOccurrences(monthly, "FREQ=MONTHLY", new Date("2026-01-01T00:00:00"), new Date("2026-06-01T00:00:00")).map((o) => o.start.slice(0, 10)),
    ["2026-01-31", "2026-03-31", "2026-05-31"],
  );
  const leap = { start: "2024-02-29T12:00:00", end: "2024-02-29T13:00:00" };
  assert.deepEqual(
    expandOccurrences(leap, "FREQ=YEARLY", new Date("2024-01-01T00:00:00"), new Date("2029-01-01T00:00:00")).map((o) => o.start.slice(0, 10)),
    ["2024-02-29", "2028-02-29"],
  );
});

test("a series that ended, or a rule that cannot be read, expands to nothing", () => {
  const master = { start: "2026-01-05T09:00:00", end: "2026-01-05T09:15:00" };
  const [from, to] = week("2026-09-14", "2026-09-21");
  assert.deepEqual(expandOccurrences(master, "FREQ=WEEKLY;UNTIL=20260301", from, to), []);
  assert.deepEqual(expandOccurrences(master, "not a rule", from, to), []);
});
