import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "@shetty4l/core/result";
import type { CortexConfig } from "../src/config";
import {
  claimNextInboxMessage,
  closeDatabase,
  computeBackoffDelay,
  enqueueInboxMessage,
  getDatabase,
  getExtractionCursor,
  getInboxMessage,
  getTopicSummary,
  initDatabase,
  listOutboxMessagesByTopic,
  loadRecentTurns,
  retryInboxMessage,
} from "../src/db";
import { isTransientError, startProcessingLoop } from "../src/loop";
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from "../src/prompt";
import type { SkillRegistry } from "../src/skills";
import { createEmptyRegistry } from "../src/skills";

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
    models: ["test-model"],
    activeWindowSize: 10,
    extractionInterval: 3,
    turnTtlDays: 30,
    schedulerTickSeconds: 30,
    schedulerTimezone: "UTC",
    outboxPollDefaultBatch: 20,
    outboxLeaseSeconds: 60,
    outboxMaxAttempts: 10,
    inboxMaxAttempts: 5,
    skillDirs: [],
    skillConfig: {},
    toolTimeoutMs: 20000,
    maxToolRounds: 8,
    synapseTimeoutMs: 60_000,
    thalamusModels: ["test-model"],
    thalamusSyncIntervalMs: 21_600_000,
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
    channel: string;
    externalMessageId: string;
    topicKey: string;
    userId: string;
    text: string;
  }> = {},
) {
  const id = crypto.randomUUID().slice(0, 8);
  return enqueueInboxMessage({
    channel: overrides.channel ?? "test",
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
    const loop = startProcessingLoop(config, createEmptyRegistry(), FAST_LOOP);

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
    expect(outbox[0].channel).toBe("test");
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
    const loop = startProcessingLoop(
      testConfig(),
      createEmptyRegistry(),
      FAST_LOOP,
    );

    await waitFor(() => mockSynapseCallCount > 0);
    await loop.stop();

    expect(capturedBody.messages).toBeDefined();
    const messages = capturedBody.messages!;

    // System prompt + user message (no memories, no history)
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("personal life assistant");
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

    const loop = startProcessingLoop(
      testConfig(),
      createEmptyRegistry(),
      FAST_LOOP,
    );

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

    const loop = startProcessingLoop(
      testConfig(),
      createEmptyRegistry(),
      FAST_LOOP,
    );

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

  test("marks inbox as failed when Synapse returns a permanent error", async () => {
    mockSynapseHandler = () =>
      Response.json(
        { error: { message: "Invalid request", type: "invalid_request" } },
        { status: 400 },
      );

    const { eventId } = ingestMessage({ text: "Will fail" });
    const loop = startProcessingLoop(
      testConfig(),
      createEmptyRegistry(),
      FAST_LOOP,
    );

    await waitFor(() => {
      const msg = getInboxMessage(eventId);
      return msg?.status === "failed";
    });

    await loop.stop();

    const inbox = getInboxMessage(eventId);
    expect(inbox?.status).toBe("failed");
    expect(inbox?.error).toContain("400");

    // No outbox message should be written on failure
    const outbox = listOutboxMessagesByTopic("topic-1");
    expect(outbox).toHaveLength(0);
  });

  test("retries inbox message on transient error (502)", async () => {
    let callCount = 0;
    mockSynapseHandler = () => {
      callCount++;
      if (callCount <= 2) {
        return Response.json(
          {
            error: {
              message: "All providers exhausted",
              type: "server_error",
            },
          },
          { status: 502 },
        );
      }
      return Response.json(openaiResponse("Recovered after retry"));
    };

    const { eventId } = ingestMessage({
      text: "Will retry",
      topicKey: "topic-transient",
    });

    const loop = startProcessingLoop(
      testConfig(),
      createEmptyRegistry(),
      FAST_LOOP,
    );

    // First call: 502 → transient → retry (but with backoff delay)
    await waitFor(() => {
      const msg = getInboxMessage(eventId);
      return msg?.status === "pending" && msg.attempts > 0;
    });

    const msg = getInboxMessage(eventId);
    expect(msg?.status).toBe("pending");
    expect(msg?.error).toContain("502");
    // Message should have a future next_attempt_at (backoff)
    expect(msg!.next_attempt_at).toBeGreaterThan(0);

    await loop.stop();

    // No outbox message yet — still retrying
    const outbox = listOutboxMessagesByTopic("topic-transient");
    expect(outbox).toHaveLength(0);
  });

  test("loop stops gracefully without errors when inbox is empty", async () => {
    mockSynapseHandler = () =>
      Response.json(openaiResponse("should not be called"));

    const loop = startProcessingLoop(
      testConfig(),
      createEmptyRegistry(),
      FAST_LOOP,
    );

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

    const loop = startProcessingLoop(
      testConfig(),
      createEmptyRegistry(),
      FAST_LOOP,
    );

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
    const loop = startProcessingLoop(
      testConfig(),
      createEmptyRegistry(),
      FAST_LOOP,
    );

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
    const loop = startProcessingLoop(
      testConfig(),
      createEmptyRegistry(),
      FAST_LOOP,
    );

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

    const loop = startProcessingLoop(
      testConfig(),
      createEmptyRegistry(),
      FAST_LOOP,
    );
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

    const loop = startProcessingLoop(
      testConfig(),
      createEmptyRegistry(),
      FAST_LOOP,
    );
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
    const loop = startProcessingLoop(
      testConfig(),
      createEmptyRegistry(),
      FAST_LOOP,
    );

    await waitFor(() => getInboxMessage(eventId)?.status === "done");
    await loop.stop();

    const messages = capturedBody.messages!;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("personal life assistant");
    expect(messages[0].content).toContain("What you know about the user");
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
    const loop = startProcessingLoop(config, createEmptyRegistry(), FAST_LOOP);

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
    const loop = startProcessingLoop(
      testConfig(),
      createEmptyRegistry(),
      FAST_LOOP,
    );

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
      extractionModels: ["test-extraction-model"],
      extractionInterval: 1,
    };

    const { eventId } = ingestMessage({
      text: "Hi there",
      topicKey: "topic-extract",
    });
    const loop = startProcessingLoop(config, createEmptyRegistry(), FAST_LOOP);

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

  test("counts turns for extraction even when extraction is in-flight", async () => {
    let extractionCallCount = 0;
    let resolveExtraction: (() => void) | null = null;

    mockSynapseHandler = async (req) => {
      const body = (await req.json()) as { model: string };
      if (body.model === "test-extraction-model") {
        extractionCallCount++;
        // First extraction call blocks until we release it
        if (extractionCallCount === 1) {
          await new Promise<void>((resolve) => {
            resolveExtraction = resolve;
          });
        }
        return Response.json(
          openaiResponse(
            JSON.stringify([{ content: "Some fact", category: "fact" }]),
          ),
        );
      }
      return Response.json(openaiResponse("ok"));
    };

    const config = {
      ...testConfig(),
      extractionModels: ["test-extraction-model"],
      extractionInterval: 1,
    };

    // Message A: triggers extraction (which blocks)
    const { eventId: idA } = ingestMessage({
      text: "Message A",
      topicKey: "topic-inflight",
    });
    const loop = startProcessingLoop(config, createEmptyRegistry(), FAST_LOOP);
    await waitFor(() => getInboxMessage(idA)?.status === "done");
    // Wait for extraction to start (it will be blocked)
    await waitFor(() => extractionCallCount >= 1);

    // Message B: processed while extraction from A is still in-flight
    await Bun.sleep(5);
    const { eventId: idB } = ingestMessage({
      text: "Message B",
      topicKey: "topic-inflight",
      externalMessageId: "msg-b-inflight",
    });
    await waitFor(() => getInboxMessage(idB)?.status === "done");

    // The cursor should have counted BOTH A's and B's turns even though
    // extraction was in-flight when B was processed.
    // Bug: without fix, counter is 1 (B's increment was skipped entirely).
    // Fixed: counter should be 2 (A incremented to 1, B incremented to 2).
    const cursorDuringFlight = getExtractionCursor("topic-inflight");
    expect(cursorDuringFlight).not.toBeNull();
    expect(cursorDuringFlight!.turns_since_extraction).toBe(2);

    // Release the blocked extraction
    resolveExtraction!();
    await Bun.sleep(500);
    await loop.stop();
  });

  test("extracts turns from skipped messages after next trigger", async () => {
    let extractionCallCount = 0;
    let resolveExtraction: (() => void) | null = null;
    const extractedContents: string[][] = [];

    mockSynapseHandler = async (req) => {
      const body = (await req.json()) as {
        model: string;
        messages?: Array<{ role: string; content: string }>;
      };
      if (body.model === "test-extraction-model") {
        // Skip summary calls — only track extraction calls
        const system = body.messages?.[0]?.content ?? "";
        if (system.includes("summarize what this conversation")) {
          return Response.json(openaiResponse("Test summary."));
        }
        extractionCallCount++;
        // First extraction blocks until released
        if (extractionCallCount === 1) {
          await new Promise<void>((resolve) => {
            resolveExtraction = resolve;
          });
        }
        // Capture the user content sent to the extraction model
        const userMsg = body.messages?.find((m) => m.role === "user");
        if (userMsg) {
          extractedContents.push(
            userMsg.content
              .split("\n")
              .filter((l: string) => l.startsWith("user:"))
              .map((l: string) => l.replace("user: ", "")),
          );
        }
        return Response.json(openaiResponse(JSON.stringify([])));
      }
      return Response.json(openaiResponse("ok"));
    };

    const config = {
      ...testConfig(),
      extractionModels: ["test-extraction-model"],
      extractionInterval: 1,
    };

    // Message A triggers extraction (blocks)
    const { eventId: idA } = ingestMessage({
      text: "Message A",
      topicKey: "topic-catchup",
    });
    const loop = startProcessingLoop(config, createEmptyRegistry(), FAST_LOOP);
    await waitFor(() => getInboxMessage(idA)?.status === "done");
    await waitFor(() => extractionCallCount >= 1);

    // Message B processed while A's extraction is in-flight
    await Bun.sleep(5);
    const { eventId: idB } = ingestMessage({
      text: "Message B",
      topicKey: "topic-catchup",
      externalMessageId: "msg-b-catchup",
    });
    await waitFor(() => getInboxMessage(idB)?.status === "done");

    // Release A's extraction so it completes
    resolveExtraction!();
    await Bun.sleep(300);

    // Message C arrives — should trigger extraction that picks up B+C
    await Bun.sleep(5);
    const { eventId: idC } = ingestMessage({
      text: "Message C",
      topicKey: "topic-catchup",
      externalMessageId: "msg-c-catchup",
    });
    await waitFor(() => getInboxMessage(idC)?.status === "done");
    await Bun.sleep(500);
    await loop.stop();

    // Second extraction should have been called and should include
    // Message B's content (not just C's)
    expect(extractionCallCount).toBeGreaterThanOrEqual(2);
    // The second extraction batch should contain Message B
    const secondBatch = extractedContents[1];
    expect(secondBatch).toBeDefined();
    expect(secondBatch).toContain("Message B");
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
      extractionModels: ["test-extraction-model"],
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

    const loop = startProcessingLoop(config, createEmptyRegistry(), FAST_LOOP);

    await waitFor(() => getInboxMessage(id2)?.status === "done");
    await Bun.sleep(200);
    await loop.stop();

    // Both messages processed successfully despite extraction failures
    expect(getInboxMessage(id1)?.status).toBe("done");
    expect(getInboxMessage(id2)?.status).toBe("done");

    const outbox = listOutboxMessagesByTopic("topic-ext-fail");
    expect(outbox).toHaveLength(2);
  });

  test("topic summary generated and injected into subsequent prompts", async () => {
    let conversationPrompts: Array<{
      messages: Array<{ role: string; content: string }>;
    }> = [];

    mockSynapseHandler = async (req) => {
      const body = (await req.json()) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
      };
      if (body.model === "test-extraction-model") {
        const system = body.messages?.[0]?.content ?? "";
        if (system.includes("summarize what this conversation")) {
          return Response.json(
            openaiResponse("Planning a vacation to Japan in spring."),
          );
        }
        // Extraction: return empty
        return Response.json(openaiResponse(JSON.stringify([])));
      }
      // Conversation model — capture the prompt
      conversationPrompts.push({ messages: body.messages });
      return Response.json(openaiResponse("Sounds great!"));
    };

    const config = {
      ...testConfig(),
      extractionModels: ["test-extraction-model"],
      extractionInterval: 1,
    };

    // Message 1: triggers extraction + summary generation
    const { eventId: id1 } = ingestMessage({
      text: "I want to visit Tokyo",
      topicKey: "topic-summary-e2e",
    });
    const loop = startProcessingLoop(config, createEmptyRegistry(), FAST_LOOP);
    await waitFor(() => getInboxMessage(id1)?.status === "done");
    // Wait for fire-and-forget extraction + summary to complete
    await waitFor(() => getTopicSummary("topic-summary-e2e") !== null);

    const cachedSummary = getTopicSummary("topic-summary-e2e");
    expect(cachedSummary).toBe("Planning a vacation to Japan in spring.");

    // Message 2: should have the summary in its prompt
    conversationPrompts = [];
    const { eventId: id2 } = ingestMessage({
      text: "What about hotels?",
      topicKey: "topic-summary-e2e",
      externalMessageId: "msg-2-summary",
    });
    await waitFor(() => getInboxMessage(id2)?.status === "done");
    await loop.stop();

    // The conversation prompt for message 2 should include the topic summary
    expect(conversationPrompts).toHaveLength(1);
    const systemMsg = conversationPrompts[0].messages[0];
    expect(systemMsg.role).toBe("system");
    expect(systemMsg.content).toContain("Current conversation context:");
    expect(systemMsg.content).toContain(
      "Planning a vacation to Japan in spring.",
    );
  });

  // --- Slice 8: Tool-calling loop integration test ---

  test("processes tool calls through the full agent loop", async () => {
    // Build a registry with a single stub tool
    const stubRegistry: SkillRegistry = {
      tools: [
        {
          name: "stub.greet",
          description: "Returns a greeting",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string" } },
          },
          mutatesState: false,
        },
      ],
      async executeTool(name, argumentsJson, _ctx) {
        const args = JSON.parse(argumentsJson);
        return ok({ content: `Hello, ${args.name}!` });
      },
      isMutating() {
        return false;
      },
    };

    let callNum = 0;
    mockSynapseHandler = async (req) => {
      const body = (await req.json()) as {
        messages: Array<{ role: string; content: string }>;
        tools?: unknown[];
      };
      callNum++;

      if (callNum === 1) {
        // First call: model requests a tool call
        return Response.json({
          id: "chat-tool-1",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_abc",
                    type: "function",
                    function: {
                      name: "stub.greet",
                      arguments: JSON.stringify({ name: "Watson" }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }

      // Second call: model produces final response (after seeing tool result)
      return Response.json(openaiResponse("The greeting is: Hello, Watson!"));
    };

    const { eventId } = ingestMessage({
      text: "Greet Watson",
      topicKey: "topic-tools",
    });
    const loop = startProcessingLoop(testConfig(), stubRegistry, FAST_LOOP);

    await waitFor(() => getInboxMessage(eventId)?.status === "done");
    await loop.stop();

    // Inbox done, outbox has response
    const inbox = getInboxMessage(eventId);
    expect(inbox?.status).toBe("done");
    expect(inbox?.error).toBeNull();

    const outbox = listOutboxMessagesByTopic("topic-tools");
    expect(outbox).toHaveLength(1);
    expect(outbox[0].text).toBe("The greeting is: Hello, Watson!");

    // Synapse called twice: once with tool_calls, once with final response
    expect(callNum).toBe(2);

    // Tool turns saved to history:
    // user + assistant(tool_calls) + tool(result) + assistant(final)
    const turns = loadRecentTurns("topic-tools");
    expect(turns.length).toBeGreaterThanOrEqual(4);

    // Check roles in order
    expect(turns[0].role).toBe("user");
    expect(turns[0].content).toBe("Greet Watson");

    expect(turns[1].role).toBe("assistant");
    expect(turns[1].tool_calls).not.toBeNull(); // has tool_calls JSON

    expect(turns[2].role).toBe("tool");
    expect(turns[2].content).toBe("Hello, Watson!");
    expect(turns[2].tool_call_id).toBe("call_abc");
    expect(turns[2].name).toBe("stub.greet");

    expect(turns[3].role).toBe("assistant");
    expect(turns[3].content).toBe("The greeting is: Hello, Watson!");
  });

  test("recovers inbox messages stuck in processing after restart", async () => {
    mockSynapseHandler = () => Response.json(openaiResponse("Recovered!"));

    // Use a temp file DB so data persists across re-init (simulates restart)
    const tmpDb = join(tmpdir(), `cortex-test-${crypto.randomUUID()}.db`);

    try {
      initDatabase(tmpDb);

      // Simulate a message stuck in 'processing' from a prior crash
      const { eventId } = ingestMessage({ text: "Stuck message" });
      getDatabase().exec(
        `UPDATE inbox_messages SET status = 'processing' WHERE id = '${eventId}'`,
      );
      expect(getInboxMessage(eventId)?.status).toBe("processing");

      // Re-init the database (simulates a restart) — should recover the message
      initDatabase(tmpDb);

      // The message should be back to 'pending'
      expect(getInboxMessage(eventId)?.status).toBe("pending");

      // Processing loop should pick it up and complete it
      const loop = startProcessingLoop(
        testConfig(),
        createEmptyRegistry(),
        FAST_LOOP,
      );

      await waitFor(() => getInboxMessage(eventId)?.status === "done");
      await loop.stop();

      expect(getInboxMessage(eventId)?.status).toBe("done");
      const outbox = listOutboxMessagesByTopic("topic-1");
      expect(outbox).toHaveLength(1);
      expect(outbox[0].text).toBe("Recovered!");
    } finally {
      closeDatabase();
      unlinkSync(tmpDb);
    }
  });
});

// --- isTransientError tests ---

describe("isTransientError", () => {
  test("matches 429 rate limit", () => {
    expect(isTransientError("Synapse returned 429: rate limited")).toBe(true);
  });

  test("matches 502 bad gateway", () => {
    expect(
      isTransientError("Synapse returned 502: All providers exhausted"),
    ).toBe(true);
  });

  test("matches 503 unavailable", () => {
    expect(isTransientError("Synapse returned 503: model unavailable")).toBe(
      true,
    );
  });

  test("matches 504 gateway timeout", () => {
    expect(isTransientError("Synapse returned 504: gateway timeout")).toBe(
      true,
    );
  });

  test("matches timeout errors", () => {
    expect(isTransientError("Synapse request timed out after 60000ms")).toBe(
      true,
    );
  });

  test("matches ECONNREFUSED", () => {
    expect(isTransientError("Synapse connection failed: ECONNREFUSED")).toBe(
      true,
    );
  });

  test("matches ECONNRESET", () => {
    expect(isTransientError("Synapse connection failed: ECONNRESET")).toBe(
      true,
    );
  });

  test("does not match 400 bad request", () => {
    expect(isTransientError("Synapse returned 400: bad request")).toBe(false);
  });

  test("does not match 401 unauthorized", () => {
    expect(isTransientError("Synapse returned 401: unauthorized")).toBe(false);
  });

  test("does not match parse errors", () => {
    expect(isTransientError("Synapse returned invalid JSON")).toBe(false);
  });

  test("does not match content errors", () => {
    expect(isTransientError("Synapse response has no content")).toBe(false);
  });
});

// --- retryInboxMessage tests ---

describe("retryInboxMessage", () => {
  beforeEach(() => {
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  test("schedules retry with exponential backoff", () => {
    const { eventId } = enqueueInboxMessage({
      channel: "test",
      externalMessageId: "msg-retry-1",
      topicKey: "topic-retry",
      userId: "user-1",
      text: "Will retry",
      occurredAt: Date.now(),
      idempotencyKey: "key-retry-1",
    });

    // Simulate the message being claimed (attempts = 1)
    const claimed = claimNextInboxMessage();
    expect(claimed).not.toBeNull();
    expect(claimed!.attempts).toBe(1);

    const beforeRetry = Date.now();
    retryInboxMessage(eventId, 1, 5, "Synapse returned 429: rate limited");

    const msg = getInboxMessage(eventId);
    expect(msg?.status).toBe("pending");
    expect(msg?.error).toContain("429");
    // Backoff for attempt 1: 2^0 * 5000 = 5000ms ±20% → [4000, 6000]
    expect(msg!.next_attempt_at).toBeGreaterThan(beforeRetry);
    expect(msg!.next_attempt_at - beforeRetry).toBeGreaterThanOrEqual(4000);
    expect(msg!.next_attempt_at - beforeRetry).toBeLessThanOrEqual(6000);
  });

  test("marks as permanently failed when max attempts reached", () => {
    const { eventId } = enqueueInboxMessage({
      channel: "test",
      externalMessageId: "msg-retry-max",
      topicKey: "topic-retry",
      userId: "user-1",
      text: "Will exhaust retries",
      occurredAt: Date.now(),
      idempotencyKey: "key-retry-max",
    });

    retryInboxMessage(eventId, 5, 5, "Synapse returned 502: upstream error");

    const msg = getInboxMessage(eventId);
    expect(msg?.status).toBe("failed");
    expect(msg?.error).toContain("502");
  });

  test("backoff caps at 15 minutes", () => {
    // At attempt 12: 2^11 * 5000 = 10_240_000 → cap to 900_000 (15min)
    const delay = computeBackoffDelay(12);
    // 900_000 * [0.8, 1.2] → [720_000, 1_080_000]
    expect(delay).toBeGreaterThanOrEqual(720_000);
    expect(delay).toBeLessThanOrEqual(1_080_000);
  });

  test("backoff increases exponentially", () => {
    // Run multiple samples to get averages and confirm order
    const samples = 50;
    let sum1 = 0;
    let sum3 = 0;
    for (let i = 0; i < samples; i++) {
      sum1 += computeBackoffDelay(1);
      sum3 += computeBackoffDelay(3);
    }
    const avg1 = sum1 / samples;
    const avg3 = sum3 / samples;
    // Attempt 1: ~5s, Attempt 3: ~20s — avg3 should be clearly larger
    expect(avg3).toBeGreaterThan(avg1 * 2);
  });
});

// --- claimNextInboxMessage + next_attempt_at tests ---

describe("claimNextInboxMessage with next_attempt_at", () => {
  beforeEach(() => {
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  test("skips messages with future next_attempt_at", () => {
    const { eventId } = enqueueInboxMessage({
      channel: "test",
      externalMessageId: "msg-future",
      topicKey: "topic-future",
      userId: "user-1",
      text: "Future retry",
      occurredAt: Date.now(),
      idempotencyKey: "key-future",
    });

    // Set next_attempt_at far in the future
    const futureTime = Date.now() + 60_000;
    getDatabase().exec(
      `UPDATE inbox_messages SET next_attempt_at = ${futureTime} WHERE id = '${eventId}'`,
    );

    // Claim should return null — message isn't ready yet
    const claimed = claimNextInboxMessage();
    expect(claimed).toBeNull();
  });

  test("claims messages with past next_attempt_at", () => {
    const { eventId } = enqueueInboxMessage({
      channel: "test",
      externalMessageId: "msg-past",
      topicKey: "topic-past",
      userId: "user-1",
      text: "Past retry",
      occurredAt: Date.now(),
      idempotencyKey: "key-past",
    });

    // Set next_attempt_at in the past (simulates backoff elapsed)
    const pastTime = Date.now() - 1000;
    getDatabase().exec(
      `UPDATE inbox_messages SET next_attempt_at = ${pastTime} WHERE id = '${eventId}'`,
    );

    const claimed = claimNextInboxMessage();
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(eventId);
  });

  test("claims messages with default next_attempt_at = 0", () => {
    enqueueInboxMessage({
      channel: "test",
      externalMessageId: "msg-default",
      topicKey: "topic-default",
      userId: "user-1",
      text: "Default retry",
      occurredAt: Date.now(),
      idempotencyKey: "key-default",
    });

    // Default next_attempt_at is 0 — should be immediately claimable
    const claimed = claimNextInboxMessage();
    expect(claimed).not.toBeNull();
    expect(claimed!.text).toBe("Default retry");
  });
});
