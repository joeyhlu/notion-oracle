/**
 * MCP server exposing Notion Calendar app control. Separate from the Notion server so the
 * tool names make the boundary obvious to the model: notion__* reads and writes the workspace
 * through the API; calendar__* drives the Notion Calendar desktop app with keystrokes.
 */

import type { ToolDefinition, ToolExecutor } from "../../../extension/src/lib/providers/types.ts";
import { APP_NAME, activateCalendarApp, calendarAppStatus, createCalendarEvent, openCalendarDate, parseWhen, type Strategy } from "./calendar-app.ts";
import { CALENDAR_TOOL_NAMES } from "./calendar-tools.ts";
import { StdioMcpServer } from "./stdio-server.ts";

const DEFAULT_STRATEGY: Strategy = process.env.CALENDAR_STRATEGY === "command-bar" ? "command-bar" : "new-event-key";
const AUTO_SAVE = process.env.CALENDAR_AUTO_SAVE === "1";

export const CALENDAR_TOOLS: ToolDefinition[] = [
  {
    name: "calendar_status",
    description: `Check whether the ${APP_NAME} desktop app is running and can be controlled. Call this before any other calendar tool; if it is not running, ask the user to open it rather than retrying.`,
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
    name: "calendar_create_event",
    description:
      `Create an event in the user's real calendar (Google, iCloud or Outlook) by operating the ${APP_NAME} app: it brings the app to the front, jumps to the day, opens a new event and types the title. ` +
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

for (const name of CALENDAR_TOOL_NAMES) {
  if (!CALENDAR_TOOLS.some((t) => t.name === name)) throw new Error(`calendar-tools.ts lists ${name} but calendar-server.ts does not define it`);
}

const ok = (content: unknown) => ({ ok: true, content: typeof content === "string" ? content : JSON.stringify(content, null, 2) });
const fail = (message: string) => ({ ok: false, content: message });

export const execute: ToolExecutor = async (name, input) => {
  try {
    switch (name) {
      case "calendar_status":
        return ok({ ...(await calendarAppStatus()), default_strategy: DEFAULT_STRATEGY, auto_save: AUTO_SAVE });
      case "calendar_open":
        await activateCalendarApp();
        return ok(`${APP_NAME} is now in front.`);
      case "calendar_open_date": {
        const { start } = parseWhen({ title: "-", start: String(input.date ?? "") });
        await openCalendarDate(start);
        return ok(`${APP_NAME} is showing ${start.toDateString()}.`);
      }
      case "calendar_create_event": {
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
  instructions: `Tools that control the ${APP_NAME} desktop app, which shows the user's Google, iCloud or Outlook calendars. The app must be open. Use calendar_status first. Creating an event is keystroke automation: report the steps taken and ask the user to confirm the result.`,
  tools: CALENDAR_TOOLS,
  execute,
});

if (process.env.NOTION_ORACLE_MCP_TEST !== "1") server.serve();
