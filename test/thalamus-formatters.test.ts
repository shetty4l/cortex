import { describe, expect, test } from "bun:test";
import {
  formatCalendar,
  formatChannelData,
  formatCli,
  formatDefault,
  formatTelegram,
} from "../src/thalamus/formatters";

describe("formatCli", () => {
  test("extracts data.text when present", () => {
    expect(formatCli({ text: "hello" })).toBe("hello");
  });

  test("falls back to JSON.stringify when no text", () => {
    expect(formatCli({ foo: "bar" })).toBe(JSON.stringify({ foo: "bar" }));
  });

  test("falls back to JSON.stringify when text is not a string", () => {
    expect(formatCli({ text: 42 })).toBe(JSON.stringify({ text: 42 }));
  });

  test("handles null data", () => {
    expect(formatCli(null)).toBe("null");
  });

  test("handles primitive data", () => {
    expect(formatCli("raw string")).toBe(JSON.stringify("raw string"));
  });
});

describe("formatTelegram", () => {
  test("extracts data.text when present", () => {
    expect(formatTelegram({ text: "telegram message" })).toBe(
      "telegram message",
    );
  });

  test("falls back to JSON.stringify when no text", () => {
    const data = { chatId: 42 };
    expect(formatTelegram(data)).toBe(JSON.stringify(data));
  });

  test("falls back to JSON.stringify when text is not a string", () => {
    expect(formatTelegram({ text: true })).toBe(JSON.stringify({ text: true }));
  });
});

describe("formatCalendar", () => {
  test("renders events as dated list", () => {
    const data = {
      events: [
        {
          startDate: "2026-03-01",
          title: "Team standup",
          location: "Room A",
          calendarName: "Work",
        },
        {
          startDate: "2026-03-02",
          title: "Lunch",
          calendarName: "Personal",
        },
      ],
      windowDays: 7,
    };

    const result = formatCalendar(data);
    expect(result).toContain("Calendar sync (2 events, 7-day window):");
    expect(result).toContain("- 2026-03-01: Team standup (Room A) [Work]");
    expect(result).toContain("- 2026-03-02: Lunch [Personal]");
  });

  test("handles empty events array", () => {
    const data = { events: [], windowDays: 7 };
    const result = formatCalendar(data);
    expect(result).toContain("Calendar sync (0 events, 7-day window):");
    // Should be just the header + blank line, no event lines
    const lines = result.split("\n");
    expect(lines).toHaveLength(2); // header + blank line
  });

  test("falls back to JSON.stringify when no events field", () => {
    const data = { summary: "no events here" };
    expect(formatCalendar(data)).toBe(JSON.stringify(data));
  });

  test("falls back to JSON.stringify when events is not an array", () => {
    const data = { events: "not-an-array" };
    expect(formatCalendar(data)).toBe(JSON.stringify(data));
  });

  test("falls back to JSON.stringify for null data", () => {
    expect(formatCalendar(null)).toBe("null");
  });

  test("uses ? for missing windowDays", () => {
    const data = { events: [{ startDate: "2026-03-01", title: "Event" }] };
    const result = formatCalendar(data);
    expect(result).toContain("?-day window");
  });

  test("handles events with missing fields", () => {
    const data = { events: [{}], windowDays: 1 };
    const result = formatCalendar(data);
    expect(result).toContain("- unknown date: untitled");
  });
});

describe("formatDefault", () => {
  test("returns JSON.stringify with indentation", () => {
    const data = { key: "value", nested: { a: 1 } };
    expect(formatDefault(data)).toBe(JSON.stringify(data, null, 2));
  });

  test("handles primitive values", () => {
    expect(formatDefault("hello")).toBe('"hello"');
    expect(formatDefault(42)).toBe("42");
    expect(formatDefault(null)).toBe("null");
  });
});

describe("formatChannelData", () => {
  test("dispatches to formatCli for cli channel", () => {
    expect(formatChannelData("cli", { text: "cli msg" })).toBe("cli msg");
  });

  test("dispatches to formatTelegram for telegram channel", () => {
    expect(formatChannelData("telegram", { text: "tg msg" })).toBe("tg msg");
  });

  test("dispatches to formatCalendar for calendar channel", () => {
    const data = {
      events: [{ startDate: "2026-03-01", title: "Meeting" }],
      windowDays: 7,
    };
    const result = formatChannelData("calendar", data);
    expect(result).toContain("Calendar sync");
  });

  test("dispatches to formatDefault for unknown channel", () => {
    const data = { custom: "data" };
    expect(formatChannelData("unknown", data)).toBe(
      JSON.stringify(data, null, 2),
    );
  });

  test("dispatches to formatDefault for email channel (no custom formatter)", () => {
    const data = { subject: "Hello" };
    expect(formatChannelData("email", data)).toBe(
      JSON.stringify(data, null, 2),
    );
  });
});
