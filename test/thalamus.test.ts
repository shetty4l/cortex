import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDatabase, initDatabase } from "../src/db";
import { type ReceivePayload, Thalamus } from "../src/thalamus";

function makePayload(overrides?: Partial<ReceivePayload>): ReceivePayload {
  return {
    channel: "telegram",
    externalId: `ext-${crypto.randomUUID()}`,
    data: { text: "Hello world", topicKey: "my-topic", userId: "user-1" },
    occurredAt: "2026-02-15T20:30:00Z",
    ...overrides,
  };
}

describe("thalamus.receive()", () => {
  let thalamus: Thalamus;

  beforeEach(() => {
    initDatabase(":memory:");
    thalamus = new Thalamus();
  });

  afterEach(() => {
    closeDatabase();
  });

  // --- Priority tests ---

  test("assigns priority 0 for telegram channel", () => {
    const result = thalamus.receive(makePayload({ channel: "telegram" }));
    expect(result.duplicate).toBe(false);

    const db = getDatabase();
    const row = db
      .prepare("SELECT priority FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { priority: number };
    expect(row.priority).toBe(0);
  });

  test("assigns priority 0 for cli channel", () => {
    const result = thalamus.receive(makePayload({ channel: "cli" }));

    const db = getDatabase();
    const row = db
      .prepare("SELECT priority FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { priority: number };
    expect(row.priority).toBe(0);
  });

  test("assigns priority 2 for calendar channel", () => {
    const result = thalamus.receive(makePayload({ channel: "calendar" }));

    const db = getDatabase();
    const row = db
      .prepare("SELECT priority FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { priority: number };
    expect(row.priority).toBe(2);
  });

  test("assigns priority 3 for email channel", () => {
    const result = thalamus.receive(makePayload({ channel: "email" }));

    const db = getDatabase();
    const row = db
      .prepare("SELECT priority FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { priority: number };
    expect(row.priority).toBe(3);
  });

  test("assigns default priority 5 for unknown channel", () => {
    const result = thalamus.receive(makePayload({ channel: "unknown" }));

    const db = getDatabase();
    const row = db
      .prepare("SELECT priority FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { priority: number };
    expect(row.priority).toBe(5);
  });

  // --- Formatting tests ---

  test("uses formatChannelData to format data into text (cli)", () => {
    const result = thalamus.receive(
      makePayload({ channel: "cli", data: { text: "user input" } }),
    );

    const db = getDatabase();
    const row = db
      .prepare("SELECT text FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { text: string };
    expect(row.text).toBe("user input");
  });

  test("uses formatChannelData to format data into text (telegram)", () => {
    const result = thalamus.receive(
      makePayload({ channel: "telegram", data: { text: "telegram message" } }),
    );

    const db = getDatabase();
    const row = db
      .prepare("SELECT text FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { text: string };
    expect(row.text).toBe("telegram message");
  });

  test("uses formatChannelData for calendar with events", () => {
    const result = thalamus.receive(
      makePayload({
        channel: "calendar",
        data: {
          events: [{ startDate: "2026-03-01", title: "Meeting" }],
          windowDays: 7,
        },
      }),
    );

    const db = getDatabase();
    const row = db
      .prepare("SELECT text FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { text: string };
    expect(row.text).toContain("Calendar sync");
    expect(row.text).toContain("Meeting");
  });

  test("uses formatDefault (JSON.stringify) for unknown channel", () => {
    const data = { custom: "field", value: 42 };
    const result = thalamus.receive(makePayload({ channel: "unknown", data }));

    const db = getDatabase();
    const row = db
      .prepare("SELECT text FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { text: string };
    expect(row.text).toBe(JSON.stringify(data, null, 2));
  });

  // --- topicKey extraction ---

  test("extracts topicKey from data when present", () => {
    const result = thalamus.receive(
      makePayload({ data: { text: "msg", topicKey: "custom-topic" } }),
    );

    const db = getDatabase();
    const row = db
      .prepare("SELECT topic_key FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { topic_key: string };
    expect(row.topic_key).toBe("custom-topic");
  });

  test("uses channel name as topicKey when not in data", () => {
    const result = thalamus.receive(
      makePayload({ channel: "telegram", data: { text: "no topic key" } }),
    );

    const db = getDatabase();
    const row = db
      .prepare("SELECT topic_key FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { topic_key: string };
    expect(row.topic_key).toBe("telegram");
  });

  // --- userId extraction ---

  test("extracts userId from data when present", () => {
    const result = thalamus.receive(
      makePayload({ data: { text: "msg", userId: "custom-user" } }),
    );

    const db = getDatabase();
    const row = db
      .prepare("SELECT user_id FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { user_id: string };
    expect(row.user_id).toBe("custom-user");
  });

  test("uses 'system' as userId when not in data", () => {
    const result = thalamus.receive(
      makePayload({ data: { text: "no user id" } }),
    );

    const db = getDatabase();
    const row = db
      .prepare("SELECT user_id FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { user_id: string };
    expect(row.user_id).toBe("system");
  });

  // --- Dedup ---

  test("handles duplicate gracefully (returns duplicate: true)", () => {
    const payload = makePayload();

    const first = thalamus.receive(payload);
    expect(first.duplicate).toBe(false);
    expect(first.eventId).toMatch(/^evt_/);

    const second = thalamus.receive(payload);
    expect(second.duplicate).toBe(true);
    expect(second.eventId).toBe(first.eventId);
  });

  // --- Idempotency key format ---

  test("generates idempotencyKey as channel:externalId", () => {
    const payload = makePayload({ channel: "cli", externalId: "my-ext-id" });
    const result = thalamus.receive(payload);

    const db = getDatabase();
    const row = db
      .prepare("SELECT idempotency_key FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { idempotency_key: string };
    expect(row.idempotency_key).toBe("cli:my-ext-id");
  });
});
