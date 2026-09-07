/** Tool names exposed by calendar-server.ts, kept importable without loading the server itself. */
const SYSTEM = ["calendar_list_calendars", "calendar_list_events", "calendar_create_event", "calendar_update_event", "calendar_delete_event"] as const;
const NOTION_APP = ["calendar_status", "calendar_open", "calendar_open_date", "calendar_create_event_by_keystrokes"] as const;

/** The allow-list must cover every tool the server may expose on any platform. */
export const CALENDAR_TOOL_NAMES: readonly string[] = [...SYSTEM, ...NOTION_APP];
