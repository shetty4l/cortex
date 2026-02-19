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
import {
  closeDatabase,
  enqueueInboxMessage,
  getExtractionCursor,
  getInboxMessage,
  initDatabase,
  listOutboxMessagesByTopic,
  loadRecentTurns,
} from "../src/db";
import { startProcessingLoop } from "../src/loop";
import { SYSTEM_PROMPT } from "../src/prompt";

// --- Mock Synapse server ---

let mockSynapse: ReturnType<typeof Bun.serve>;
let mockSynapseUrl: string;
let mockSynapseHandler: (req: Request) => Response | Promise<Response>;
let mockSynapseCallCount: number;

beforeAll(() => {
  mockSynapseCallCount = 0;
  mockSynapseHandler = () =>
    Response.json({ error: "no mock configured" }, { status: 500 });

  mockSynapse = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      mockSynapseCallCount++;
      return mockSynapseHandler(req);
    },
  });

  mockSynapseUrl = `http://127.0.0.1:${mockSynapse.port}`;
});

// --- Mock Engram server ---

let mockEngram: ReturnType<typeof Bun.serve>;
let mockEngramUrl: string;
let mockEngramHandler: (req: Request) => Response | Promise<Response>;

beforeAll(() => {
  mockEngramHandler = async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/remember") {
      return Response.json({
        id: `mem_${crypto.randomUUID().slice(0, 8)}`,
        status: "created",
      });
    }
    return Response.json({ memories: [], fallback_mode: false });
  };

  mockEngram = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      return mockEngramHandler(req);
    },
  });

  mockEngramUrl = `http://127.0.0.1:${mockEngram.port}`;
});

afterAll(() => {
  mockSynapse.stop(true);
  mockEngram.stop(true);
});

// --- Test config ---

function testConfig(): CortexConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    ingestApiKey: "test-key",
    synapseUrl: mockSynapseUrl,
    engramUrl: mockEngramUrl,
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

// --- Helpers ---

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

function ingestMessage(
  overrides: Partial<{
    source: string;
    externalMessageId: string;
    topicKey: string;
    userId: string;
    text: string;
  }> = {},
) {
  const id = crypto.randomUUID().slice(0, 8);
  return enqueueInboxMessage({
    source: overrides.source ?? "test",
    externalMessageId: overrides.externalMessageId ?? `msg-${id}`,
    topicKey: overrides.topicKey ?? "topic-1",
    userId: overrides.userId ?? "user-1",
    text: overrides.text ?? "Hello",
    occurredAt: Date.now(),
    idempotencyKey: `key-${id}`,
  });
}

/** Wait until a condition is true or timeout. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  pollMs = 50,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await Bun.sleep(pollMs);
  }
}

/** Fast poll intervals for tests — avoids 2s idle sleep. */
const FAST_LOOP = { pollBusyMs: 10, pollIdleMs: 50 };

// --- Tests ---

describe("processing loop", () => {
  beforeEach(() => {
    initDatabase(":memory:");
    mockSynapseCallCount = 0;
    // Default Engram mock: handle both recall and remember
    mockEngramHandler = async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/remember") {
        return Response.json({
          id: `mem_${crypto.randomUUID().slice(0, 8)}`,
          status: "created",
        });
      }
      return Response.json({ memories: [], fallback_mode: false });
    };
  });

  afterEach(() => {
    closeDatabase();
  });

  test("processes an inbox message and writes to outbox", async () => {
    mockSynapseHandler = () => Response.json(openaiResponse("Hi there!"));

    const { eventId } = ingestMessage({ text: "Hello assistant" });
    const config = testConfig();
    const loop = startProcessingLoop(config, FAST_LOOP);

    await waitFor(() => {
      const msg = getInboxMessage(eventId);
      return msg?.status === "done";
    });

    await loop.stop();

    // Inbox message should be done
    const inbox = getInboxMessage(eventId);
    expect(inbox?.status).toBe("done");
    expect(inbox?.error).toBeNull();

    // Outbox should have the assistant response
    const outbox = listOutboxMessagesByTopic("topic-1");
    expect(outbox).toHaveLength(1);
    expect(outbox[0].text).toBe("Hi there!");
    expect(outbox[0].source).toBe("test");
    expect(outbox[0].status).toBe("pending");
  });

  test("sends system prompt with user message to Synapse", async () => {
    let capturedBody: { messages?: Array<{ role: string; content: string }> } =
      {};

    mockSynapseHandler = async (req) => {
      capturedBody = (await req.json()) as typeof capturedBody;
      return Response.json(openaiResponse("Got it"));
    };

    ingestMessage({ text: "What is 2+2?" });
    const loop = startProcessingLoop(testConfig(), FAST_LOOP);

    await waitFor(() => mockSynapseCallCount > 0);
    await loop.stop();

    expect(capturedBody.messages).toBeDefined();
    const messages = capturedBody.messages!;

    // System prompt + user message (no memories, no history)
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("Cortex");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("What is 2+2?");
  });

  test("preserves topic ordering — processes oldest first", async () => {
    const responses: string[] = [];
    let callIndex = 0;

    mockSynapseHandler = async (req) => {
      const body = (await req.json()) as {
        messages: Array<{ content: string }>;
      };
      const userMsg = body.messages[body.messages.length - 1].content;
      responses.push(userMsg);
      callIndex++;
      return Response.json(openaiResponse(`Reply ${callIndex}`));
    };

    // Enqueue two messages for the same topic
    const { eventId: id1 } = ingestMessage({
      text: "First message",
      topicKey: "topic-a",
    });
    // Small delay to ensure ordering by created_at
    await Bun.sleep(5);
    const { eventId: id2 } = ingestMessage({
      text: "Second message",
      topicKey: "topic-a",
    });

    const loop = startProcessingLoop(testConfig(), FAST_LOOP);

    await waitFor(() => {
      const msg = getInboxMessage(id2);
      return msg?.status === "done";
    });

    await loop.stop();

    // Both should be done
    expect(getInboxMessage(id1)?.status).toBe("done");
    expect(getInboxMessage(id2)?.status).toBe("done");

    // First message was sent to Synapse first
    expect(responses[0]).toBe("First message");
    expect(responses[1]).toBe("Second message");

    // Both outbox messages present
    const outbox = listOutboxMessagesByTopic("topic-a");
    expect(outbox).toHaveLength(2);
  });

  test("processes messages from different topics", async () => {
    mockSynapseHandler = async (req) => {
      const body = (await req.json()) as {
        messages: Array<{ content: string }>;
      };
      const userMsg = body.messages[body.messages.length - 1].content;
      return Response.json(openaiResponse(`Echo: ${userMsg}`));
    };

    const { eventId: id1 } = ingestMessage({
      text: "Topic A msg",
      topicKey: "topic-a",
    });
    const { eventId: id2 } = ingestMessage({
      text: "Topic B msg",
      topicKey: "topic-b",
    });

    const loop = startProcessingLoop(testConfig(), FAST_LOOP);

    await waitFor(() => {
      const a = getInboxMessage(id1);
      const b = getInboxMessage(id2);
      return a?.status === "done" && b?.status === "done";
    });

    await loop.stop();

    const outboxA = listOutboxMessagesByTopic("topic-a");
    const outboxB = listOutboxMessagesByTopic("topic-b");

    expect(outboxA).toHaveLength(1);
    expect(outboxA[0].text).toBe("Echo: Topic A msg");

    expect(outboxB).toHaveLength(1);
    expect(outboxB[0].text).toBe("Echo: Topic B msg");
  });

  test("marks inbox as failed when Synapse returns an error", async () => {
    mockSynapseHandler = () =>
      Response.json(
        { error: { message: "All providers exhausted", type: "server_error" } },
        { status: 502 },
      );

    const { eventId } = ingestMessage({ text: "Will fail" });
    const loop = startProcessingLoop(testConfig(), FAST_LOOP);

    await waitFor(() => {
      const msg = getInboxMessage(eventId);
      return msg?.status === "failed";
    });

    await loop.stop();

    const inbox = getInboxMessage(eventId);
    expect(inbox?.status).toBe("failed");
    expect(inbox?.error).toContain("502");

    // No outbox message should be written on failure
    const outbox = listOutboxMessagesByTopic("topic-1");
    expect(outbox).toHaveLength(0);
  });

  test("loop stops gracefully without errors when inbox is empty", async () => {
    mockSynapseHandler = () =>
      Response.json(openaiResponse("should not be called"));

    const loop = startProcessingLoop(testConfig(), FAST_LOOP);

    // Let it tick a couple of times on empty inbox
    await Bun.sleep(200);

    await loop.stop();

    // No calls to Synapse
    expect(mockSynapseCallCount).toBe(0);
  });

  test("loop continues processing after a failure", async () => {
    let callNum = 0;
    mockSynapseHandler = () => {
      callNum++;
      if (callNum === 1) {
        return Response.json(
          { error: { message: "boom", type: "server_error" } },
          { status: 500 },
        );
      }
      return Response.json(openaiResponse("Success after failure"));
    };

    const { eventId: failId } = ingestMessage({ text: "Will fail" });
    await Bun.sleep(5);
    const { eventId: successId } = ingestMessage({
      text: "Will succeed",
      externalMessageId: "msg-success",
    });

    const loop = startProcessingLoop(testConfig(), FAST_LOOP);

    await waitFor(() => {
      const msg = getInboxMessage(successId);
      return msg?.status === "done";
    });

    await loop.stop();

    expect(getInboxMessage(failId)?.status).toBe("failed");
    expect(getInboxMessage(successId)?.status).toBe("done");
  });

  // --- Slice 4: Turn history tests ---

  test("saves turn pairs to history after processing", async () => {
    mockSynapseHandler = () =>
      Response.json(openaiResponse("The answer is 4."));

    const { eventId } = ingestMessage({
      text: "What is 2+2?",
      topicKey: "topic-turns",
    });
    const loop = startProcessingLoop(testConfig(), FAST_LOOP);

    await waitFor(() => getInboxMessage(eventId)?.status === "done");
    await loop.stop();

    const turns = loadRecentTurns("topic-turns");
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe("user");
    expect(turns[0].content).toBe("What is 2+2?");
    expect(turns[1].role).toBe("assistant");
    expect(turns[1].content).toBe("The answer is 4.");
  });

  test("does not save turns when Synapse fails", async () => {
    mockSynapseHandler = () =>
      Response.json(
        { error: { message: "boom", type: "server_error" } },
        { status: 500 },
      );

    const { eventId } = ingestMessage({
      text: "Will fail",
      topicKey: "topic-fail",
    });
    const loop = startProcessingLoop(testConfig(), FAST_LOOP);

    await waitFor(() => getInboxMessage(eventId)?.status === "failed");
    await loop.stop();

    const turns = loadRecentTurns("topic-fail");
    expect(turns).toHaveLength(0);
  });

  test("includes turn history in subsequent Synapse calls", async () => {
    const capturedMessages: Array<Array<{ role: string; content: string }>> =
      [];

    mockSynapseHandler = async (req) => {
      const body = (await req.json()) as {
        messages: Array<{ role: string; content: string }>;
      };
      capturedMessages.push(body.messages);
      const userMsg = body.messages[body.messages.length - 1].content;
      return Response.json(openaiResponse(`Reply to: ${userMsg}`));
    };

    // First message
    const { eventId: id1 } = ingestMessage({
      text: "My name is Shetty.",
      topicKey: "topic-history",
    });

    const loop = startProcessingLoop(testConfig(), FAST_LOOP);
    await waitFor(() => getInboxMessage(id1)?.status === "done");

    // Second message on same topic
    await Bun.sleep(5);
    const { eventId: id2 } = ingestMessage({
      text: "What is my name?",
      topicKey: "topic-history",
      externalMessageId: "msg-second",
    });

    await waitFor(() => getInboxMessage(id2)?.status === "done");
    await loop.stop();

    // First call: system + user only (no history yet)
    expect(capturedMessages[0]).toHaveLength(2);
    expect(capturedMessages[0][0].role).toBe("system");
    expect(capturedMessages[0][1].content).toBe("My name is Shetty.");

    // Second call: system + 2 history turns + user
    expect(capturedMessages[1]).toHaveLength(4);
    expect(capturedMessages[1][0].role).toBe("system");
    expect(capturedMessages[1][1].role).toBe("user");
    expect(capturedMessages[1][1].content).toBe("My name is Shetty.");
    expect(capturedMessages[1][2].role).toBe("assistant");
    expect(capturedMessages[1][2].content).toBe("Reply to: My name is Shetty.");
    expect(capturedMessages[1][3].role).toBe("user");
    expect(capturedMessages[1][3].content).toBe("What is my name?");
  });

  test("turn history is isolated between topics", async () => {
    const capturedMessages: Array<Array<{ role: string; content: string }>> =
      [];

    mockSynapseHandler = async (req) => {
      const body = (await req.json()) as {
        messages: Array<{ role: string; content: string }>;
      };
      capturedMessages.push(body.messages);
      return Response.json(openaiResponse("ok"));
    };

    // Message on topic-a
    const { eventId: idA } = ingestMessage({
      text: "Secret code is FALCON",
      topicKey: "topic-a",
    });

    const loop = startProcessingLoop(testConfig(), FAST_LOOP);
    await waitFor(() => getInboxMessage(idA)?.status === "done");

    // Message on topic-b
    await Bun.sleep(5);
    const { eventId: idB } = ingestMessage({
      text: "What is the secret?",
      topicKey: "topic-b",
      externalMessageId: "msg-b",
    });

    await waitFor(() => getInboxMessage(idB)?.status === "done");
    await loop.stop();

    // topic-b call should NOT include topic-a's turns
    expect(capturedMessages[1]).toHaveLength(2); // system + user only
    expect(capturedMessages[1][1].content).toBe("What is the secret?");
  });

  // --- Slice 4: Engram recall tests ---

  test("includes Engram memories in Synapse prompt", async () => {
    let capturedBody: {
      messages?: Array<{ role: string; content: string }>;
    } = {};

    mockEngramHandler = () =>
      Response.json({
        memories: [
          {
            id: "m1",
            content: "User lives in Seattle",
            category: "fact",
            strength: 1.0,
            relevance: 0.9,
          },
        ],
        fallback_mode: false,
      });

    mockSynapseHandler = async (req) => {
      capturedBody = (await req.json()) as typeof capturedBody;
      return Response.json(openaiResponse("You live in Seattle!"));
    };

    const { eventId } = ingestMessage({
      text: "Where do I live?",
      topicKey: "topic-engram",
    });
    const loop = startProcessingLoop(testConfig(), FAST_LOOP);

    await waitFor(() => getInboxMessage(eventId)?.status === "done");
    await loop.stop();

    const messages = capturedBody.messages!;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain(SYSTEM_PROMPT);
    expect(messages[0].content).toContain("facts and preferences");
    expect(messages[0].content).toContain("User lives in Seattle");
  });

  test("processes normally when Engram is unreachable", async () => {
    mockSynapseHandler = () => Response.json(openaiResponse("Still works!"));

    // Point to a bad port — Engram connection will fail
    const config = { ...testConfig(), engramUrl: "http://127.0.0.1:1" };

    const { eventId } = ingestMessage({
      text: "Hello",
      topicKey: "topic-no-engram",
    });
    const loop = startProcessingLoop(config, FAST_LOOP);

    await waitFor(() => getInboxMessage(eventId)?.status === "done");
    await loop.stop();

    const outbox = listOutboxMessagesByTopic("topic-no-engram");
    expect(outbox).toHaveLength(1);
    expect(outbox[0].text).toBe("Still works!");
  });

  test("sends topic_key as scope_id to Engram", async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];

    mockEngramHandler = async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      capturedBodies.push(body);
      return Response.json({ memories: [], fallback_mode: false });
    };

    mockSynapseHandler = () => Response.json(openaiResponse("ok"));

    const { eventId } = ingestMessage({
      text: "Hello",
      topicKey: "test:my-topic",
    });
    const loop = startProcessingLoop(testConfig(), FAST_LOOP);

    await waitFor(() => getInboxMessage(eventId)?.status === "done");
    await loop.stop();

    // recallDual makes two calls: one with scope_id, one without
    expect(capturedBodies.length).toBe(2);

    const scopedCall = capturedBodies.find((b) => b.scope_id !== undefined);
    const globalCall = capturedBodies.find((b) => b.scope_id === undefined);

    expect(scopedCall).toBeDefined();
    expect(scopedCall!.scope_id).toBe("test:my-topic");
    expect(scopedCall!.query).toBe("Hello");

    expect(globalCall).toBeDefined();
    expect(globalCall!.query).toBe("Hello");
  });

  // --- Slice 5: Extraction trigger tests ---

  test("triggers extraction after processing messages", async () => {
    let extractionModelCalls = 0;

    mockSynapseHandler = async (req) => {
      const body = (await req.json()) as { model: string };
      if (body.model === "test-extraction-model") {
        extractionModelCalls++;
        return Response.json(
          openaiResponse(
            JSON.stringify([
              { content: "User greeted the assistant", category: "fact" },
            ]),
          ),
        );
      }
      return Response.json(openaiResponse("Hello!"));
    };

    const config = {
      ...testConfig(),
      extractionModel: "test-extraction-model",
      extractionInterval: 1,
    };

    const { eventId } = ingestMessage({
      text: "Hi there",
      topicKey: "topic-extract",
    });
    const loop = startProcessingLoop(config, FAST_LOOP);

    await waitFor(() => getInboxMessage(eventId)?.status === "done");

    // Give extraction time to complete (fire-and-forget)
    await Bun.sleep(500);
    await loop.stop();

    // Extraction model should have been called
    expect(extractionModelCalls).toBeGreaterThanOrEqual(1);

    // Cursor should be advanced
    const cursor = getExtractionCursor("topic-extract");
    expect(cursor).not.toBeNull();
    expect(cursor!.turns_since_extraction).toBe(0);
  });

  test("loop continues normally when extraction model fails", async () => {
    let callNum = 0;

    mockSynapseHandler = async (req) => {
      const body = (await req.json()) as { model: string };
      if (body.model === "test-extraction-model") {
        // Extraction model always fails
        return Response.json(
          { error: { message: "extraction boom", type: "server_error" } },
          { status: 500 },
        );
      }
      callNum++;
      return Response.json(openaiResponse(`Reply ${callNum}`));
    };

    const config = {
      ...testConfig(),
      extractionModel: "test-extraction-model",
      extractionInterval: 1,
    };

    const { eventId: id1 } = ingestMessage({
      text: "First",
      topicKey: "topic-ext-fail",
    });
    await Bun.sleep(5);
    const { eventId: id2 } = ingestMessage({
      text: "Second",
      topicKey: "topic-ext-fail",
      externalMessageId: "msg-second-ext",
    });

    const loop = startProcessingLoop(config, FAST_LOOP);

    await waitFor(() => getInboxMessage(id2)?.status === "done");
    await Bun.sleep(200);
    await loop.stop();

    // Both messages processed successfully despite extraction failures
    expect(getInboxMessage(id1)?.status).toBe("done");
    expect(getInboxMessage(id2)?.status).toBe("done");

    const outbox = listOutboxMessagesByTopic("topic-ext-fail");
    expect(outbox).toHaveLength(2);
  });
});
