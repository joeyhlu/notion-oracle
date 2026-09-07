/**
 * MCP server exposing Notion Calendar app control. Separate from the Notion server so the
 * tool names make the boundary obvious to the model: notion__* reads and writes the workspace
 * through the API; calendar__* drives the Notion Calendar desktop app with keystrokes.
 */

import type { ToolDefinition, ToolExecutor } from "../../../extension/src/lib/providers/types.ts";
import { APP_NAME, activateCalendarApp, calendarAppStatus, createCalendarEvent, openCalendarDate, parseWhen, type Strategy } from "./calendar-app.ts";
import * as mac from "./mac-calendar.ts";
import { CALENDAR_TOOL_NAMES } from "./calendar-tools.ts";
import { StdioMcpServer } from "./stdio-server.ts";

const DEFAULT_STRATEGY: Strategy = process.env.CALENDAR_STRATEGY === "command-bar" ? "command-bar" : "new-event-key";
const AUTO_SAVE = process.env.CALENDAR_AUTO_SAVE === "1";

/**
 * On macOS the system Calendar app is scriptable, which gives real create/read/update/delete
 * against the user's actual Google/iCloud/Outlook account. Keystroke automation of the Notion
 * Calendar app is the fallback for Windows, or when the user has not added their account to
 * macOS. Prefer the system calendar whenever it is available.
 */
const SYSTEM_CALENDAR = process.platform === "darwin" && process.env.CALENDAR_BACKEND !== "notion-app";

const SYSTEM_TOOLS: ToolDefinition[] = [
  {
    name: "calendar_list_calendars",
    description: "List the user's calendars from the macOS Calendar app, with whether each is writable. Call this when the user has several calendars and it is unclear which one they mean, or before writing if you are unsure a name exists. Subscribed calendars (holidays and the like) are read-only.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "calendar_list_events",
    description: "Read the user's real calendar events in a date range. Use this to answer questions like what is on the calendar this week, to find an event before changing it, or to confirm an event was created. Returns each event's uid, which update and delete need.",
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
    name: "calendar_create_event",
    description:
      "Create an event in the user's real calendar (their Google, iCloud or Outlook account via the macOS Calendar app). It syncs to the account and shows up in Notion Calendar. Resolve relative dates yourself from the context block and pass ISO 8601. A bare date makes an all-day event. Confirm the result to the user with the calendar name it landed in.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO 8601 start, e.g. 2026-09-12T14:00:00. A bare date (2026-09-12) makes an all-day event." },
        end: { type: "string", description: "ISO 8601 end. Defaults to one hour after start, or the next day for all-day events." },
        all_day: { type: "boolean" },
        calendar: { type: "string", description: "Calendar name to add it to. Omit to use the user's first writable calendar." },
        location: { type: "string" },
        notes: { type: "string" },
      },
      required: ["title", "start"],
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
  {
    name: "calendar_move_event",
    description:
      "Move an existing event to a different calendar. Use this when an event landed in the wrong calendar. It recreates the event in the target calendar and removes the original, so the event gets a new uid, which this returns.",
    input_schema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "Event uid from calendar_list_events." },
        from_calendar: { type: "string", description: "Calendar the event is currently in." },
        to_calendar: { type: "string", description: "Calendar to move it to." },
      },
      required: ["uid", "from_calendar", "to_calendar"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_update_event",
    description: "Change an existing event: retitle it, move it to another time, or set its location or notes. Find the event with calendar_list_events first to get its uid and calendar. Only the fields you pass are changed.",
    input_schema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "Event uid from calendar_list_events." },
        calendar: { type: "string", description: "Name of the calendar the event is in." },
        title: { type: "string" },
        start: { type: "string", description: "New ISO 8601 start." },
        end: { type: "string", description: "New ISO 8601 end." },
        location: { type: "string" },
        notes: { type: "string" },
      },
      required: ["uid", "calendar"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_delete_event",
    description: "Delete an event from the user's calendar. This is not easily undone, so confirm with the user before calling it unless they explicitly asked to delete that specific event. Find the uid with calendar_list_events first.",
    input_schema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "Event uid from calendar_list_events." },
        calendar: { type: "string", description: "Name of the calendar the event is in." },
      },
      required: ["uid", "calendar"],
      additionalProperties: false,
    },
  },
];

const NOTION_APP_TOOLS: ToolDefinition[] = [
  {
    name: "calendar_status",
    description: `Check how calendar access is set up: whether the macOS Calendar app can be scripted, or whether the ${APP_NAME} app is running for keystroke fallback. Call this first if a calendar tool fails, and relay the setup guidance it returns.`,
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
async function status(): Promise<Record<string, unknown>> {
  const app = await calendarAppStatus();
  const base = { notion_calendar_app: app, default_backend: SYSTEM_CALENDAR ? "system-calendar" : "notion-app-keystrokes" };
  if (!SYSTEM_CALENDAR) return { ...base, system_calendar: { available: false, reason: process.platform === "darwin" ? "Disabled in settings." : "Only macOS exposes a scriptable system calendar." } };
  try {
    const calendars = await mac.listCalendars();
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
        return ok(await mac.listCalendars());

      case "calendar_list_events": {
        const events = await mac.listEvents(String(input.from ?? ""), String(input.to ?? ""), input.calendar ? String(input.calendar) : undefined);
        if (!events.length) return ok("No events in that range.");
        return ok(events);
      }

      case "calendar_create_event": {
        const created = await mac.createEvent({
          title: String(input.title ?? ""),
          start: String(input.start ?? ""),
          end: input.end ? String(input.end) : undefined,
          allDay: Boolean(input.all_day),
          calendar: input.calendar ? String(input.calendar) : undefined,
          location: input.location ? String(input.location) : undefined,
          notes: input.notes ? String(input.notes) : undefined,
        });
        return ok({ created: true, ...created, note: `Added to "${created.calendar}". It syncs to the account and will appear in ${APP_NAME} shortly.` });
      }

      case "calendar_set_default_calendar": {
        const chosen = await mac.setDefaultCalendar(String(input.calendar ?? ""));
        return ok({ default_calendar: chosen, note: `New events go to "${chosen}" unless the user names another calendar.` });
      }

      case "calendar_move_event": {
        const moved = await mac.moveEvent(String(input.uid ?? ""), String(input.from_calendar ?? ""), String(input.to_calendar ?? ""));
        return ok({ moved: true, ...moved, note: "The event was recreated in the target calendar, so its uid changed." });
      }

      case "calendar_update_event": {
        await mac.updateEvent({
          uid: String(input.uid ?? ""),
          calendar: String(input.calendar ?? ""),
          title: input.title === undefined ? undefined : String(input.title),
          start: input.start ? String(input.start) : undefined,
          end: input.end ? String(input.end) : undefined,
          location: input.location === undefined ? undefined : String(input.location),
          notes: input.notes === undefined ? undefined : String(input.notes),
        });
        return ok({ updated: true, uid: input.uid });
      }

      case "calendar_delete_event": {
        await mac.deleteEvent(String(input.uid ?? ""), String(input.calendar ?? ""));
        return ok({ deleted: true, uid: input.uid });
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
    ? `Tools for the user's real calendar (their Google, iCloud or Outlook account) through the macOS Calendar app, which syncs to the account and shows up in ${APP_NAME}. Reading, creating, updating and deleting all work. If a tool reports a permission or setup problem, relay its instructions to the user instead of retrying.`
    : `Tools that control the ${APP_NAME} desktop app by keystrokes, which is the only option on this platform. The app must be open. Creating an event cannot be read back, so ask the user to confirm the result.`,
  tools: CALENDAR_TOOLS,
  execute,
});

if (process.env.NOTION_ORACLE_MCP_TEST !== "1") server.serve();
