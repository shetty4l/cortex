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
  enqueueOutboxMessage,
  getDatabase,
  getOutboxMessage,
  initDatabase,
  pollOutboxMessages,
} from "../src/db";
import { startServer } from "../src/server";

const API_KEY = "test-ack-key";

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

describe("POST /outbox/ack", () => {
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
    return fetch(`${baseUrl}/outbox/ack`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  /** Seed an outbox message and claim it, returning messageId + leaseToken. */
  function seedAndClaim(): { messageId: string; leaseToken: string } {
    const outboxId = enqueueOutboxMessage({
      source: "telegram",
      topicKey: "topic-1",
      text: "Hello",
    });

    const results = pollOutboxMessages("telegram", 1, 60, 10);
    expect(results).toHaveLength(1);
    expect(results[0].messageId).toBe(outboxId);

    return {
      messageId: results[0].messageId,
      leaseToken: results[0].leaseToken,
    };
  }

  // --- Auth ---

  test("returns 401 without auth header", async () => {
    const response = await fetch(`${baseUrl}/outbox/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "out_123", leaseToken: "lease_abc" }),
    });
    expect(response.status).toBe(401);
  });

  test("returns 401 with wrong token", async () => {
    const response = await post(
      { messageId: "out_123", leaseToken: "lease_abc" },
      "wrong-key",
    );
    expect(response.status).toBe(401);
  });

  // --- Validation ---

  test("returns 400 when messageId is missing", async () => {
    const response = await post({ leaseToken: "lease_abc" }, API_KEY);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { details: string[] };
    expect(body.details.some((d: string) => d.includes("messageId"))).toBe(
      true,
    );
  });

  test("returns 400 when leaseToken is missing", async () => {
    const response = await post({ messageId: "out_123" }, API_KEY);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { details: string[] };
    expect(body.details.some((d: string) => d.includes("leaseToken"))).toBe(
      true,
    );
  });

  test("returns 400 when both fields are missing", async () => {
    const response = await post({}, API_KEY);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { details: string[] };
    expect(body.details).toHaveLength(2);
  });

  test("returns 400 for non-JSON body", async () => {
    const response = await fetch(`${baseUrl}/outbox/ack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: "not json",
    });
    expect(response.status).toBe(400);
  });

  // --- Successful ack ---

  test("acks a leased message successfully", async () => {
    const { messageId, leaseToken } = seedAndClaim();

    const response = await post({ messageId, leaseToken }, API_KEY);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("delivered");

    // Row should be delivered
    const row = getOutboxMessage(messageId);
    expect(row!.status).toBe("delivered");
  });

  test("idempotent re-ack returns already_delivered", async () => {
    const { messageId, leaseToken } = seedAndClaim();

    // First ack
    await post({ messageId, leaseToken }, API_KEY);

    // Second ack — idempotent
    const response = await post({ messageId, leaseToken }, API_KEY);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("already_delivered");
  });

  // --- Conflict cases ---

  test("returns 409 for wrong lease token", async () => {
    const { messageId } = seedAndClaim();

    const response = await post(
      { messageId, leaseToken: "lease_wrong" },
      API_KEY,
    );
    expect(response.status).toBe(409);

    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("lease_conflict");
  });

  test("returns 409 for expired lease", async () => {
    const { messageId, leaseToken } = seedAndClaim();

    // Manually expire the lease
    const db = getDatabase();
    const past = Date.now() - 60_000;
    db.prepare(
      "UPDATE outbox_messages SET lease_expires_at = $past WHERE id = $id",
    ).run({ $past: past, $id: messageId });

    const response = await post({ messageId, leaseToken }, API_KEY);
    expect(response.status).toBe(409);

    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("lease_conflict");
  });

  test("returns 409 when acking a delivered message with different token", async () => {
    const { messageId, leaseToken } = seedAndClaim();

    // Ack successfully first
    await post({ messageId, leaseToken }, API_KEY);

    // Try acking again with a different token
    const response = await post(
      { messageId, leaseToken: "lease_different" },
      API_KEY,
    );
    expect(response.status).toBe(409);
  });

  // --- Not found ---

  test("returns 404 for non-existent messageId", async () => {
    const response = await post(
      { messageId: "out_nonexistent", leaseToken: "lease_abc" },
      API_KEY,
    );
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });
});
