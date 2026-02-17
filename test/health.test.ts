import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CortexConfig } from "../src/config";
import { initDatabase } from "../src/db";
import { startServer } from "../src/server";

describe("health endpoint", () => {
  let server: { port: number; stop: () => void };
  let baseUrl: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    savedEnv.CORTEX_CONFIG_PATH = process.env.CORTEX_CONFIG_PATH;
    process.env.CORTEX_CONFIG_PATH = "/nonexistent/config.json";

    const config: CortexConfig = {
      host: "127.0.0.1",
      port: 0,
      ingestApiKey: "test-key",
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
      toolTimeoutMs: 20000,
    };

    initDatabase(":memory:");
    server = startServer(config);
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop();
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  test("GET /health returns healthy status", async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      status: string;
      version: string;
      uptime: number;
    };

    expect(body.status).toBe("healthy");
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  test("unknown routes return 404", async () => {
    const response = await fetch(`${baseUrl}/nonexistent`);

    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Not found");
  });

  test("POST /health returns 404", async () => {
    const response = await fetch(`${baseUrl}/health`, { method: "POST" });
    expect(response.status).toBe(404);
  });
});
