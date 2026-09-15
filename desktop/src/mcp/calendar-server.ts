/**
 * MCP server exposing Notion Calendar app control. Separate from the Notion server so the
 * tool names make the boundary obvious to the model: notion__* reads and writes the workspace
 * through the API; calendar__* drives the Notion Calendar desktop app with keystrokes.
 */

import type { ToolDefinition, ToolExecutor } from "../../../extension/src/lib/providers/types.ts";
import { APP_NAME, activateCalendarApp, calendarAppStatus, createCalendarEvent, openCalendarDate, parseWhen, type Strategy } from "./calendar-app.ts";
import * as mac from "./mac-calendar.ts";
import * as win from "./win-calendar.ts";
import { CALENDAR_TOOL_NAMES } from "./calendar-tools.ts";
import { StdioMcpServer } from "./stdio-server.ts";
import { appendChange } from "../shared/journal-file.ts";
import { dayOf, parseIso, type CalendarEvent } from "./calendar-record.ts";
import { chooseTarget, dayWindow, defaultWindow, describeWhen, planTimes, rankMatches, SEARCH_DAYS_AHEAD, SEARCH_DAYS_BACK } from "./calendar-edit.ts";
import { describeRRule, toRRule } from "./rrule.ts";

const DEFAULT_STRATEGY: Strategy = process.env.CALENDAR_STRATEGY === "command-bar" ? "command-bar" : "new-event-key";
const AUTO_SAVE = process.env.CALENDAR_AUTO_SAVE === "1";

/**
 * On macOS the system Calendar app is scriptable, which gives real create/read/update/delete
 * against the user's actual Google/iCloud/Outlook account. Keystroke automation of the Notion
 * Calendar app is the fallback for Windows, or when the user has not added their account to
 * macOS. Prefer the system calendar whenever it is available.
 */
const SYSTEM_CALENDAR = (process.platform === "darwin" || process.platform === "win32") && process.env.CALENDAR_BACKEND !== "notion-app";

/**
 * The two real backends behind one shape.
 *
 * macOS scripts Calendar.app and Windows automates Outlook; the tools above must not care which.
 * The adapters exist because the two disagree on small things — an Outlook EntryID identifies an
 * event globally, so find and delete do not need the calendar name, and Outlook can genuinely
 * move an item between folders where AppleScript has to copy and delete.
 */
/** What to call the backend in tool descriptions and messages the user will read. */
const BACKEND_NAME = process.platform === "win32" ? "Outlook" : "the macOS Calendar app";

const backend = process.platform === "win32"
  ? {
      kind: "outlook" as const,
      listCalendars: () => win.listCalendars(),
      listEvents: (from: string, to: string, calendar?: string) => win.listEvents(from, to, calendar),
      createEvent: async (input: mac.CreateEventInput) => win.createEvent({ ...input, calendar: await win.resolveCalendar(input.calendar, mac.readDefaultCalendar()) }),
      updateEvent: (input: mac.UpdateEventInput) => win.updateEvent(input),
      deleteEvent: (uid: string) => win.deleteEvent(uid),
      findEvent: (uid: string, _calendar?: string) => win.findEvent(uid),
      moveEvent: (uid: string, _from: string, to: string) => win.moveEvent(uid, to),
      resolveCalendar: (requested?: string) => win.resolveCalendar(requested, mac.readDefaultCalendar()),
    }
  : {
      kind: "calendar-app" as const,
      listCalendars: () => mac.listCalendars(),
      listEvents: (from: string, to: string, calendar?: string) => mac.listEvents(from, to, calendar),
      createEvent: (input: mac.CreateEventInput) => mac.createEvent(input),
      updateEvent: (input: mac.UpdateEventInput) => mac.updateEvent(input),
      deleteEvent: (uid: string, calendar: string) => mac.deleteEvent(uid, calendar),
      findEvent: (uid: string, calendar?: string) => mac.findEvent(uid, calendar),
      moveEvent: (uid: string, from: string, to: string) => mac.moveEvent(uid, from, to),
      resolveCalendar: (requested?: string) => mac.resolveCalendar(requested),
    };

/** Fields shared by the tools that act on an existing event: how to say which one. */
const TARGET_FIELDS = {
  match: { type: "string", description: "Words from the event's title, e.g. 'dentist'. Case does not matter. The event is looked for from a week ago to three months ahead; pass `on` to pin the day. If several different events match, the tool lists them and you pass the uid of the right one." },
  on: { type: "string", description: "The day the event is on, ISO 8601 (2026-09-17), to narrow `match` when the same title recurs or the user said which day." },
  uid: { type: "string", description: "Event uid from calendar_list_events or calendar_find_events. Use this instead of `match` when you already have it." },
  calendar: { type: "string", description: "Calendar the event is in. Optional; speeds up a uid lookup, and limits `match` to one calendar." },
} as const;

const REPEAT_FIELDS = {
  repeat: { type: "string", description: "Make it a repeating event: 'daily', 'weekly', 'every weekday', 'every 2 weeks', 'monthly', 'yearly', 'every monday and wednesday', 'every other friday', or a raw RRULE (FREQ=WEEKLY;BYDAY=MO). 'never' stops an event repeating." },
  repeat_until: { type: "string", description: "Last day of the series, ISO 8601 date. Inclusive." },
  repeat_count: { type: "integer", description: "How many times it happens in total, the first one included." },
} as const;

const SHOW_FIELD = {
  show: { type: "boolean", description: `Afterwards, open ${APP_NAME} to that day so the user sees the result. Use it when they are looking at ${APP_NAME} or ask to see it; otherwise leave it off.` },
} as const;

const SYSTEM_TOOLS: ToolDefinition[] = [
  {
    name: "calendar_list_calendars",
    description: `List the user's calendars from ${BACKEND_NAME}, with whether each is writable. Call this when the user has several calendars and it is unclear which one they mean, or before writing if you are unsure a name exists. Subscribed calendars (holidays and the like) are read-only.`,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "calendar_list_events",
    description: "Everything on the user's real calendar in a date range, repeating events expanded into their occurrences. Use it for 'what's on this week', 'am I free Thursday afternoon', or to confirm a change landed. Each event carries a uid; the editing tools accept that, or just words from the title.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start of the range, ISO 8601 (2026-09-07 or 2026-09-07T09:00:00)." },
        to: { type: "string", description: "End of the range, exclusive, ISO 8601." },
        calendar: { type: "string", description: "Limit to one calendar by name. Omit to search all of them." },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_find_events",
    description: `Find events by title: 'when is my dentist appointment', 'do I have anything with Sam coming up'. Looks from ${SEARCH_DAYS_BACK} days ago to ${SEARCH_DAYS_AHEAD} days ahead unless you pass a range, across every calendar, and returns the matches best-first with when each is and whether it repeats. You do not need this before editing — calendar_update_event and the others take the same words directly.`,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words from the title. Case does not matter." },
        from: { type: "string", description: "Start of the range to look in, ISO 8601. Widen it when the default window comes back empty." },
        to: { type: "string", description: "End of the range, exclusive, ISO 8601." },
        calendar: { type: "string", description: "Limit to one calendar by name." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_create_event",
    description:
      `Create an event in the user's real calendar (their Google, iCloud or Outlook account, via ${BACKEND_NAME}). It syncs to the account and shows up in ${APP_NAME}. Resolve relative dates yourself from the context block and pass ISO 8601. A bare date makes an all-day event. Pass repeat for a series. Confirm the result to the user with the calendar name it landed in.`,
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO 8601 start, e.g. 2026-09-12T14:00:00. A bare date (2026-09-12) makes an all-day event." },
        end: { type: "string", description: "ISO 8601 end. Defaults to one hour after start, or the next day for all-day events." },
        all_day: { type: "boolean" },
        calendar: { type: "string", description: "Calendar name to add it to. Omit to use the user's default calendar." },
        location: { type: "string" },
        notes: { type: "string" },
        ...REPEAT_FIELDS,
        ...SHOW_FIELD,
      },
      required: ["title", "start"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_update_event",
    description:
      "Change an event in one step: say which event (words from its title, or a uid) and what changes. 'Move the dentist to Friday at 3' is match:'dentist', start:'2026-09-18T15:00:00' — a new start keeps the event's length, so do not compute an end unless the length changes. shift_minutes nudges it ('push it back an hour' is 60); duration_minutes changes only how long it is; a bare date makes it all-day and a time makes an all-day event timed. Title, location, notes and repeat can change in the same call. Only the fields you pass are changed. On a repeating event the change applies to the whole series and a time change keeps the series' first date; a single occurrence cannot be edited from here, so tell the user to do that one in the calendar app.",
    input_schema: {
      type: "object",
      properties: {
        ...TARGET_FIELDS,
        title: { type: "string" },
        start: { type: "string", description: "New ISO 8601 start. The end moves with it unless you pass end or duration_minutes." },
        end: { type: "string", description: "New ISO 8601 end." },
        shift_minutes: { type: "integer", description: "Move the whole event by this many minutes; negative for earlier. Instead of start." },
        duration_minutes: { type: "integer", description: "New length in minutes." },
        all_day: { type: "boolean" },
        location: { type: "string" },
        notes: { type: "string" },
        ...REPEAT_FIELDS,
        ...SHOW_FIELD,
      },
      additionalProperties: false,
    },
  },
  {
    name: "calendar_delete_event",
    description: "Delete an event: say which one with words from its title or a uid. This is recorded so the user can undo it from the changes list, but confirm with the user before calling it unless they explicitly asked to delete that specific event. A repeating event is deleted as a whole series.",
    input_schema: {
      type: "object",
      properties: { ...TARGET_FIELDS },
      additionalProperties: false,
    },
  },
  {
    name: "calendar_move_event",
    description:
      "Move an existing event to a different calendar, when it landed in the wrong one. Say which event with words from its title or a uid. It is recreated in the target calendar and the original removed, so it gets a new uid, which this returns.",
    input_schema: {
      type: "object",
      properties: {
        ...TARGET_FIELDS,
        to_calendar: { type: "string", description: "Calendar to move it to." },
      },
      required: ["to_calendar"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_set_default_calendar",
    description:
      "Remember which calendar new events should go to when the user does not name one. Use it when the user says something like 'use my Gmail calendar' or 'set that as the default'. The choice persists across restarts. Call calendar_list_calendars first if you are not sure of the exact name.",
    input_schema: {
      type: "object",
      properties: { calendar: { type: "string", description: "Exact calendar name, from calendar_list_calendars." } },
      required: ["calendar"],
      additionalProperties: false,
    },
  },
];

const NOTION_APP_TOOLS: ToolDefinition[] = [
  {
    name: "calendar_status",
    description: `Check how calendar access is set up: whether ${BACKEND_NAME} can be reached, or whether the ${APP_NAME} app is running for keystroke fallback. Call this first if a calendar tool fails, and relay the setup guidance it returns.`,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "calendar_open",
    description: `Bring the ${APP_NAME} app to the front so the user can see it.`,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "calendar_open_date",
    description: `Open ${APP_NAME} to a specific day.`,
    input_schema: {
      type: "object",
      properties: { date: { type: "string", description: "Day to show, ISO 8601 (2026-09-07)." } },
      required: ["date"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_create_event_by_keystrokes",
    description:
      `Fallback: create an event by operating the ${APP_NAME} app: it brings the app to the front, jumps to the day, opens a new event and types the title. ` +
      `${AUTO_SAVE ? "It presses Enter to save automatically." : "By default it leaves the new event open for the user to confirm with Enter, so tell them to check it and press Enter or Save."} ` +
      `The app must already be open (check calendar_status). Resolve relative dates yourself from the context block and pass ISO 8601. This is keystroke automation and cannot read the calendar back, so never claim an event exists without the user confirming.`,
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO 8601 start, e.g. 2026-09-07T14:00:00. A bare date (2026-09-07) makes an all-day event." },
        end: { type: "string", description: "ISO 8601 end. Optional." },
        all_day: { type: "boolean" },
        save: { type: "boolean", description: `Press Enter to save immediately. Defaults to ${AUTO_SAVE ? "true" : "false"} (from the user's settings); only set it when the user explicitly asks.` },
        strategy: { type: "string", enum: ["new-event-key", "command-bar"], description: "How to drive the app. 'new-event-key' jumps to the day and presses C (default, reliable for the date; time may need adjusting). 'command-bar' types a natural-language line into Cmd+K, which can set the time too but depends on the app parsing it." },
      },
      required: ["title", "start"],
      additionalProperties: false,
    },
  },
];

export const CALENDAR_TOOLS: ToolDefinition[] = SYSTEM_CALENDAR ? [...SYSTEM_TOOLS, ...NOTION_APP_TOOLS] : NOTION_APP_TOOLS;

// The allow-list in calendar-tools.ts spans every platform, so it is a superset: what must hold
// is that nothing this server exposes is missing from it, or the CLI would refuse the call.
for (const tool of CALENDAR_TOOLS) {
  if (!CALENDAR_TOOL_NAMES.includes(tool.name)) throw new Error(`calendar-server.ts exposes ${tool.name} but calendar-tools.ts does not list it`);
}

const ok = (content: unknown) => ({ ok: true, content: typeof content === "string" ? content : JSON.stringify(content, null, 2) });
const fail = (message: string) => ({ ok: false, content: message });

/** Both paths, so the model can tell the user exactly what to fix when one is unavailable. */
/** Saves the preferred calendar after checking the backend actually has one by that name. */
async function setDefault(name: string): Promise<string> {
  const resolved = await backend.resolveCalendar(name);
  return mac.writeDefaultCalendar(resolved);
}

async function status(): Promise<Record<string, unknown>> {
  const app = await calendarAppStatus();
  const base = { notion_calendar_app: app, default_backend: SYSTEM_CALENDAR ? "system-calendar" : "notion-app-keystrokes" };
  if (!SYSTEM_CALENDAR) {
    const reason = process.platform === "darwin" || process.platform === "win32"
      ? "Disabled in settings."
      : "Only macOS and Windows have a calendar Oracle can read and write; this machine gets the create-only fallback.";
    return { ...base, system_calendar: { available: false, reason } };
  }
  try {
    const calendars = await backend.listCalendars();
    const saved = mac.readDefaultCalendar();
    return {
      ...base,
      system_calendar: {
        available: true,
        calendars: calendars.map((c) => ({ name: c.name, writable: c.writable })),
        default_calendar: saved || `${mac.pickDefaultCalendar(calendars)?.name ?? "none"} (auto-chosen; use calendar_set_default_calendar to fix it)`,
      },
    };
  } catch (error) {
    return { ...base, system_calendar: { available: false, reason: error instanceof Error ? error.message : String(error) } };
  }
}

/**
 * Journal hook. Calendar changes are recorded like Notion ones so a mistaken event can be taken
 * back from the same list, rather than being the one kind of change with no way home.
 */
const journal = process.env.ORACLE_JOURNAL ?? "";
const record = (change: Parameters<typeof appendChange>[1]): void => {
  if (journal) appendChange(journal, change);
};

const str = (value: unknown): string => (value === undefined || value === null ? "" : String(value)).trim();
const num = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Expected a number, got "${String(value)}".`);
  return n;
};

/** A listing entry as the model sees it: the record plus a readable time and repeat rule. */
function present(event: CalendarEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    uid: event.uid,
    calendar: event.calendar,
    title: event.title,
    when: describeWhen(event),
    start: event.start,
    end: event.end,
    all_day: event.allDay,
  };
  if (event.location) out.location = event.location;
  if (event.notes) out.notes = event.notes.length > 300 ? `${event.notes.slice(0, 300)}…` : event.notes;
  if (event.recurrence) out.repeats = describeRRule(event.recurrence);
  return out;
}

/**
 * The event a request means. A uid is looked up directly; otherwise the title words are
 * matched over a window (the day in `on`, else a week back to three months ahead) and the
 * request is refused with the candidates when more than one different event fits.
 */
async function locate(input: Record<string, unknown>): Promise<CalendarEvent> {
  const uid = str(input.uid);
  const calendar = str(input.calendar) || undefined;
  if (uid) {
    const found = await backend.findEvent(uid, calendar);
    if (!found) throw new Error(`No event with uid "${uid}"${calendar ? ` in "${calendar}"` : ""}. It may have been deleted or moved; find it again with calendar_find_events.`);
    return found;
  }
  const match = str(input.match);
  if (!match) throw new Error("Say which event: pass match (words from its title) or uid (from a listing).");
  const on = str(input.on);
  const window = on ? dayWindow(on) : defaultWindow();
  const events = await backend.listEvents(window.from.toISOString(), window.to.toISOString(), calendar);
  const choice = chooseTarget(rankMatches(events, match), match, on ? { on } : {});
  if (choice.kind === "one") return choice.event;
  if (choice.kind === "none") {
    const where = on ? `on ${dayOf(on)}` : `between ${dayOf(window.from.toISOString())} and ${dayOf(window.to.toISOString())}`;
    throw new Error(`No event matching "${match}" ${where}${calendar ? ` in "${calendar}"` : ""}. Try other words from the title, or calendar_find_events with a wider from/to.`);
  }
  const list = choice.candidates.map((c) => `- "${c.title}" — ${describeWhen(c)} (${c.calendar}), uid ${c.uid}`).join("\n");
  throw new Error(`Several events match "${match}":\n${list}\nPass the uid of the one the user means, or narrow with on (the day).`);
}

/** Best-effort: showing the day in Notion Calendar is a courtesy, never the reason a change fails. */
async function showDay(iso: string): Promise<string> {
  try {
    await openCalendarDate(parseIso(iso, "start"));
    return `${APP_NAME} is showing that day.`;
  } catch (error) {
    return `Could not open ${APP_NAME}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const SYNC_NOTE = `It syncs to the account and appears in ${APP_NAME} within a minute or so.`;

export const execute: ToolExecutor = async (name, input) => {
  try {
    switch (name) {
      case "calendar_status":
        return ok(await status());
      case "calendar_open":
        await activateCalendarApp();
        return ok(`${APP_NAME} is now in front.`);
      case "calendar_open_date": {
        const { start } = parseWhen({ title: "-", start: String(input.date ?? "") });
        await openCalendarDate(start);
        return ok(`${APP_NAME} is showing ${start.toDateString()}.`);
      }

      case "calendar_list_calendars":
        return ok(await backend.listCalendars());

      case "calendar_list_events": {
        const events = await backend.listEvents(str(input.from), str(input.to), str(input.calendar) || undefined);
        if (!events.length) return ok("No events in that range.");
        return ok(events.map(present));
      }

      case "calendar_find_events": {
        const query = str(input.query);
        if (!query) throw new Error("Pass query: words from the event's title.");
        const window = defaultWindow();
        const from = str(input.from) ? parseIso(str(input.from), "from") : window.from;
        const to = str(input.to) ? parseIso(str(input.to), "to") : window.to;
        const events = await backend.listEvents(from.toISOString(), to.toISOString(), str(input.calendar) || undefined);
        const matches = rankMatches(events, query);
        const range = `${dayOf(from.toISOString())} to ${dayOf(to.toISOString())}`;
        if (!matches.length) return ok({ matches: [], searched: range, note: "Nothing with that in the title. Try other words, or pass from/to to look further out." });
        return ok({ matches: matches.slice(0, 25).map(present), searched: range });
      }

      case "calendar_create_event": {
        const title = str(input.title);
        const recurrence = input.repeat === undefined ? undefined : toRRule(str(input.repeat), { until: str(input.repeat_until) || undefined, count: num(input.repeat_count) }) || undefined;
        const created = await backend.createEvent({
          title,
          start: str(input.start),
          end: str(input.end) || undefined,
          allDay: Boolean(input.all_day),
          calendar: str(input.calendar) || undefined,
          location: str(input.location) || undefined,
          notes: str(input.notes) || undefined,
          recurrence,
        });
        record({ tool: "calendar", kind: "event", action: "create", label: `Added "${title}" to ${created.calendar}`, target: created.calendar, undo: { type: "delete-event", uid: created.uid, calendar: created.calendar } });
        const result: Record<string, unknown> = { created: true, ...created, title, start: str(input.start) };
        if (recurrence) result.repeats = describeRRule(recurrence);
        result.note = `Added to "${created.calendar}". ${SYNC_NOTE}`;
        if (input.show) result.shown = await showDay(str(input.start));
        return ok(result);
      }

      case "calendar_set_default_calendar": {
        const chosen = await setDefault(str(input.calendar));
        return ok({ default_calendar: chosen, note: `New events go to "${chosen}" unless the user names another calendar.` });
      }

      case "calendar_move_event": {
        const target = await locate({ ...input, calendar: str(input.calendar) || str(input.from_calendar) });
        const moved = await backend.moveEvent(target.uid, target.calendar, str(input.to_calendar));
        record({ tool: "calendar", kind: "event", action: "update", label: `Moved "${target.title}" from ${target.calendar} to ${moved.calendar}`, target: moved.calendar,
          undo: { type: "move-event-back", uid: moved.uid, calendar: moved.calendar, toCalendar: target.calendar } });
        return ok({ moved: true, ...moved, title: target.title, note: `Now in "${moved.calendar}". The event was recreated there, so its uid changed. ${SYNC_NOTE}` });
      }

      case "calendar_update_event": {
        const target = await locate(input);
        // The master record, re-read by uid: for a series that is the first occurrence, which is
        // what the times are computed against, and it is the before-state the undo writes back.
        const before = (await backend.findEvent(target.uid, target.calendar)) ?? target;
        const times = planTimes(before, {
          start: str(input.start) || undefined,
          end: str(input.end) || undefined,
          shiftMinutes: num(input.shift_minutes),
          durationMinutes: num(input.duration_minutes),
          allDay: typeof input.all_day === "boolean" ? input.all_day : undefined,
        });
        const recurrence = input.repeat === undefined ? undefined : toRRule(str(input.repeat), { until: str(input.repeat_until) || undefined, count: num(input.repeat_count) });
        const update = {
          uid: before.uid,
          calendar: before.calendar,
          title: input.title === undefined ? undefined : str(input.title),
          ...times,
          location: input.location === undefined ? undefined : str(input.location),
          notes: input.notes === undefined ? undefined : str(input.notes),
          recurrence: recurrence === before.recurrence ? undefined : recurrence,
        };
        delete (update as { note?: string }).note;
        const changed = Object.entries(update).filter(([k, v]) => v !== undefined && k !== "uid" && k !== "calendar");
        if (!changed.length) {
          return ok({ updated: false, uid: before.uid, calendar: before.calendar, title: before.title, when: describeWhen(before), note: "Nothing to change: the event already is as asked." });
        }
        await backend.updateEvent(update);
        record({ tool: "calendar", kind: "event", action: "update", label: `Changed "${before.title}"`, target: before.calendar,
          undo: { type: "restore-event", uid: before.uid, calendar: before.calendar, fields: { ...before } } });
        const after = { ...before, ...update, recurrence: update.recurrence ?? before.recurrence, allDay: update.allDay ?? before.allDay };
        const result: Record<string, unknown> = {
          updated: true,
          uid: before.uid,
          calendar: before.calendar,
          title: after.title ?? before.title,
          changed: changed.map(([k]) => k),
          was: { when: describeWhen(before), start: before.start, end: before.end },
          now: { when: describeWhen(after), start: after.start, end: after.end },
        };
        if (after.recurrence) result.repeats = describeRRule(after.recurrence);
        else if (before.recurrence) result.repeats = "no longer repeats";
        if (times.note) result.series_note = times.note;
        result.note = SYNC_NOTE;
        if (input.show) result.shown = await showDay(after.start);
        return ok(result);
      }

      case "calendar_delete_event": {
        // Calendar.app has no trash, so the fields are the only copy: capture them or the delete
        // really is final.
        const target = await locate(input);
        const doomed = (await backend.findEvent(target.uid, target.calendar)) ?? target;
        await backend.deleteEvent(doomed.uid, doomed.calendar);
        record({ tool: "calendar", kind: "event", action: "delete", label: `Deleted "${doomed.title}"`, target: doomed.calendar,
          undo: { type: "restore-event", uid: doomed.uid, calendar: doomed.calendar, fields: { ...doomed } } });
        return ok({ deleted: true, uid: doomed.uid, calendar: doomed.calendar, title: doomed.title, when: describeWhen(doomed), repeated: Boolean(doomed.recurrence), note: "Gone from the calendar; the user can undo it from Oracle's changes list." });
      }

      case "calendar_create_event_by_keystrokes": {
        const result = await createCalendarEvent(
          { title: String(input.title ?? ""), start: String(input.start ?? ""), end: input.end ? String(input.end) : undefined, allDay: Boolean(input.all_day) },
          { strategy: (input.strategy as Strategy | undefined) ?? DEFAULT_STRATEGY, save: typeof input.save === "boolean" ? input.save : AUTO_SAVE },
        );
        return ok(result);
      }

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
};

export const server = new StdioMcpServer({
  name: "notion-oracle-calendar",
  version: "0.1.0",
  instructions: SYSTEM_CALENDAR
    ? `Tools for the user's real calendar (their Google, iCloud or Outlook account) through ${BACKEND_NAME}, which syncs to the account and shows up in ${APP_NAME}. Reading, creating, updating and deleting all work. If a tool reports a permission or setup problem, relay its instructions to the user instead of retrying.`
    : `Tools that control the ${APP_NAME} desktop app by keystrokes, which is the only option on this platform. The app must be open. Creating an event cannot be read back, so ask the user to confirm the result.`,
  tools: CALENDAR_TOOLS,
  execute,
});

if (process.env.NOTION_ORACLE_MCP_TEST !== "1") server.serve();
