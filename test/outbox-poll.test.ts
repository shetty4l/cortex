import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { CortexConfig } from "../src/config";
import {
  closeDatabase,
  computeBackoffDelay,
  enqueueOutboxMessage,
  getDatabase,
  getOutboxMessage,
  initDatabase,
} from "../src/db";
import { startServer } from "../src/server";

const API_KEY = "test-poll-key";

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
  };
}

describe("computeBackoffDelay", () => {
  test("returns ~5s for first attempt", () => {
    const delays: number[] = [];
    for (let i = 0; i < 100; i++) {
      delays.push(computeBackoffDelay(1));
    }
    // 5000 * [0.8, 1.2] = [4000, 6000]
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(4000);
      expect(d).toBeLessThanOrEqual(6000);
    }
  });

  test("doubles delay with each attempt", () => {
    // Run many samples and check medians increase
    const medianFor = (attempts: number) => {
      const samples = Array.from({ length: 50 }, () =>
        computeBackoffDelay(attempts),
      );
      samples.sort((a, b) => a - b);
      return samples[25];
    };

    const m1 = medianFor(1);
    const m2 = medianFor(2);
    const m3 = medianFor(3);

    expect(m2).toBeGreaterThan(m1 * 1.5);
    expect(m3).toBeGreaterThan(m2 * 1.5);
  });

  test("caps at 15 minutes (900000ms)", () => {
    const delays: number[] = [];
    for (let i = 0; i < 50; i++) {
      delays.push(computeBackoffDelay(20));
    }
    // 900000 * 1.2 = 1080000
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(1_080_000);
      expect(d).toBeGreaterThanOrEqual(720_000); // 900000 * 0.8
    }
  });
});

describe("POST /outbox/poll", () => {
  let server: { port: number; stop: () => void };
  let baseUrl: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    savedEnv.CORTEX_CONFIG_PATH = process.env.CORTEX_CONFIG_PATH;
    process.env.CORTEX_CONFIG_PATH = "/nonexistent/config.json";
    initDatabase(":memory:");
    server = startServer(makeConfig());
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

  beforeEach(() => {
    initDatabase(":memory:");
  });

  function post(body: unknown, token?: string) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token !== undefined) {
      headers.Authorization = `Bearer ${token}`;
    }
    return fetch(`${baseUrl}/outbox/poll`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  function seedOutbox(
    overrides: Partial<{
      source: string;
      topicKey: string;
      text: string;
    }> = {},
  ): string {
    return enqueueOutboxMessage({
      source: overrides.source ?? "telegram",
      topicKey: overrides.topicKey ?? "topic-1",
      text: overrides.text ?? "Hello from assistant",
    });
  }

  // --- Auth ---

  test("returns 401 without auth header", async () => {
    const response = await fetch(`${baseUrl}/outbox/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "telegram" }),
    });
    expect(response.status).toBe(401);
  });

  test("returns 401 with wrong token", async () => {
    const response = await post({ source: "telegram" }, "wrong-key");
    expect(response.status).toBe(401);
  });

  // --- Validation ---

  test("returns 400 when source is missing", async () => {
    const response = await post({}, API_KEY);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { details: string[] };
    expect(body.details.some((d: string) => d.includes("source"))).toBe(true);
  });

  test("returns 400 when source is empty string", async () => {
    const response = await post({ source: "" }, API_KEY);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { details: string[] };
    expect(body.details.some((d: string) => d.includes("source"))).toBe(true);
  });

  test("returns 400 when max is out of range", async () => {
    const response = await post({ source: "telegram", max: 200 }, API_KEY);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { details: string[] };
    expect(body.details.some((d: string) => d.includes("max"))).toBe(true);
  });

  test("returns 400 when max is zero", async () => {
    const response = await post({ source: "telegram", max: 0 }, API_KEY);
    expect(response.status).toBe(400);
  });

  test("returns 400 when leaseSeconds is out of range", async () => {
    const response = await post(
      { source: "telegram", leaseSeconds: 5 },
      API_KEY,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { details: string[] };
    expect(body.details.some((d: string) => d.includes("leaseSeconds"))).toBe(
      true,
    );
  });

  test("returns 400 for non-JSON body", async () => {
    const response = await fetch(`${baseUrl}/outbox/poll`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: "not json",
    });
    expect(response.status).toBe(400);
  });

  test("returns 400 for JSON array body", async () => {
    const response = await post([1, 2, 3], API_KEY);
    expect(response.status).toBe(400);
  });

  // --- Empty results ---

  test("returns empty messages array when no outbox messages exist", async () => {
    const response = await post({ source: "telegram" }, API_KEY);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      messages: unknown[];
    };
    expect(body.messages).toHaveLength(0);
  });

  test("returns empty when source does not match", async () => {
    seedOutbox({ source: "telegram" });

    const response = await post({ source: "slack" }, API_KEY);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { messages: unknown[] };
    expect(body.messages).toHaveLength(0);
  });

  // --- Successful claims ---

  test("claims a single pending outbox message", async () => {
    const outboxId = seedOutbox();

    const response = await post({ source: "telegram" }, API_KEY);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      messages: Array<{
        messageId: string;
        leaseToken: string;
        topicKey: string;
        text: string;
        payload: unknown;
      }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].messageId).toBe(outboxId);
    expect(body.messages[0].leaseToken).toMatch(/^lease_/);
    expect(body.messages[0].topicKey).toBe("topic-1");
    expect(body.messages[0].text).toBe("Hello from assistant");
    expect(body.messages[0].payload).toBeNull();
  });

  test("claims multiple messages up to max", async () => {
    seedOutbox({ text: "msg 1" });
    seedOutbox({ text: "msg 2" });
    seedOutbox({ text: "msg 3" });

    const response = await post({ source: "telegram", max: 2 }, API_KEY);
    const body = (await response.json()) as {
      messages: Array<{ text: string }>;
    };
    expect(body.messages).toHaveLength(2);
  });

  test("sets lease fields on claimed message", async () => {
    const outboxId = seedOutbox();

    await post({ source: "telegram", leaseSeconds: 30 }, API_KEY);

    const row = getOutboxMessage(outboxId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("leased");
    expect(row!.lease_token).toMatch(/^lease_/);
    expect(row!.lease_expires_at).not.toBeNull();
    expect(row!.attempts).toBe(1);
  });

  test("does not return already-leased messages with active lease", async () => {
    seedOutbox();

    // First poll claims the message
    await post({ source: "telegram", leaseSeconds: 60 }, API_KEY);

    // Second poll should find nothing (lease is active)
    const response = await post({ source: "telegram" }, API_KEY);
    const body = (await response.json()) as { messages: unknown[] };
    expect(body.messages).toHaveLength(0);
  });

  test("reclaims message with expired lease", async () => {
    const outboxId = seedOutbox();

    // Claim with very short lease, then manually expire it
    await post({ source: "telegram", leaseSeconds: 10 }, API_KEY);

    // Manually expire the lease by backdating lease_expires_at and next_attempt_at
    const db = getDatabase();
    const past = Date.now() - 60_000;
    db.prepare(
      "UPDATE outbox_messages SET lease_expires_at = $past, next_attempt_at = $past WHERE id = $id",
    ).run({ $past: past, $id: outboxId });

    // Now poll again — should reclaim
    const response = await post({ source: "telegram" }, API_KEY);
    const body = (await response.json()) as {
      messages: Array<{ messageId: string }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].messageId).toBe(outboxId);

    // Attempts should now be 2
    const row = getOutboxMessage(outboxId);
    expect(row!.attempts).toBe(2);
  });

  // --- DLQ ---

  test("transitions to dead when attempts exceed maxAttempts", async () => {
    const outboxId = seedOutbox();

    // Manually set attempts to maxAttempts (10), so next claim would be 11 > 10
    const db = getDatabase();
    const past = Date.now() - 60_000;
    db.prepare(
      "UPDATE outbox_messages SET attempts = 10, status = 'leased', lease_expires_at = $past, next_attempt_at = $past WHERE id = $id",
    ).run({ $past: past, $id: outboxId });

    // Poll should DLQ it, not return it
    const response = await post({ source: "telegram" }, API_KEY);
    const body = (await response.json()) as { messages: unknown[] };
    expect(body.messages).toHaveLength(0);

    // Row should be dead
    const row = getOutboxMessage(outboxId);
    expect(row!.status).toBe("dead");
    expect(row!.attempts).toBe(11);
    expect(row!.last_error).toBe("max attempts exceeded");
  });

  // --- Backoff ---

  test("sets next_attempt_at in the future for retries", async () => {
    const outboxId = seedOutbox();

    const before = Date.now();
    await post({ source: "telegram" }, API_KEY);

    const row = getOutboxMessage(outboxId);
    expect(row).not.toBeNull();
    // next_attempt_at should be in the future (backoff for attempt 1: ~4000-6000ms)
    expect(row!.next_attempt_at).toBeGreaterThan(before);
  });

  // --- Payload ---

  test("returns parsed payload from outbox message", async () => {
    enqueueOutboxMessage({
      source: "telegram",
      topicKey: "topic-1",
      text: "text with payload",
      payload: { buttons: [{ label: "Yes" }] },
    });

    const response = await post({ source: "telegram" }, API_KEY);
    const body = (await response.json()) as {
      messages: Array<{ payload: { buttons: Array<{ label: string }> } }>;
    };
    expect(body.messages[0].payload).toEqual({
      buttons: [{ label: "Yes" }],
    });
  });

  // --- Defaults ---

  test("uses config defaults when max and leaseSeconds are omitted", async () => {
    seedOutbox();

    // Should work with just source, using outboxPollDefaultBatch and outboxLeaseSeconds from config
    const response = await post({ source: "telegram" }, API_KEY);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { messages: unknown[] };
    expect(body.messages).toHaveLength(1);
  });
});
