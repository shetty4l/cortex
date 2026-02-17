import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { CortexConfig } from "../src/config";
import { closeDatabase, initDatabase } from "../src/db";
import { startProcessingLoop } from "../src/loop";
import { sendMessage } from "../src/send";
import { startServer } from "../src/server";

// --- Mock Synapse server ---

let mockSynapse: ReturnType<typeof Bun.serve>;
let mockSynapseUrl: string;
let mockHandler: (req: Request) => Response | Promise<Response>;

beforeAll(() => {
  mockHandler = () =>
    Response.json({ error: "no mock configured" }, { status: 500 });

  mockSynapse = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      return mockHandler(req);
    },
  });

  mockSynapseUrl = `http://127.0.0.1:${mockSynapse.port}`;
});

afterAll(() => {
  mockSynapse.stop(true);
});

// --- Helpers ---

const API_KEY = "test-send-key";

function testConfig(port: number): CortexConfig {
  return {
    host: "127.0.0.1",
    port,
    ingestApiKey: API_KEY,
    synapseUrl: mockSynapseUrl,
    engramUrl: "http://localhost:7749",
    model: "test-model",
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
}

function openaiResponse(content: string) {
  return {
    id: "chat-test",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

// --- Tests ---

describe("sendMessage (end-to-end)", () => {
  let cortexServer: { port: number; stop: () => void };
  let loop: { stop: () => Promise<void> };
  let baseUrl: string;
  let config: CortexConfig;

  beforeAll(() => {
    initDatabase(":memory:");
    config = testConfig(0);
    cortexServer = startServer(config);
    baseUrl = `http://localhost:${cortexServer.port}`;
  });

  afterAll(() => {
    cortexServer.stop();
    closeDatabase();
  });

  beforeEach(() => {
    initDatabase(":memory:");
    loop = startProcessingLoop(
      { ...config, port: cortexServer.port },
      { pollBusyMs: 10, pollIdleMs: 50 },
    );
  });

  afterEach(async () => {
    await loop.stop();
  });

  test("full round-trip: ingest → loop → synapse → outbox → poll → ack", async () => {
    mockHandler = () =>
      Response.json(openaiResponse("Hello from the assistant!"));

    const result = await sendMessage("What is 2+2?", {
      baseUrl,
      apiKey: API_KEY,
      pollIntervalMs: 100,
      pollTimeoutMs: 10_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("Hello from the assistant!");
  });

  test("returns correct response for different messages", async () => {
    mockHandler = async (req) => {
      const body = (await req.json()) as {
        messages: Array<{ content: string }>;
      };
      const userMsg = body.messages[body.messages.length - 1].content;
      return Response.json(openaiResponse(`Echo: ${userMsg}`));
    };

    const result = await sendMessage("ping", {
      baseUrl,
      apiKey: API_KEY,
      pollIntervalMs: 100,
      pollTimeoutMs: 10_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("Echo: ping");
  });

  test("returns error when no response is produced (timeout)", async () => {
    // Synapse returns an error, so the loop marks inbox as failed
    // but no outbox message is written — sendMessage never finds a response
    mockHandler = () =>
      Response.json(
        { error: { message: "model unavailable", type: "server_error" } },
        { status: 503 },
      );

    const result = await sendMessage("Will timeout", {
      baseUrl,
      apiKey: API_KEY,
      pollIntervalMs: 50,
      pollTimeoutMs: 500,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Timed out");
  });

  test("returns error on connection failure", async () => {
    const result = await sendMessage("Hello", {
      baseUrl: "http://localhost:1",
      apiKey: API_KEY,
      pollIntervalMs: 100,
      pollTimeoutMs: 1_000,
    });

    expect(result.ok).toBe(false);
  });

  test("handles multiple sequential sends", async () => {
    let callCount = 0;
    mockHandler = () => {
      callCount++;
      return Response.json(openaiResponse(`Response ${callCount}`));
    };

    const opts = {
      baseUrl,
      apiKey: API_KEY,
      pollIntervalMs: 100,
      pollTimeoutMs: 10_000,
    };

    const r1 = await sendMessage("First", opts);
    const r2 = await sendMessage("Second", opts);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value).toBe("Response 1");
    expect(r2.value).toBe("Response 2");
  });
});
