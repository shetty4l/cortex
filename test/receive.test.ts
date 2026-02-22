import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { CortexConfig } from "../src/config";
import { closeDatabase, getDatabase, initDatabase } from "../src/db";
import { startServer } from "../src/server";
import { Thalamus } from "../src/thalamus";

const API_KEY = "test-receive-key";

function makeConfig(): CortexConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    ingestApiKey: API_KEY,
    model: "test-model",
    synapseUrl: "http://localhost:7750",
    engramUrl: "http://localhost:7749",
    activeWindowSize: 10,
    extractionInterval: 3,
    turnTtlDays: 30,
    schedulerTickSeconds: 30,
    schedulerTimezone: "UTC",
    outboxPollDefaultBatch: 20,
    outboxLeaseSeconds: 60,
    outboxMaxAttempts: 10,
    skillDirs: [],
    skillConfig: {},
    toolTimeoutMs: 20000,
    maxToolRounds: 8,
    synapseTimeoutMs: 60_000,
  };
}

function validPayload(overrides?: Record<string, unknown>) {
  return {
    channel: "telegram",
    externalId: `ext-${crypto.randomUUID()}`,
    data: {
      text: "Hello, world",
      topicKey: "chat-42:thread-root",
      userId: "tg:998877",
    },
    occurredAt: "2026-02-15T20:30:00Z",
    ...overrides,
  };
}

describe("POST /receive", () => {
  let server: { port: number; stop: () => void };
  let baseUrl: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    savedEnv.CORTEX_CONFIG_PATH = process.env.CORTEX_CONFIG_PATH;
    process.env.CORTEX_CONFIG_PATH = "/nonexistent/config.json";
    initDatabase(":memory:");
    const thalamus = new Thalamus();
    server = startServer(makeConfig(), thalamus);
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop();
    closeDatabase();
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  function post(body: unknown, token?: string) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token !== undefined) {
      headers.Authorization = `Bearer ${token}`;
    }
    return fetch(`${baseUrl}/receive`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  // --- Auth tests ---

  test("returns 401 when no auth header", async () => {
    const response = await post(validPayload());

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  test("returns 401 when wrong auth token", async () => {
    const response = await post(validPayload(), "wrong-key");

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  // --- Validation tests ---

  test("returns 400 when required field channel is missing", async () => {
    const payload = validPayload();
    delete (payload as Record<string, unknown>).channel;
    const response = await post(payload, API_KEY);

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: string[];
    };
    expect(body.error).toBe("invalid_request");
    expect(body.details.some((d: string) => d.includes("channel"))).toBe(true);
  });

  test("returns 400 when required field externalId is missing", async () => {
    const payload = validPayload();
    delete (payload as Record<string, unknown>).externalId;
    const response = await post(payload, API_KEY);

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: string[];
    };
    expect(body.details.some((d: string) => d.includes("externalId"))).toBe(
      true,
    );
  });

  test("returns 400 when required field data is missing", async () => {
    const payload = validPayload();
    delete (payload as Record<string, unknown>).data;
    const response = await post(payload, API_KEY);

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: string[];
    };
    expect(body.details.some((d: string) => d.includes("data"))).toBe(true);
  });

  test("returns 400 when required field occurredAt is missing", async () => {
    const payload = validPayload();
    delete (payload as Record<string, unknown>).occurredAt;
    const response = await post(payload, API_KEY);

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: string[];
    };
    expect(body.details.some((d: string) => d.includes("occurredAt"))).toBe(
      true,
    );
  });

  test("returns 400 when occurredAt is not valid ISO 8601", async () => {
    const response = await post(
      validPayload({ occurredAt: "not-a-date" }),
      API_KEY,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: string[];
    };
    expect(body.details.some((d: string) => d.includes("occurredAt"))).toBe(
      true,
    );
  });

  test("returns 400 for non-JSON request body", async () => {
    const response = await fetch(`${baseUrl}/receive`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: "not json{{",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: string[];
    };
    expect(body.details[0]).toBe("Request body must be valid JSON");
  });

  test("returns 400 for JSON array body", async () => {
    const response = await post([1, 2, 3], API_KEY);

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: string[];
    };
    expect(body.details[0]).toBe("Request body must be a JSON object");
  });

  // --- Success tests ---

  test("returns 202 with eventId and status queued on valid payload", async () => {
    const response = await post(validPayload(), API_KEY);

    expect(response.status).toBe(202);
    const body = (await response.json()) as { eventId: string; status: string };
    expect(body.status).toBe("queued");
    expect(body.eventId).toMatch(/^evt_/);
  });

  test("returns 200 with status duplicate_ignored when same channel+externalId sent twice", async () => {
    const payload = validPayload();

    const first = await post(payload, API_KEY);
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { eventId: string };

    const second = await post(payload, API_KEY);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      eventId: string;
      status: string;
    };
    expect(secondBody.status).toBe("duplicate_ignored");
    expect(secondBody.eventId).toBe(firstBody.eventId);
  });

  // --- Priority tests ---

  test("correctly sets priority for telegram channel (priority=0)", async () => {
    const payload = validPayload({ channel: "telegram" });
    const response = await post(payload, API_KEY);
    expect(response.status).toBe(202);

    const { eventId } = (await response.json()) as { eventId: string };
    const db = getDatabase();
    const row = db
      .prepare("SELECT priority FROM inbox_messages WHERE id = $id")
      .get({ $id: eventId }) as { priority: number };
    expect(row.priority).toBe(0);
  });

  test("correctly sets priority for calendar channel (priority=2)", async () => {
    const payload = validPayload({ channel: "calendar" });
    const response = await post(payload, API_KEY);
    expect(response.status).toBe(202);

    const { eventId } = (await response.json()) as { eventId: string };
    const db = getDatabase();
    const row = db
      .prepare("SELECT priority FROM inbox_messages WHERE id = $id")
      .get({ $id: eventId }) as { priority: number };
    expect(row.priority).toBe(2);
  });

  test("correctly sets default priority for unknown channel (priority=5)", async () => {
    const payload = validPayload({ channel: "unknown-channel" });
    const response = await post(payload, API_KEY);
    expect(response.status).toBe(202);

    const { eventId } = (await response.json()) as { eventId: string };
    const db = getDatabase();
    const row = db
      .prepare("SELECT priority FROM inbox_messages WHERE id = $id")
      .get({ $id: eventId }) as { priority: number };
    expect(row.priority).toBe(5);
  });

  // --- Persistence tests ---

  test("persists message to database with correct fields", async () => {
    const payload = validPayload();
    const response = await post(payload, API_KEY);
    const { eventId } = (await response.json()) as { eventId: string };

    const db = getDatabase();
    const row = db
      .prepare("SELECT * FROM inbox_messages WHERE id = $id")
      .get({ $id: eventId }) as Record<string, unknown>;

    expect(row).not.toBeNull();
    expect(row.channel).toBe(payload.channel);
    expect(row.status).toBe("pending");
    expect(typeof row.occurred_at).toBe("number");
    expect(typeof row.created_at).toBe("number");
  });

  test("stores optional metadata", async () => {
    const payload = validPayload({
      metadata: { chatId: "-100123", threadId: "9" },
    });
    const response = await post(payload, API_KEY);
    const { eventId } = (await response.json()) as { eventId: string };

    const db = getDatabase();
    const row = db
      .prepare("SELECT metadata_json FROM inbox_messages WHERE id = $id")
      .get({ $id: eventId }) as { metadata_json: string };

    const parsed = JSON.parse(row.metadata_json);
    expect(parsed.chatId).toBe("-100123");
    expect(parsed.threadId).toBe("9");
  });

  test("different channel with same externalId creates separate rows", async () => {
    const sharedExtId = `ext-${crypto.randomUUID()}`;

    const resp1 = await post(
      validPayload({ channel: "telegram", externalId: sharedExtId }),
      API_KEY,
    );
    const resp2 = await post(
      validPayload({ channel: "slack", externalId: sharedExtId }),
      API_KEY,
    );

    expect(resp1.status).toBe(202);
    expect(resp2.status).toBe(202);

    const body1 = (await resp1.json()) as { eventId: string };
    const body2 = (await resp2.json()) as { eventId: string };
    expect(body1.eventId).not.toBe(body2.eventId);
  });

  // --- Mode tests ---

  test("POST /receive with mode=buffered returns 202 with eventId", async () => {
    const payload = validPayload({ mode: "buffered", channel: "calendar" });
    const response = await post(payload, API_KEY);

    expect(response.status).toBe(202);
    const body = (await response.json()) as { eventId: string; status: string };
    expect(body.status).toBe("queued");
    expect(body.eventId).toMatch(/^rb_/);
  });

  test("POST /receive without mode still works (backward compat)", async () => {
    const payload = validPayload();
    // Ensure no mode field
    delete (payload as Record<string, unknown>).mode;
    const response = await post(payload, API_KEY);

    expect(response.status).toBe(202);
    const body = (await response.json()) as { eventId: string; status: string };
    expect(body.status).toBe("queued");
    expect(body.eventId).toMatch(/^evt_/);
  });
});
