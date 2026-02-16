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
  getInboxMessage,
  initDatabase,
  listOutboxMessagesByTopic,
} from "../src/db";
import { startProcessingLoop } from "../src/loop";

// --- Mock Synapse server ---

let mockServer: ReturnType<typeof Bun.serve>;
let mockUrl: string;
let mockHandler: (req: Request) => Response | Promise<Response>;
let mockCallCount: number;

beforeAll(() => {
  mockCallCount = 0;
  mockHandler = () =>
    Response.json({ error: "no mock configured" }, { status: 500 });

  mockServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      mockCallCount++;
      return mockHandler(req);
    },
  });

  mockUrl = `http://127.0.0.1:${mockServer.port}`;
});

afterAll(() => {
  mockServer.stop(true);
});

// --- Test config ---

function testConfig(): CortexConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    ingestApiKey: "test-key",
    synapseUrl: mockUrl,
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

// --- Tests ---

describe("processing loop", () => {
  beforeEach(() => {
    initDatabase({ path: ":memory:", force: true });
    mockCallCount = 0;
  });

  afterEach(() => {
    closeDatabase();
  });

  test("processes an inbox message and writes to outbox", async () => {
    mockHandler = () => Response.json(openaiResponse("Hi there!"));

    const { eventId } = ingestMessage({ text: "Hello assistant" });
    const config = testConfig();
    const loop = startProcessingLoop(config);

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

  test("sends the user message text to Synapse", async () => {
    let capturedBody: { messages?: Array<{ role: string; content: string }> } =
      {};

    mockHandler = async (req) => {
      capturedBody = (await req.json()) as typeof capturedBody;
      return Response.json(openaiResponse("Got it"));
    };

    ingestMessage({ text: "What is 2+2?" });
    const loop = startProcessingLoop(testConfig());

    await waitFor(() => mockCallCount > 0);
    await loop.stop();

    expect(capturedBody.messages).toBeDefined();
    const messages = capturedBody.messages!;

    // System prompt + user message
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("Cortex");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("What is 2+2?");
  });

  test("preserves topic ordering — processes oldest first", async () => {
    const responses: string[] = [];
    let callIndex = 0;

    mockHandler = async (req) => {
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

    const loop = startProcessingLoop(testConfig());

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
    mockHandler = async (req) => {
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

    const loop = startProcessingLoop(testConfig());

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
    mockHandler = () =>
      Response.json(
        { error: { message: "All providers exhausted", type: "server_error" } },
        { status: 502 },
      );

    const { eventId } = ingestMessage({ text: "Will fail" });
    const loop = startProcessingLoop(testConfig());

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
    mockHandler = () => Response.json(openaiResponse("should not be called"));

    const loop = startProcessingLoop(testConfig());

    // Let it tick a couple of times on empty inbox
    await Bun.sleep(200);

    await loop.stop();

    // No calls to Synapse
    expect(mockCallCount).toBe(0);
  });

  test("loop continues processing after a failure", async () => {
    let callNum = 0;
    mockHandler = () => {
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

    const loop = startProcessingLoop(testConfig());

    await waitFor(() => {
      const msg = getInboxMessage(successId);
      return msg?.status === "done";
    });

    await loop.stop();

    expect(getInboxMessage(failId)?.status).toBe("failed");
    expect(getInboxMessage(successId)?.status).toBe("done");
  });
});
