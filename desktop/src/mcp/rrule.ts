/**
 * Repeating events, in the one dialect every calendar speaks: RFC 5545 recurrence rules.
 *
 * Calendar.app stores a series as an RRULE string and exposes it as the event's `recurrence`;
 * Outlook has a pattern object that maps onto the same handful of shapes. Neither expands a
 * series into dated occurrences for a script, so `expandOccurrences` does that here, which is
 * what lets "what's on Thursday" include the weekly standup created in January.
 *
 * Deliberately small: daily, weekly (with weekdays), monthly by day-of-month, yearly, with an
 * interval and either a count or an end date. Anything richer is read back as-is, shown to the
 * user, and expanded on its simple part — a rule the user set in Google is never rewritten.
 */

import { localIso, parseIso } from "./calendar-record.ts";

export type Frequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
export type Weekday = "SU" | "MO" | "TU" | "WE" | "TH" | "FR" | "SA";

export const WEEKDAYS: readonly Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const WORK_WEEK: readonly Weekday[] = ["MO", "TU", "WE", "TH", "FR"];

export interface Rule {
  freq: Frequency;
  interval: number;
  /** Weekly only. Sorted Sunday-first. */
  byDay?: Weekday[];
  count?: number;
  /** Last instant an occurrence may start, local time. */
  until?: Date;
  /** The text had parts this module does not model (BYMONTHDAY, BYSETPOS…); expansion is approximate. */
  approximate?: boolean;
}

const DAY_WORDS: Record<string, Weekday> = {
  sun: "SU", sunday: "SU", sundays: "SU",
  mon: "MO", monday: "MO", mondays: "MO",
  tue: "TU", tues: "TU", tuesday: "TU", tuesdays: "TU",
  wed: "WE", weds: "WE", wednesday: "WE", wednesdays: "WE",
  thu: "TH", thur: "TH", thurs: "TH", thursday: "TH", thursdays: "TH",
  fri: "FR", friday: "FR", fridays: "FR",
  sat: "SA", saturday: "SA", saturdays: "SA",
};

const DAY_NAMES: Record<Weekday, string> = { SU: "Sunday", MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday" };

function sortDays(days: Iterable<Weekday>): Weekday[] {
  return [...new Set(days)].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
}

/** Formats UNTIL the way RFC 5545 wants for a timed series: the instant in UTC. */
function untilText(until: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${until.getUTCFullYear()}${p(until.getUTCMonth() + 1)}${p(until.getUTCDate())}T${p(until.getUTCHours())}${p(until.getUTCMinutes())}${p(until.getUTCSeconds())}Z`;
}

/** Reads an UNTIL value in either the date form (20261231) or the UTC instant form. */
function parseUntil(text: string): Date | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(text.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return new Date(Number(y), Number(mo) - 1, Number(d), 23, 59, 59);
  if (z) return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

/** Parses an RRULE body ("FREQ=WEEKLY;BYDAY=MO,WE", with or without an "RRULE:" prefix). */
export function parseRRule(text: string): Rule | null {
  const body = text.trim().replace(/^RRULE:/i, "");
  if (!body) return null;
  const parts = new Map<string, string>();
  for (const piece of body.split(";")) {
    const [k, v] = piece.split("=");
    if (k && v !== undefined) parts.set(k.trim().toUpperCase(), v.trim());
  }
  const freq = parts.get("FREQ")?.toUpperCase();
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  const rule: Rule = { freq, interval: Math.max(1, Number(parts.get("INTERVAL") ?? 1) || 1) };
  const byDay = parts.get("BYDAY");
  if (byDay) {
    const days: Weekday[] = [];
    let positional = false;
    for (const token of byDay.split(",")) {
      const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(token.trim());
      if (!m) continue;
      if (m[1]) positional = true;
      days.push(m[2]!.toUpperCase() as Weekday);
    }
    if (freq === "WEEKLY" && !positional && days.length) rule.byDay = sortDays(days);
    else rule.approximate = true;
  }
  const count = Number(parts.get("COUNT"));
  if (count > 0) rule.count = count;
  const until = parts.get("UNTIL");
  if (until) rule.until = parseUntil(until);
  for (const key of parts.keys()) {
    if (["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL", "WKST"].includes(key)) continue;
    rule.approximate = true;
  }
  return rule;
}

export function formatRRule(rule: Rule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay?.length) parts.push(`BYDAY=${rule.byDay.join(",")}`);
  if (rule.count) parts.push(`COUNT=${rule.count}`);
  if (rule.until) parts.push(`UNTIL=${untilText(rule.until)}`);
  return parts.join(";");
}

export interface RepeatOptions {
  /** Last day of the series, ISO date. Inclusive. */
  until?: string;
  /** Number of occurrences, the first one included. */
  count?: number;
}

/**
 * Turns what a person says into a rule: "weekly", "every weekday", "every 2 weeks on tuesday
 * and thursday", "monthly", "every other friday", "daily", "yearly", or a raw RRULE. "never"
 * and "" mean no repeat, which is how a series is turned back into a single event.
 */
export function toRRule(repeat: string, options: RepeatOptions = {}): string {
  const text = repeat.trim().toLowerCase().replace(/\s+/g, " ");
  if (!text || ["never", "none", "no", "off", "once", "one-off", "one off"].includes(text)) return "";

  let rule: Rule | null = null;
  if (/^(rrule:)?freq=/i.test(text)) {
    rule = parseRRule(repeat.trim());
    if (!rule) throw new Error(`Could not read the repeat rule "${repeat}". Use FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with optional INTERVAL, BYDAY, COUNT or UNTIL.`);
    // Raw rules are kept verbatim so a richer Google rule is not flattened; only the end is touched.
    if (!options.until && !options.count) return repeat.trim().replace(/^RRULE:/i, "");
  } else {
    rule = phraseToRule(text);
    if (!rule) {
      throw new Error(`Could not read the repeat "${repeat}". Try daily, weekly, every weekday, every 2 weeks, monthly, yearly, every monday and wednesday, or never.`);
    }
  }
  if (options.count && options.until) throw new Error("Pass repeat_count or repeat_until, not both.");
  if (options.count !== undefined) {
    if (!Number.isInteger(options.count) || options.count < 1) throw new Error("repeat_count must be a whole number of at least 1.");
    rule.count = options.count;
    delete rule.until;
  }
  if (options.until) {
    const day = parseIso(options.until, "repeat_until");
    rule.until = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59);
    delete rule.count;
  }
  return formatRRule(rule);
}

function phraseToRule(text: string): Rule | null {
  const body = text.replace(/^(repeat(s|ing)?|recur(s|ring)?|happens|occurs)\s+/, "");
  let interval = 1;
  const every = /^every\s+(other|(\d+)|second|third)\s+(day|week|month|year)s?(.*)$/.exec(body);
  const plain = /^(daily|weekly|monthly|yearly|annually|biweekly|fortnightly|weekdays|workdays|every day|every week|every month|every year|every weekday|every workday|every other day|every other week|every other month|every other year)(?![a-z])(.*)$/.exec(body);
  let freq: Frequency | null = null;
  let rest = "";
  if (every) {
    interval = every[1] === "other" || every[1] === "second" ? 2 : every[1] === "third" ? 3 : Number(every[2]);
    freq = unit(every[3]!);
    rest = every[4] ?? "";
  } else if (plain) {
    const head = plain[1]!;
    rest = plain[2] ?? "";
    if (/weekday|workday/.test(head)) return { freq: "WEEKLY", interval: 1, byDay: [...WORK_WEEK] };
    if (/biweekly|fortnightly|every other week/.test(head)) {
      interval = 2;
      freq = "WEEKLY";
    } else {
      if (head.startsWith("every other ")) interval = 2;
      freq = unit(head.replace(/^every (other )?/, "").replace(/^annually$/, "year").replace(/ly$|s$/, ""));
    }
  } else {
    // "every monday", "mondays and wednesdays", "on tue/thu", "every other friday"
    const days = daysIn(body);
    if (!days.length) return null;
    const alternate = /^every\s+(other|second)\s+/.exec(body);
    return { freq: "WEEKLY", interval: alternate ? 2 : 1, byDay: days };
  }
  if (!freq) return null;
  const rule: Rule = { freq, interval };
  const days = daysIn(rest);
  if (days.length) {
    if (freq !== "WEEKLY") return null;
    rule.byDay = days;
  } else if (rest.trim() && !/^(on|at)?\s*$/.test(rest)) {
    return null;
  }
  return rule;
}

function unit(word: string): Frequency | null {
  if (/^dai/.test(word)) return "DAILY";
  switch (word.replace(/s$/, "")) {
    case "day": return "DAILY";
    case "week": return "WEEKLY";
    case "month": return "MONTHLY";
    case "year": return "YEARLY";
    default: return null;
  }
}

function daysIn(text: string): Weekday[] {
  const found: Weekday[] = [];
  for (const word of text.toLowerCase().split(/[^a-z]+/)) {
    const day = DAY_WORDS[word];
    if (day) found.push(day);
  }
  return sortDays(found);
}

/** "every week on Monday and Wednesday until 31 Dec 2026" — for the user, from a rule. */
export function describeRRule(text: string): string {
  const rule = parseRRule(text);
  if (!rule) return text.trim() ? "repeats (custom rule)" : "";
  const n = rule.interval;
  let phrase: string;
  const days = rule.byDay ?? [];
  if (rule.freq === "WEEKLY" && days.length === 5 && WORK_WEEK.every((d) => days.includes(d)) && n === 1) phrase = "every weekday";
  else {
    const unitName = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" }[rule.freq];
    phrase = n === 1 ? `every ${unitName}` : `every ${n} ${unitName}s`;
    if (days.length) phrase += ` on ${listWords(days.map((d) => DAY_NAMES[d]))}`;
  }
  if (rule.count) phrase += `, ${rule.count} times`;
  if (rule.until) phrase += ` until ${rule.until.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
  if (rule.approximate) phrase += " (custom rule, shown approximately)";
  return phrase;
}

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export interface Occurrence {
  start: string;
  end: string;
}

const MAX_STEPS = 5000;

function addMonths(date: Date, months: number, dayOfMonth: number): Date | null {
  const d = new Date(date.getFullYear(), date.getMonth() + months, 1, date.getHours(), date.getMinutes(), date.getSeconds());
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  if (dayOfMonth > daysInMonth) return null;
  d.setDate(dayOfMonth);
  return d;
}

/**
 * Every occurrence of a series that starts inside [from, to). The master's own start is the
 * first occurrence. Occurrences before `from` are counted (for COUNT) but not returned.
 */
export function expandOccurrences(master: { start: string; end: string }, rrule: string, from: Date, to: Date, limit = 500): Occurrence[] {
  const rule = parseRRule(rrule);
  if (!rule) return [];
  const first = parseIso(master.start, "start");
  const last = parseIso(master.end, "end");
  const duration = Math.max(0, last.getTime() - first.getTime());
  const out: Occurrence[] = [];
  let produced = 0;

  const emit = (start: Date): boolean => {
    if (rule.until && start.getTime() > rule.until.getTime()) return false;
    if (rule.count && produced >= rule.count) return false;
    produced += 1;
    if (start.getTime() >= to.getTime()) return false;
    if (start.getTime() >= from.getTime()) out.push({ start: localIso(start), end: localIso(new Date(start.getTime() + duration)) });
    return out.length < limit;
  };

  if (rule.freq === "WEEKLY" && rule.byDay?.length) {
    // Walk week by week from the master's week; the master itself is always the first occurrence
    // even when its weekday is not in BYDAY (Calendar.app treats it that way).
    const weekStart = new Date(first.getFullYear(), first.getMonth(), first.getDate() - first.getDay(), first.getHours(), first.getMinutes(), first.getSeconds());
    for (let week = 0; week < MAX_STEPS; week += rule.interval) {
      let alive = true;
      for (const day of rule.byDay) {
        const start = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + week * 7 + WEEKDAYS.indexOf(day), first.getHours(), first.getMinutes(), first.getSeconds());
        if (start.getTime() < first.getTime()) continue;
        if (!emit(start)) { alive = false; break; }
      }
      if (!alive) break;
      if (new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + (week + rule.interval) * 7).getTime() >= to.getTime()) break;
    }
    return out;
  }

  for (let step = 0; step < MAX_STEPS; step += 1) {
    let start: Date | null;
    switch (rule.freq) {
      case "DAILY":
        start = new Date(first.getFullYear(), first.getMonth(), first.getDate() + step * rule.interval, first.getHours(), first.getMinutes(), first.getSeconds());
        break;
      case "WEEKLY":
        start = new Date(first.getFullYear(), first.getMonth(), first.getDate() + step * rule.interval * 7, first.getHours(), first.getMinutes(), first.getSeconds());
        break;
      case "MONTHLY":
        start = addMonths(first, step * rule.interval, first.getDate());
        if (!start) {
          // A 31st in a 30-day month: no occurrence, but not the end of the series either.
          const probe = new Date(first.getFullYear(), first.getMonth() + step * rule.interval, 1);
          if (probe.getTime() >= to.getTime()) return out;
          continue;
        }
        break;
      case "YEARLY":
        start = new Date(first.getFullYear() + step * rule.interval, first.getMonth(), first.getDate(), first.getHours(), first.getMinutes(), first.getSeconds());
        if (start.getMonth() !== first.getMonth()) continue; // 29 Feb in a common year
        break;
    }
    if (!emit(start)) break;
  }
  return out;
}
