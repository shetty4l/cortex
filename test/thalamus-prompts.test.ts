import { describe, expect, test } from "bun:test";
import {
  buildTriageUserPrompt,
  parseSyncOutput,
  THALAMUS_TRIAGE_SYSTEM_PROMPT,
} from "../src/thalamus/prompts";

describe("THALAMUS_TRIAGE_SYSTEM_PROMPT", () => {
  test("is a non-empty string", () => {
    expect(typeof THALAMUS_TRIAGE_SYSTEM_PROMPT).toBe("string");
    expect(THALAMUS_TRIAGE_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  test("mentions JSON output format", () => {
    expect(THALAMUS_TRIAGE_SYSTEM_PROMPT).toContain("JSON");
  });

  test("mentions priority scale", () => {
    expect(THALAMUS_TRIAGE_SYSTEM_PROMPT).toContain("0 =");
    expect(THALAMUS_TRIAGE_SYSTEM_PROMPT).toContain("5 =");
  });
});

describe("buildTriageUserPrompt", () => {
  test("formats buffers grouped by channel", () => {
    const result = buildTriageUserPrompt(
      [
        {
          channel: "calendar",
          items: [
            {
              id: "rb_1",
              content: "Meeting with Bob",
              occurredAt: 1708000000000,
            },
            {
              id: "rb_2",
              content: "Dentist appointment",
              occurredAt: 1708100000000,
            },
          ],
        },
        {
          channel: "email",
          items: [
            {
              id: "rb_3",
              content: "Invoice from Amazon",
              occurredAt: 1708200000000,
            },
          ],
        },
      ],
      [],
    );

    expect(result).toContain("### Channel: calendar");
    expect(result).toContain("### Channel: email");
    expect(result).toContain("[rb_1]");
    expect(result).toContain("Meeting with Bob");
    expect(result).toContain("[rb_2]");
    expect(result).toContain("Dentist appointment");
    expect(result).toContain("[rb_3]");
    expect(result).toContain("Invoice from Amazon");
  });

  test("includes existing topics", () => {
    const result = buildTriageUserPrompt(
      [
        {
          channel: "calendar",
          items: [{ id: "rb_1", content: "Event", occurredAt: 1708000000000 }],
        },
      ],
      [
        { key: "japan-trip", name: "Japan Trip", status: "active" },
        { key: "work-project", name: "Work Project", status: "completed" },
      ],
    );

    expect(result).toContain("## Existing Topics");
    expect(result).toContain("japan-trip: Japan Trip (active)");
    expect(result).toContain("work-project: Work Project (completed)");
  });

  test("shows (none) when no existing topics", () => {
    const result = buildTriageUserPrompt(
      [
        {
          channel: "calendar",
          items: [{ id: "rb_1", content: "Event", occurredAt: 1708000000000 }],
        },
      ],
      [],
    );

    expect(result).toContain("(none)");
  });

  test("includes instructions section", () => {
    const result = buildTriageUserPrompt(
      [
        {
          channel: "calendar",
          items: [{ id: "rb_1", content: "Event", occurredAt: 1708000000000 }],
        },
      ],
      [],
    );

    expect(result).toContain("## Instructions");
    expect(result).toContain("Analyze the buffered data above");
  });

  test("includes ISO date for each buffer item", () => {
    const ts = 1708000000000;
    const result = buildTriageUserPrompt(
      [
        {
          channel: "calendar",
          items: [{ id: "rb_1", content: "Event", occurredAt: ts }],
        },
      ],
      [],
    );

    const expected = new Date(ts).toISOString();
    expect(result).toContain(expected);
  });
});

describe("parseSyncOutput", () => {
  test("parses valid JSON", () => {
    const input = JSON.stringify({
      items: [
        {
          topicKey: "japan-trip",
          topicName: "Japan Trip",
          priority: 2,
          summary: "3 upcoming events for Japan trip",
          rawBufferIds: ["rb_1", "rb_2"],
        },
      ],
    });

    const result = parseSyncOutput(input);
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].topicKey).toBe("japan-trip");
    expect(result.items[0].topicName).toBe("Japan Trip");
    expect(result.items[0].priority).toBe(2);
    expect(result.items[0].summary).toBe("3 upcoming events for Japan trip");
    expect(result.items[0].rawBufferIds).toEqual(["rb_1", "rb_2"]);
  });

  test("handles markdown code fences", () => {
    const input = `\`\`\`json
{
  "items": [
    {
      "topicKey": "work",
      "topicName": "Work",
      "priority": 1,
      "summary": "Deadline today",
      "rawBufferIds": ["rb_3"]
    }
  ]
}
\`\`\``;

    const result = parseSyncOutput(input);
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].topicKey).toBe("work");
    expect(result.items[0].topicName).toBe("Work");
  });

  test("handles code fences without language tag", () => {
    const input = `\`\`\`
{"items":[{"topicKey":"t","topicName":"T","priority":0,"summary":"s","rawBufferIds":["rb_1"]}]}
\`\`\``;

    const result = parseSyncOutput(input);
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
  });

  test("returns ok=false on invalid JSON", () => {
    const result = parseSyncOutput("this is not json at all");
    expect(result.ok).toBe(false);
    expect(result.items).toEqual([]);
  });

  test("returns ok=false when items is missing", () => {
    const result = parseSyncOutput('{"data": []}');
    expect(result.ok).toBe(false);
    expect(result.items).toEqual([]);
  });

  test("returns ok=false when items is not an array", () => {
    const result = parseSyncOutput('{"items": "not-array"}');
    expect(result.ok).toBe(false);
    expect(result.items).toEqual([]);
  });

  test("validates item structure — skips invalid items", () => {
    const input = JSON.stringify({
      items: [
        {
          topicKey: "valid",
          topicName: "Valid",
          priority: 1,
          summary: "OK",
          rawBufferIds: ["rb_1"],
        },
        {
          topicKey: "missing-priority",
          topicName: "Missing",
          summary: "Bad",
          rawBufferIds: [],
        },
        {
          priority: 1,
          topicName: "Missing Key",
          summary: "Missing topic",
          rawBufferIds: [],
        },
        {
          topicKey: "missing-name",
          priority: 1,
          summary: "Missing name",
          rawBufferIds: [],
        },
        "not-an-object",
      ],
    });

    const result = parseSyncOutput(input);
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].topicKey).toBe("valid");
  });

  test("returns ok=true with empty items array from valid empty response", () => {
    const result = parseSyncOutput('{"items":[]}');
    expect(result.ok).toBe(true);
    expect(result.items).toEqual([]);
  });

  test("parses multiple items", () => {
    const input = JSON.stringify({
      items: [
        {
          topicKey: "a",
          topicName: "A",
          priority: 0,
          summary: "First",
          rawBufferIds: ["rb_1"],
        },
        {
          topicKey: "b",
          topicName: "B",
          priority: 3,
          summary: "Second",
          rawBufferIds: ["rb_2", "rb_3"],
        },
      ],
    });

    const result = parseSyncOutput(input);
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].topicKey).toBe("a");
    expect(result.items[0].topicName).toBe("A");
    expect(result.items[1].topicKey).toBe("b");
    expect(result.items[1].topicName).toBe("B");
  });
});
