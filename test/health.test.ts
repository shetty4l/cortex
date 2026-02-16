import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { createServer } from "../src/server";

describe("health endpoint", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    savedEnv.CORTEX_CONFIG_PATH = process.env.CORTEX_CONFIG_PATH;
    savedEnv.CORTEX_INGEST_API_KEY = process.env.CORTEX_INGEST_API_KEY;
    process.env.CORTEX_CONFIG_PATH = "/nonexistent/config.json";
    process.env.CORTEX_INGEST_API_KEY = "test-key";
    const config = loadConfig({ quiet: true });
    // Use port 0 for random available port in tests
    const cortexServer = createServer({ ...config, port: 0 });
    server = cortexServer.start();
    baseUrl = `http://${server.hostname}:${server.port}`;
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
    expect(body.error).toBe("not_found");
  });

  test("POST /health returns 404", async () => {
    const response = await fetch(`${baseUrl}/health`, { method: "POST" });
    expect(response.status).toBe(404);
  });
});
