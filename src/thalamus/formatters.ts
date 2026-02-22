/**
 * Per-channel data formatters for thalamus.receive().
 *
 * All formatters are pure functions — no side effects, no LLM calls, no DB access.
 * Each formatter converts raw channel data into a text representation
 * suitable for the inbox.
 */

// --- Individual formatters ---

/**
 * CLI formatter: extracts data.text if present and is a string,
 * otherwise falls back to JSON.stringify.
 */
export function formatCli(data: unknown): string {
  if (
    data !== null &&
    typeof data === "object" &&
    "text" in (data as Record<string, unknown>)
  ) {
    const text = (data as Record<string, unknown>).text;
    if (typeof text === "string") return text;
  }
  return JSON.stringify(data);
}

/**
 * Telegram formatter: extracts data.text if present and is a string,
 * otherwise falls back to JSON.stringify.
 */
export function formatTelegram(data: unknown): string {
  if (
    data !== null &&
    typeof data === "object" &&
    "text" in (data as Record<string, unknown>)
  ) {
    const text = (data as Record<string, unknown>).text;
    if (typeof text === "string") return text;
  }
  return JSON.stringify(data);
}

interface CalendarEvent {
  startDate?: string;
  title?: string;
  location?: string;
  calendarName?: string;
}

/**
 * Calendar formatter: renders a dated event list.
 *
 * Expects data.events as an array. Falls back to JSON.stringify
 * if data doesn't have events or events is not an array.
 *
 * Output format:
 *   Calendar sync (<N> events, <windowDays>-day window):
 *
 *   - <startDate>: <title> (<location>) [<calendarName>]
 *   - <startDate>: <title> [<calendarName>]
 *   ...
 */
export function formatCalendar(data: unknown): string {
  if (data === null || typeof data !== "object") {
    return JSON.stringify(data);
  }

  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.events)) {
    return JSON.stringify(data);
  }

  const events = obj.events as CalendarEvent[];
  const windowDays = typeof obj.windowDays === "number" ? obj.windowDays : "?";
  const lines: string[] = [
    `Calendar sync (${events.length} events, ${windowDays}-day window):`,
    "",
  ];

  for (const event of events) {
    const date = event.startDate ?? "unknown date";
    const title = event.title ?? "untitled";
    const location = event.location ? ` (${event.location})` : "";
    const calendar = event.calendarName ? ` [${event.calendarName}]` : "";
    lines.push(`- ${date}: ${title}${location}${calendar}`);
  }

  return lines.join("\n");
}

/**
 * Default formatter: pretty-printed JSON.
 */
export function formatDefault(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

// --- Dispatcher ---

const FORMATTERS: Record<string, (data: unknown) => string> = {
  cli: formatCli,
  telegram: formatTelegram,
  calendar: formatCalendar,
};

/**
 * Dispatch to the correct per-channel formatter.
 * Falls back to formatDefault for unknown channels.
 */
export function formatChannelData(channel: string, data: unknown): string {
  const formatter = FORMATTERS[channel];
  return formatter ? formatter(data) : formatDefault(data);
}
