import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { loadConfig } from "../src/config";
import { closeDatabase, getDatabase, initDatabase } from "../src/db";
import { createServer } from "../src/server";

const API_KEY = "test-ingest-key";

function validEvent(overrides?: Record<string, unknown>) {
  return {
    source: "telegram",
    externalMessageId: `msg-${crypto.randomUUID()}`,
    idempotencyKey: `tg:${crypto.randomUUID()}`,
    topicKey: "chat-42:thread-root",
    userId: "tg:998877",
    text: "Hello, world",
    occurredAt: "2026-02-15T20:30:00Z",
    ...overrides,
  };
}

describe("POST /ingest", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    savedEnv.CORTEX_CONFIG_PATH = process.env.CORTEX_CONFIG_PATH;
    savedEnv.CORTEX_INGEST_API_KEY = process.env.CORTEX_INGEST_API_KEY;
    process.env.CORTEX_CONFIG_PATH = "/nonexistent/config.json";
    process.env.CORTEX_INGEST_API_KEY = API_KEY;
    initDatabase({ path: ":memory:", force: true });
    const config = loadConfig({ quiet: true });
    const cortexServer = createServer({ ...config, port: 0 });
    server = cortexServer.start();
    baseUrl = `http://${server.hostname}:${server.port}`;
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
    return fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  test("returns 202 for valid new event", async () => {
    const response = await post(validEvent(), API_KEY);

    expect(response.status).toBe(202);

    const body = (await response.json()) as {
      eventId: string;
      status: string;
    };
    expect(body.status).toBe("queued");
    expect(body.eventId).toMatch(/^evt_/);
  });

  test("returns 200 for duplicate event", async () => {
    const event = validEvent();

    const first = await post(event, API_KEY);
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { eventId: string };

    const second = await post(event, API_KEY);
    expect(second.status).toBe(200);

    const secondBody = (await second.json()) as {
      eventId: string;
      status: string;
    };
    expect(secondBody.status).toBe("duplicate_ignored");
    expect(secondBody.eventId).toBe(firstBody.eventId);
  });

  test("returns 401 without auth header", async () => {
    const response = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validEvent()),
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  test("returns 401 with wrong token", async () => {
    const response = await post(validEvent(), "wrong-key");

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  test("returns 400 for missing required fields", async () => {
    const response = await post({ text: "hello" }, API_KEY);

    expect(response.status).toBe(400);

    const body = (await response.json()) as {
      error: string;
      details: string[];
    };
    expect(body.error).toBe("invalid_request");
    expect(body.details.length).toBeGreaterThan(0);
    expect(body.details.some((d: string) => d.includes("source"))).toBe(true);
  });

  test("returns 400 for empty required fields", async () => {
    const response = await post(validEvent({ text: "" }), API_KEY);

    expect(response.status).toBe(400);

    const body = (await response.json()) as {
      error: string;
      details: string[];
    };
    expect(body.details.some((d: string) => d.includes("text"))).toBe(true);
  });

  test("persists message to database", async () => {
    const event = validEvent();
    const response = await post(event, API_KEY);
    const { eventId } = (await response.json()) as { eventId: string };

    const db = getDatabase();
    const row = db
      .prepare("SELECT * FROM inbox_messages WHERE id = $id")
      .get({ $id: eventId }) as Record<string, unknown>;

    expect(row).not.toBeNull();
    expect(row.source).toBe(event.source);
    expect(row.external_message_id).toBe(event.externalMessageId);
    expect(row.topic_key).toBe(event.topicKey);
    expect(row.user_id).toBe(event.userId);
    expect(row.text).toBe(event.text);
    expect(row.status).toBe("pending");
    expect(typeof row.occurred_at).toBe("number");
    expect(typeof row.created_at).toBe("number");
  });

  test("stores optional metadata", async () => {
    const event = validEvent({
      metadata: { chatId: "-100123", threadId: "9" },
    });
    const response = await post(event, API_KEY);
    const { eventId } = (await response.json()) as { eventId: string };

    const db = getDatabase();
    const row = db
      .prepare("SELECT metadata_json FROM inbox_messages WHERE id = $id")
      .get({ $id: eventId }) as { metadata_json: string };

    const parsed = JSON.parse(row.metadata_json);
    expect(parsed.chatId).toBe("-100123");
    expect(parsed.threadId).toBe("9");
  });

  test("duplicate does not create second row", async () => {
    const event = validEvent();

    await post(event, API_KEY);
    await post(event, API_KEY);

    const db = getDatabase();
    const count = db
      .prepare(
        "SELECT COUNT(*) as cnt FROM inbox_messages WHERE source = $source AND external_message_id = $eid",
      )
      .get({
        $source: event.source,
        $eid: event.externalMessageId,
      }) as { cnt: number };

    expect(count.cnt).toBe(1);
  });

  test("different source with same externalMessageId creates separate rows", async () => {
    const sharedMsgId = `msg-${crypto.randomUUID()}`;

    const resp1 = await post(
      validEvent({ source: "telegram", externalMessageId: sharedMsgId }),
      API_KEY,
    );
    const resp2 = await post(
      validEvent({ source: "slack", externalMessageId: sharedMsgId }),
      API_KEY,
    );

    expect(resp1.status).toBe(202);
    expect(resp2.status).toBe(202);

    const body1 = (await resp1.json()) as { eventId: string };
    const body2 = (await resp2.json()) as { eventId: string };
    expect(body1.eventId).not.toBe(body2.eventId);
  });

  test("returns 400 for invalid occurredAt date", async () => {
    const response = await post(
      validEvent({ occurredAt: "not-a-date" }),
      API_KEY,
    );

    expect(response.status).toBe(400);

    const body = (await response.json()) as {
      error: string;
      details: string[];
    };
    expect(body.error).toBe("invalid_request");
    expect(body.details.some((d: string) => d.includes("occurredAt"))).toBe(
      true,
    );
  });

  test("returns 400 for non-JSON request body", async () => {
    const response = await fetch(`${baseUrl}/ingest`, {
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
    expect(body.error).toBe("invalid_request");
    expect(body.details[0]).toBe("Request body must be valid JSON");
  });

  test("returns 400 for JSON array body", async () => {
    const response = await post([1, 2, 3], API_KEY);

    expect(response.status).toBe(400);

    const body = (await response.json()) as {
      error: string;
      details: string[];
    };
    expect(body.error).toBe("invalid_request");
    expect(body.details[0]).toBe("Request body must be a JSON object");
  });
});
