import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { StateLoader } from "@shetty4l/core/state";
import type { CortexConfig } from "../src/config";
import { closeDatabase, getDatabase, initDatabase } from "../src/db";
import { maybeExtract, trimToBudget } from "../src/extraction";
import { ExtractionCursorState, TopicSummaryState } from "../src/state";
import { loadTurnsSinceCursor, saveAgentTurns, saveTurn } from "../src/turns";

// --- Mock Synapse server (extraction model) ---

let mockSynapse: ReturnType<typeof Bun.serve>;
let mockSynapseUrl: string;
let mockSynapseHandler: (req: Request) => Response | Promise<Response>;

beforeAll(() => {
  mockSynapseHandler = () =>
    Response.json({ error: "no mock configured" }, { status: 500 });

  mockSynapse = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      return mockSynapseHandler(req);
    },
  });

  mockSynapseUrl = `http://127.0.0.1:${mockSynapse.port}`;
});

// --- Mock Engram server ---

let mockEngram: ReturnType<typeof Bun.serve>;
let mockEngramUrl: string;
let mockEngramHandler: (req: Request) => Response | Promise<Response>;
let engramRememberCalls: Array<Record<string, unknown>>;
let engramSummaryCalls: Array<Record<string, unknown>>;
let engramRecallCalls: Array<Record<string, unknown>>;
let defaultEngramHandler: (req: Request) => Response | Promise<Response>;

beforeAll(() => {
  engramRememberCalls = [];
  engramSummaryCalls = [];
  engramRecallCalls = [];

  defaultEngramHandler = async (req) => {
    const path = new URL(req.url).pathname;
    const body = (await req.json()) as Record<string, unknown>;

    if (path === "/remember") {
      if (body.category === "summary") {
        engramSummaryCalls.push(body);
      } else {
        engramRememberCalls.push(body);
      }
      return Response.json({
        id: `mem_${crypto.randomUUID().slice(0, 8)}`,
        status: "created",
      });
    }

    if (path === "/recall") {
      engramRecallCalls.push(body);
      return Response.json({ memories: [], fallback_mode: false });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  };

  mockEngramHandler = defaultEngramHandler;

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

// --- StateLoader helper functions ---

function getExtractionCursor(topicKey: string) {
  const state = stateLoader.load(ExtractionCursorState, topicKey);
  return {
    topic_key: topicKey,
    last_extracted_rowid: state.lastExtractedRowid,
    turns_since_extraction: state.turnsSinceExtraction,
  };
}

async function incrementTurnsSinceExtraction(topicKey: string) {
  const state = stateLoader.load(ExtractionCursorState, topicKey);
  state.turnsSinceExtraction += 1;
  await stateLoader.flush();
}

async function advanceExtractionCursor(topicKey: string, lastRowid: number) {
  const state = stateLoader.load(ExtractionCursorState, topicKey);
  state.lastExtractedRowid = lastRowid;
  state.turnsSinceExtraction = 0;
  await stateLoader.flush();
}

function getTopicSummary(topicKey: string): string | null {
  const state = stateLoader.load(TopicSummaryState, topicKey);
  return state.summary;
}

// --- Test config ---

let stateLoader: StateLoader;

function testConfig(overrides?: Partial<CortexConfig>): CortexConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    ingestApiKey: "test-key",
    synapseUrl: mockSynapseUrl,
    engramUrl: mockEngramUrl,
    models: ["test-model"],
    extractionModels: ["test-extraction-model"],
    extractionInterval: 3,
    activeWindowSize: 10,
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
    ...overrides,
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

function extractionResponse(
  facts: Array<{ content: string; category: string }>,
) {
  return openaiResponse(JSON.stringify(facts));
}

/** Save N turn pairs (does not touch extraction cursor). */
async function seedTurns(topicKey: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await saveTurn(stateLoader, {
      topicKey,
      role: "user",
      content: `User message ${i + 1}`,
    });
    await saveTurn(stateLoader, {
      topicKey,
      role: "assistant",
      content: `Assistant reply ${i + 1}`,
    });
  }
}

/**
 * Simulate a processed message: increment the turn counter then run extraction.
 * This mirrors what loop.ts does — increment is in the loop, not inside maybeExtract.
 */
async function processAndExtract(
  topicKey: string,
  config: CortexConfig,
): Promise<void> {
  if (config.extractionModels) {
    await incrementTurnsSinceExtraction(topicKey);
  }
  await maybeExtract(topicKey, config, stateLoader);
  // Flush to ensure cursor changes are persisted before tests read them back
  await stateLoader.flush();
}

/**
 * Create a mock Synapse handler that returns facts for extraction prompts
 * and a generic summary for summary prompts.
 */
function mockSynapseWithFacts(
  facts: Array<{ content: string; category: string }>,
) {
  return async (req: Request) => {
    const body = (await req.json()) as {
      messages?: Array<{ content: string }>;
    };
    const system = body.messages?.[0]?.content ?? "";
    if (system.includes("summarize what this conversation")) {
      return Response.json(openaiResponse("Test summary."));
    }
    return Response.json(extractionResponse(facts));
  };
}

// --- Tests ---

describe("extraction cursors (DB)", () => {
  beforeEach(() => {
    initDatabase(":memory:");
    stateLoader = new StateLoader(getDatabase());
  });

  afterEach(async () => {
    await stateLoader.flush();
    closeDatabase();
  });

  test("getExtractionCursor returns defaults for new topic", () => {
    const cursor = getExtractionCursor("unknown-topic");
    expect(cursor.last_extracted_rowid).toBe(0);
    expect(cursor.turns_since_extraction).toBe(0);
  });

  test("incrementTurnsSinceExtraction increments counter", async () => {
    await incrementTurnsSinceExtraction("topic-1");
    const cursor = getExtractionCursor("topic-1");

    expect(cursor.last_extracted_rowid).toBe(0);
    expect(cursor.turns_since_extraction).toBe(1);
  });

  test("incrementTurnsSinceExtraction increments on subsequent calls", async () => {
    await incrementTurnsSinceExtraction("topic-1");
    await incrementTurnsSinceExtraction("topic-1");
    await incrementTurnsSinceExtraction("topic-1");

    const cursor = getExtractionCursor("topic-1");
    expect(cursor.turns_since_extraction).toBe(3);
  });

  test("advanceExtractionCursor resets counter", async () => {
    await incrementTurnsSinceExtraction("topic-1");
    await incrementTurnsSinceExtraction("topic-1");
    await incrementTurnsSinceExtraction("topic-1");

    await advanceExtractionCursor("topic-1", 42);

    const cursor = getExtractionCursor("topic-1");
    expect(cursor.last_extracted_rowid).toBe(42);
    expect(cursor.turns_since_extraction).toBe(0);
  });

  test("loadTurnsSinceCursor returns turns after seq", async () => {
    await saveTurn(stateLoader, {
      topicKey: "topic-1",
      role: "user",
      content: "Old message",
    });
    await saveTurn(stateLoader, {
      topicKey: "topic-1",
      role: "assistant",
      content: "Old reply",
    });

    // Get the seq of the last old turn
    const oldTurns = loadTurnsSinceCursor(stateLoader, "topic-1", 0);
    const lastOldSeq = oldTurns[oldTurns.length - 1].seq;

    await saveTurn(stateLoader, {
      topicKey: "topic-1",
      role: "user",
      content: "New message",
    });
    await saveTurn(stateLoader, {
      topicKey: "topic-1",
      role: "assistant",
      content: "New reply",
    });

    const newTurns = loadTurnsSinceCursor(stateLoader, "topic-1", lastOldSeq);
    expect(newTurns).toHaveLength(2);
    expect(newTurns[0].content).toBe("New message");
    expect(newTurns[1].content).toBe("New reply");
  });

  test("loadTurnsSinceCursor returns empty when no turns after cursor", async () => {
    await saveTurn(stateLoader, {
      topicKey: "topic-1",
      role: "user",
      content: "A message",
    });
    const turns = loadTurnsSinceCursor(stateLoader, "topic-1", 0);
    const lastSeq = turns[turns.length - 1].seq;

    const newTurns = loadTurnsSinceCursor(stateLoader, "topic-1", lastSeq);
    expect(newTurns).toHaveLength(0);
  });

  test("loadTurnsSinceCursor isolates by topic", async () => {
    await saveTurn(stateLoader, {
      topicKey: "topic-a",
      role: "user",
      content: "Topic A message",
    });
    await saveTurn(stateLoader, {
      topicKey: "topic-b",
      role: "user",
      content: "Topic B message",
    });

    const turnsA = loadTurnsSinceCursor(stateLoader, "topic-a", 0);
    expect(turnsA).toHaveLength(1);
    expect(turnsA[0].content).toBe("Topic A message");
  });
});

describe("maybeExtract", () => {
  beforeEach(() => {
    initDatabase(":memory:");
    stateLoader = new StateLoader(getDatabase());
    engramRememberCalls = [];
    engramSummaryCalls = [];
    engramRecallCalls = [];
    mockEngramHandler = defaultEngramHandler;
    // Default: return empty extraction for fact prompts, summary for summary prompts
    mockSynapseHandler = async (req) => {
      const body = (await req.json()) as {
        messages?: Array<{ content: string }>;
      };
      const system = body.messages?.[0]?.content ?? "";
      if (system.includes("summarize what this conversation")) {
        return Response.json(openaiResponse("Test summary."));
      }
      return Response.json(extractionResponse([]));
    };
  });

  afterEach(async () => {
    await stateLoader.flush();
    closeDatabase();
  });

  test("skipped when extractionModel is undefined", async () => {
    const config = testConfig({ extractionModels: undefined });
    seedTurns("topic-1", 5);

    await maybeExtract("topic-1", config, stateLoader);

    // Cursor not touched when extraction disabled, stays at defaults
    const cursor = getExtractionCursor("topic-1");
    expect(cursor.turns_since_extraction).toBe(0);
    expect(cursor.last_extracted_rowid).toBe(0);
    expect(engramRememberCalls).toHaveLength(0);
  });

  test("skipped when turns < extractionInterval", async () => {
    const config = testConfig({ extractionInterval: 3 });
    seedTurns("topic-1", 1);

    // Simulate 1 turn processed (loop increments counter, then calls maybeExtract)
    await processAndExtract("topic-1", config);

    const cursor = getExtractionCursor("topic-1");
    expect(cursor.turns_since_extraction).toBe(1);
    expect(engramRememberCalls).toHaveLength(0);
  });

  test("triggers at exactly extractionInterval turns", async () => {
    const config = testConfig({ extractionInterval: 3 });
    seedTurns("topic-1", 3);

    mockSynapseHandler = mockSynapseWithFacts([
      { content: "User likes TypeScript", category: "preference" },
    ]);

    // Simulate 3 turns processed
    await processAndExtract("topic-1", config);
    await processAndExtract("topic-1", config);
    await processAndExtract("topic-1", config);

    // Should have triggered extraction on the 3rd call
    expect(engramRememberCalls).toHaveLength(1);
    expect(engramRememberCalls[0].content).toBe("User likes TypeScript");
  });

  test("stores facts with correct category, scope, and upsert", async () => {
    const config = testConfig({ extractionInterval: 1 });
    seedTurns("my-topic", 1);

    mockSynapseHandler = mockSynapseWithFacts([
      { content: "User lives in Seattle", category: "fact" },
      { content: "User prefers dark mode", category: "preference" },
    ]);

    await processAndExtract("my-topic", config);

    expect(engramRememberCalls).toHaveLength(2);

    // First fact
    expect(engramRememberCalls[0].content).toBe("User lives in Seattle");
    expect(engramRememberCalls[0].category).toBe("fact");
    expect(engramRememberCalls[0].scope_id).toBe("my-topic");
    expect(engramRememberCalls[0].upsert).toBe(true);
    expect(engramRememberCalls[0].idempotency_key).toMatch(
      /^cortex:extract:[a-f0-9]{16}$/,
    );

    // Second fact
    expect(engramRememberCalls[1].content).toBe("User prefers dark mode");
    expect(engramRememberCalls[1].category).toBe("preference");
  });

  test("idempotency keys are deterministic", async () => {
    const config = testConfig({ extractionInterval: 1 });
    seedTurns("topic-1", 1);

    mockSynapseHandler = mockSynapseWithFacts([
      { content: "User likes coffee", category: "preference" },
    ]);

    await processAndExtract("topic-1", config);
    const firstKey = engramRememberCalls[0].idempotency_key;

    // Reset cursor to force re-extraction of same turns
    engramRememberCalls = [];
    await advanceExtractionCursor("topic-1", 0);

    // Add another turn to trigger extraction again
    seedTurns("topic-1", 1);
    await processAndExtract("topic-1", config);

    // Same content + topic + category should produce same key
    const secondKey = engramRememberCalls[0].idempotency_key;
    expect(secondKey).toBe(firstKey);
  });

  test("cursor advances after successful extraction", async () => {
    const config = testConfig({ extractionInterval: 1 });
    seedTurns("topic-1", 2);

    mockSynapseHandler = mockSynapseWithFacts([
      { content: "Some fact", category: "fact" },
    ]);

    await processAndExtract("topic-1", config);

    const cursor = getExtractionCursor("topic-1");
    expect(cursor.turns_since_extraction).toBe(0);
    expect(cursor.last_extracted_rowid).toBeGreaterThan(0);
  });

  test("cursor does NOT advance on model call failure", async () => {
    const config = testConfig({ extractionInterval: 1 });
    seedTurns("topic-1", 1);

    mockSynapseHandler = () =>
      Response.json(
        { error: { message: "boom", type: "server_error" } },
        { status: 500 },
      );

    await processAndExtract("topic-1", config);

    const cursor = getExtractionCursor("topic-1");
    // Counter was incremented but cursor NOT advanced
    expect(cursor.turns_since_extraction).toBe(1);
    expect(cursor.last_extracted_rowid).toBe(0);
  });

  test("cursor does NOT advance on malformed JSON response", async () => {
    const config = testConfig({ extractionInterval: 1 });
    seedTurns("topic-1", 1);

    mockSynapseHandler = () =>
      Response.json(
        openaiResponse("Here are some thoughts about the conversation..."),
      );

    await processAndExtract("topic-1", config);

    const cursor = getExtractionCursor("topic-1");
    expect(cursor.turns_since_extraction).toBe(1);
    expect(cursor.last_extracted_rowid).toBe(0);
  });

  test("cursor advances even if all remember calls fail", async () => {
    const config = testConfig({ extractionInterval: 1 });
    seedTurns("topic-1", 1);

    mockSynapseHandler = mockSynapseWithFacts([
      { content: "A fact", category: "fact" },
    ]);

    // Make Engram remember fail
    const originalHandler = mockEngramHandler;
    mockEngramHandler = async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/remember") {
        return Response.json({ error: "boom" }, { status: 500 });
      }
      return originalHandler(req);
    };

    await processAndExtract("topic-1", config);

    const cursor = getExtractionCursor("topic-1");
    // Cursor advanced despite remember failure (upsert makes re-extraction safe)
    expect(cursor.turns_since_extraction).toBe(0);
    expect(cursor.last_extracted_rowid).toBeGreaterThan(0);
  });

  test("empty extraction result advances cursor", async () => {
    const config = testConfig({ extractionInterval: 1 });
    seedTurns("topic-1", 1);

    // Default handler returns [] for extraction, "Test summary." for summary
    await processAndExtract("topic-1", config);

    const cursor = getExtractionCursor("topic-1");
    expect(cursor.turns_since_extraction).toBe(0);
    expect(cursor.last_extracted_rowid).toBeGreaterThan(0);
    // No fact remember calls, but summary is stored
    expect(engramRememberCalls).toHaveLength(0);
    expect(engramSummaryCalls).toHaveLength(1);
  });

  test("existing memories passed into extraction prompt for dedup", async () => {
    const config = testConfig({ extractionInterval: 1 });
    seedTurns("topic-1", 1);

    let capturedSynapseBody: {
      messages?: Array<{ role: string; content: string }>;
    } = {};

    // Return existing memories from Engram recall
    mockEngramHandler = async (req) => {
      const path = new URL(req.url).pathname;
      const body = (await req.json()) as Record<string, unknown>;

      if (path === "/recall") {
        engramRecallCalls.push(body);
        return Response.json({
          memories: [
            {
              id: "m1",
              content: "User lives in Seattle",
              category: "fact",
              strength: 1,
              relevance: 0.9,
            },
          ],
          fallback_mode: false,
        });
      }

      if (path === "/remember") {
        if (body.category === "summary") {
          engramSummaryCalls.push(body);
        } else {
          engramRememberCalls.push(body);
        }
        return Response.json({ id: "mem-1", status: "created" });
      }

      return Response.json({ error: "not found" }, { status: 404 });
    };

    mockSynapseHandler = async (req) => {
      const body = (await req.json()) as typeof capturedSynapseBody;
      const system = body.messages?.[0]?.content ?? "";
      if (system.includes("summarize what this conversation")) {
        return Response.json(openaiResponse("Test summary."));
      }
      capturedSynapseBody = body;
      return Response.json(extractionResponse([]));
    };

    await processAndExtract("topic-1", config);

    // System prompt should contain existing memory for dedup
    const systemMsg = capturedSynapseBody.messages?.[0];
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain("User lives in Seattle");
    expect(systemMsg!.content).toContain("do NOT repeat");
  });

  test("multiple extraction cycles work correctly", async () => {
    const config = testConfig({ extractionInterval: 1 });

    // Cycle 1
    seedTurns("topic-1", 1);
    mockSynapseHandler = mockSynapseWithFacts([
      { content: "Fact from cycle 1", category: "fact" },
    ]);

    await processAndExtract("topic-1", config);
    expect(engramRememberCalls).toHaveLength(1);
    expect(engramRememberCalls[0].content).toBe("Fact from cycle 1");

    const cursor1 = getExtractionCursor("topic-1");
    expect(cursor1!.turns_since_extraction).toBe(0);

    // Cycle 2 — more turns
    engramRememberCalls = [];
    seedTurns("topic-1", 1);
    mockSynapseHandler = mockSynapseWithFacts([
      { content: "Fact from cycle 2", category: "decision" },
    ]);

    await processAndExtract("topic-1", config);
    expect(engramRememberCalls).toHaveLength(1);
    expect(engramRememberCalls[0].content).toBe("Fact from cycle 2");

    const cursor2 = getExtractionCursor("topic-1");
    expect(cursor2!.last_extracted_rowid).toBeGreaterThan(
      cursor1!.last_extracted_rowid,
    );
  });

  test("caps facts at MAX_FACTS_PER_RUN (10)", async () => {
    const config = testConfig({ extractionInterval: 1 });
    seedTurns("topic-1", 1);

    // Return 15 facts (exceeds cap)
    const manyFacts = Array.from({ length: 15 }, (_, i) => ({
      content: `Fact number ${i + 1} extracted`,
      category: "fact",
    }));

    mockSynapseHandler = async (req: Request) => {
      const body = (await req.json()) as {
        messages?: Array<{ content: string }>;
      };
      const system = body.messages?.[0]?.content ?? "";
      if (system.includes("summarize what this conversation")) {
        return Response.json(openaiResponse("Test summary."));
      }
      return Response.json(extractionResponse(manyFacts));
    };

    await processAndExtract("topic-1", config);

    // Should cap at 10
    expect(engramRememberCalls).toHaveLength(10);
  });

  test("filters out invalid categories", async () => {
    const config = testConfig({ extractionInterval: 1 });
    seedTurns("topic-1", 1);

    mockSynapseHandler = mockSynapseWithFacts([
      { content: "Valid fact", category: "fact" },
      { content: "Invalid category", category: "opinion" },
      { content: "Valid preference", category: "preference" },
    ]);

    await processAndExtract("topic-1", config);

    // Only valid categories stored
    expect(engramRememberCalls).toHaveLength(2);
    expect(engramRememberCalls[0].content).toBe("Valid fact");
    expect(engramRememberCalls[1].content).toBe("Valid preference");
  });

  test("handles markdown-wrapped JSON in model response", async () => {
    const config = testConfig({ extractionInterval: 1 });
    seedTurns("topic-1", 1);

    const wrappedResponse =
      "Here are the extracted facts:\n```json\n" +
      JSON.stringify([{ content: "User is a developer", category: "fact" }]) +
      "\n```";

    mockSynapseHandler = async (req: Request) => {
      const body = (await req.json()) as {
        messages?: Array<{ content: string }>;
      };
      const system = body.messages?.[0]?.content ?? "";
      if (system.includes("summarize what this conversation")) {
        return Response.json(openaiResponse("Test summary."));
      }
      return Response.json(openaiResponse(wrappedResponse));
    };

    await processAndExtract("topic-1", config);

    expect(engramRememberCalls).toHaveLength(1);
    expect(engramRememberCalls[0].content).toBe("User is a developer");
  });

  test("filters out tool and intermediate assistant messages from extraction", async () => {
    const config = testConfig({ extractionInterval: 1 });

    // Save an agent loop with tool calls (user → assistant+tool_calls → tool → final assistant)
    await saveAgentTurns(stateLoader, "topic-tool", [
      { role: "user", content: "What is 2+2?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "math.add", arguments: '{"a":2,"b":2}' },
          },
        ],
      },
      { role: "tool", content: "4", tool_call_id: "c1", name: "math.add" },
      { role: "assistant", content: "2+2 equals 4." },
    ]);

    let capturedUserContent = "";
    mockSynapseHandler = async (req: Request) => {
      const body = (await req.json()) as {
        messages?: Array<{ role: string; content: string }>;
      };
      const system = body.messages?.[0]?.content ?? "";
      if (system.includes("summarize what this conversation")) {
        return Response.json(openaiResponse("Math conversation."));
      }
      // Capture what turns were sent to the extraction model
      capturedUserContent = body.messages?.[1]?.content ?? "";
      return Response.json(extractionResponse([]));
    };

    await processAndExtract("topic-tool", config);

    // Only user messages and final assistant responses (no tool_calls)
    // should appear in the extraction prompt
    expect(capturedUserContent).toContain("user: What is 2+2?");
    expect(capturedUserContent).toContain("assistant: 2+2 equals 4.");
    // Tool messages and intermediate assistant messages should NOT appear
    expect(capturedUserContent).not.toContain("tool:");
    expect(capturedUserContent).not.toContain("assistant: \n"); // empty content from tool-calling assistant
  });
});

describe("trimToBudget", () => {
  test("returns all turns when within budget", () => {
    const turns = [
      { content: "short", rowid: 1 },
      { content: "also short", rowid: 2 },
    ];
    const result = trimToBudget(turns, 1000);
    expect(result).toHaveLength(2);
  });

  test("trims turns that exceed budget", () => {
    const turns = [
      { content: "a".repeat(100), rowid: 1 },
      { content: "b".repeat(100), rowid: 2 },
      { content: "c".repeat(100), rowid: 3 },
    ];
    // Budget of 150 fits turn 1 (100 chars) but overflows on turn 2 (200 total)
    const result = trimToBudget(turns, 150);
    expect(result).toHaveLength(1);
    expect(result[0].rowid).toBe(1);
  });

  test("always includes at least one turn even if it exceeds budget", () => {
    const turns = [
      { content: "x".repeat(10_000), rowid: 1 },
      { content: "short", rowid: 2 },
    ];
    const result = trimToBudget(turns, 100);
    expect(result).toHaveLength(1);
    expect(result[0].rowid).toBe(1);
  });

  test("returns empty array for empty input", () => {
    const result = trimToBudget([], 1000);
    expect(result).toHaveLength(0);
  });

  test("trims at exact budget boundary", () => {
    const turns = [
      { content: "a".repeat(50), rowid: 1 },
      { content: "b".repeat(50), rowid: 2 },
      { content: "c".repeat(1), rowid: 3 },
    ];
    // Budget of 100: turn 1 (50) + turn 2 (100) = exactly at boundary
    // turn 3 would push to 101 > 100, so it's excluded
    const result = trimToBudget(turns, 100);
    expect(result).toHaveLength(2);
  });
});

describe("maybeExtract with oversized batches", () => {
  beforeEach(() => {
    initDatabase(":memory:");
    stateLoader = new StateLoader(getDatabase());
    engramRememberCalls = [];
    engramSummaryCalls = [];
    engramRecallCalls = [];
    mockEngramHandler = defaultEngramHandler;
  });

  afterEach(async () => {
    await stateLoader.flush();
    closeDatabase();
  });

  test("splits oversized backlog across multiple drain iterations", async () => {
    const config = testConfig({ extractionInterval: 1 });
    let extractionCalls = 0;

    // Seed many turns with large content to exceed MAX_EXTRACTION_CHARS (50k)
    // Each turn pair is ~6k chars, so 10 pairs = ~60k chars (exceeds 50k budget)
    for (let i = 0; i < 10; i++) {
      await saveTurn(stateLoader, {
        topicKey: "topic-1",
        role: "user",
        content: `Message ${i + 1}: ${"x".repeat(3000)}`,
      });
      await saveTurn(stateLoader, {
        topicKey: "topic-1",
        role: "assistant",
        content: `Reply ${i + 1}: ${"y".repeat(3000)}`,
      });
    }

    mockSynapseHandler = async (req: Request) => {
      const body = (await req.json()) as {
        messages?: Array<{ content: string }>;
      };
      const system = body.messages?.[0]?.content ?? "";
      if (system.includes("summarize what this conversation")) {
        return Response.json(openaiResponse("Test summary."));
      }
      extractionCalls++;
      return Response.json(extractionResponse([]));
    };

    await processAndExtract("topic-1", config);

    // Should have required multiple extraction model calls (batches)
    // because the total content exceeds the character budget
    expect(extractionCalls).toBeGreaterThanOrEqual(2);

    // Cursor should be fully advanced (all turns processed)
    const cursor = getExtractionCursor("topic-1");
    expect(cursor.turns_since_extraction).toBe(0);

    // Verify all turns are behind the cursor
    const remaining = loadTurnsSinceCursor(
      stateLoader,
      "topic-1",
      cursor.last_extracted_rowid,
    );
    expect(remaining).toHaveLength(0);
  });
});

describe("topic summary generation", () => {
  beforeEach(() => {
    initDatabase(":memory:");
    stateLoader = new StateLoader(getDatabase());
    engramRememberCalls = [];
    engramSummaryCalls = [];
    engramRecallCalls = [];
    mockEngramHandler = defaultEngramHandler;
    mockSynapseHandler = async (req) => {
      const body = (await req.json()) as {
        messages?: Array<{ content: string }>;
      };
      const system = body.messages?.[0]?.content ?? "";
      if (system.includes("summarize what this conversation")) {
        return Response.json(openaiResponse("Planning a trip to Japan."));
      }
      return Response.json(extractionResponse([]));
    };
  });

  afterEach(async () => {
    await stateLoader.flush();
    closeDatabase();
  });

  test("generates topic summary after extraction", async () => {
    const config = testConfig({ extractionInterval: 1 });
    seedTurns("topic-1", 1);

    await processAndExtract("topic-1", config);

    // Summary stored in local SQLite cache
    const cached = getTopicSummary("topic-1");
    expect(cached).toBe("Planning a trip to Japan.");

    // Summary stored in Engram
    expect(engramSummaryCalls).toHaveLength(1);
    expect(engramSummaryCalls[0].content).toBe("Planning a trip to Japan.");
    expect(engramSummaryCalls[0].category).toBe("summary");
    expect(engramSummaryCalls[0].scope_id).toBe("topic-1");
    expect(engramSummaryCalls[0].idempotency_key).toBe("topic-summary:topic-1");
    expect(engramSummaryCalls[0].upsert).toBe(true);
  });

  test("passes previous summary into the summary prompt", async () => {
    const config = testConfig({ extractionInterval: 1 });
    let capturedSummaryPrompt = "";

    mockSynapseHandler = async (req) => {
      const body = (await req.json()) as {
        messages?: Array<{ content: string }>;
      };
      const system = body.messages?.[0]?.content ?? "";
      if (system.includes("summarize what this conversation")) {
        capturedSummaryPrompt = system;
        return Response.json(openaiResponse("Updated summary."));
      }
      return Response.json(extractionResponse([]));
    };

    // Cycle 1: seed initial summary
    seedTurns("topic-1", 1);
    await processAndExtract("topic-1", config);
    expect(getTopicSummary("topic-1")).toBe("Updated summary.");

    // Cycle 2: previous summary should appear in prompt
    capturedSummaryPrompt = "";
    seedTurns("topic-1", 1);
    await processAndExtract("topic-1", config);

    expect(capturedSummaryPrompt).toContain("Previous summary:");
    expect(capturedSummaryPrompt).toContain("Updated summary.");
  });

  test("no summary for new conversation (no previous summary)", async () => {
    const config = testConfig({ extractionInterval: 1 });
    let capturedSummaryPrompt = "";

    mockSynapseHandler = async (req) => {
      const body = (await req.json()) as {
        messages?: Array<{ content: string }>;
      };
      const system = body.messages?.[0]?.content ?? "";
      if (system.includes("summarize what this conversation")) {
        capturedSummaryPrompt = system;
        return Response.json(openaiResponse("New conversation summary."));
      }
      return Response.json(extractionResponse([]));
    };

    seedTurns("topic-1", 1);
    await processAndExtract("topic-1", config);

    // No "Previous summary:" in prompt for first extraction
    expect(capturedSummaryPrompt).not.toContain("Previous summary:");
  });

  test("summary failure does not block extraction", async () => {
    const config = testConfig({ extractionInterval: 1 });
    seedTurns("topic-1", 1);

    mockSynapseHandler = async (req) => {
      const body = (await req.json()) as {
        messages?: Array<{ content: string }>;
      };
      const system = body.messages?.[0]?.content ?? "";
      if (system.includes("summarize what this conversation")) {
        return Response.json(
          { error: { message: "summary boom", type: "server_error" } },
          { status: 500 },
        );
      }
      return Response.json(
        extractionResponse([{ content: "A fact", category: "fact" }]),
      );
    };

    await processAndExtract("topic-1", config);

    // Fact was still extracted despite summary failure
    expect(engramRememberCalls).toHaveLength(1);
    expect(engramRememberCalls[0].content).toBe("A fact");

    // No summary cached
    expect(getTopicSummary("topic-1")).toBeNull();

    // Cursor still advanced
    const cursor = getExtractionCursor("topic-1");
    expect(cursor.turns_since_extraction).toBe(0);
  });

  test("summary not generated when extraction fails", async () => {
    const config = testConfig({ extractionInterval: 1 });
    seedTurns("topic-1", 1);

    // All Synapse calls fail
    mockSynapseHandler = () =>
      Response.json(
        { error: { message: "boom", type: "server_error" } },
        { status: 500 },
      );

    await processAndExtract("topic-1", config);

    // No summary generated (extraction failed, lastBatchTurns is empty)
    expect(getTopicSummary("topic-1")).toBeNull();
    expect(engramSummaryCalls).toHaveLength(0);
  });

  test("topic summary upserts on subsequent cycles", async () => {
    const config = testConfig({ extractionInterval: 1 });
    let callCount = 0;

    mockSynapseHandler = async (req) => {
      const body = (await req.json()) as {
        messages?: Array<{ content: string }>;
      };
      const system = body.messages?.[0]?.content ?? "";
      if (system.includes("summarize what this conversation")) {
        callCount++;
        return Response.json(openaiResponse(`Summary version ${callCount}.`));
      }
      return Response.json(extractionResponse([]));
    };

    // Cycle 1
    seedTurns("topic-1", 1);
    await processAndExtract("topic-1", config);
    expect(getTopicSummary("topic-1")).toBe("Summary version 1.");

    // Cycle 2 — summary should be overwritten
    seedTurns("topic-1", 1);
    await processAndExtract("topic-1", config);
    expect(getTopicSummary("topic-1")).toBe("Summary version 2.");
  });

  test("summary includes recent turns in the prompt", async () => {
    const config = testConfig({ extractionInterval: 1 });
    let capturedUserContent = "";

    mockSynapseHandler = async (req) => {
      const body = (await req.json()) as {
        messages?: Array<{ role: string; content: string }>;
      };
      const system = body.messages?.[0]?.content ?? "";
      if (system.includes("summarize what this conversation")) {
        capturedUserContent = body.messages?.[1]?.content ?? "";
        return Response.json(openaiResponse("Test summary."));
      }
      return Response.json(extractionResponse([]));
    };

    await saveTurn(stateLoader, {
      topicKey: "topic-1",
      role: "user",
      content: "I want to plan a trip to Japan",
    });
    await saveTurn(stateLoader, {
      topicKey: "topic-1",
      role: "assistant",
      content: "Great! When are you thinking of going?",
    });

    await processAndExtract("topic-1", config);

    expect(capturedUserContent).toContain("plan a trip to Japan");
    expect(capturedUserContent).toContain("When are you thinking");
  });
});
