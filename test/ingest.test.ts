import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CortexConfig } from "../src/config";
import { closeDatabase, initDatabase } from "../src/db";
import { startServer } from "../src/server";

const API_KEY = "test-ingest-key";

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
  };
}

describe("POST /ingest (deprecated)", () => {
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

  test("returns 410 Gone with informative message", async () => {
    const response = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        channel: "telegram",
        externalMessageId: "msg-1",
        idempotencyKey: "key-1",
        topicKey: "topic-1",
        userId: "user-1",
        text: "hello",
        occurredAt: "2026-02-15T20:30:00Z",
      }),
    });

    expect(response.status).toBe(410);

    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(
      "POST /ingest has been removed. Use POST /receive instead.",
    );
  });

  test("returns 410 even without auth header", async () => {
    const response = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "test" }),
    });

    // 410 is returned unconditionally — no auth check needed for a gone endpoint
    expect(response.status).toBe(410);
  });

  test("returns 410 for any payload", async () => {
    const response = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(410);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("POST /ingest has been removed");
  });
});
