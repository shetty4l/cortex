import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  claimNextInboxMessage,
  closeDatabase,
  getDatabase,
  getReceptorCursor,
  getUnprocessedBuffers,
  initDatabase,
  insertReceptorBuffer,
} from "../src/db";
import {
  type ReceivePayload,
  Thalamus,
  type ThalamusConfig,
} from "../src/thalamus";

function makePayload(overrides?: Partial<ReceivePayload>): ReceivePayload {
  return {
    channel: "telegram",
    externalId: `ext-${crypto.randomUUID()}`,
    data: { text: "Hello world", topicKey: "my-topic", userId: "user-1" },
    occurredAt: "2026-02-15T20:30:00Z",
    ...overrides,
  };
}

describe("thalamus.receive()", () => {
  let thalamus: Thalamus;

  beforeEach(() => {
    initDatabase(":memory:");
    thalamus = new Thalamus();
  });

  afterEach(() => {
    closeDatabase();
  });

  // --- Priority tests ---

  test("assigns priority 0 for telegram channel", () => {
    const result = thalamus.receive(makePayload({ channel: "telegram" }));
    expect(result.duplicate).toBe(false);

    const db = getDatabase();
    const row = db
      .prepare("SELECT priority FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { priority: number };
    expect(row.priority).toBe(0);
  });

  test("assigns priority 0 for cli channel", () => {
    const result = thalamus.receive(makePayload({ channel: "cli" }));

    const db = getDatabase();
    const row = db
      .prepare("SELECT priority FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { priority: number };
    expect(row.priority).toBe(0);
  });

  test("assigns priority 2 for calendar channel", () => {
    const result = thalamus.receive(makePayload({ channel: "calendar" }));

    const db = getDatabase();
    const row = db
      .prepare("SELECT priority FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { priority: number };
    expect(row.priority).toBe(2);
  });

  test("assigns priority 3 for email channel", () => {
    const result = thalamus.receive(makePayload({ channel: "email" }));

    const db = getDatabase();
    const row = db
      .prepare("SELECT priority FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { priority: number };
    expect(row.priority).toBe(3);
  });

  test("assigns default priority 5 for unknown channel", () => {
    const result = thalamus.receive(makePayload({ channel: "unknown" }));

    const db = getDatabase();
    const row = db
      .prepare("SELECT priority FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { priority: number };
    expect(row.priority).toBe(5);
  });

  // --- Formatting tests ---

  test("uses formatChannelData to format data into text (cli)", () => {
    const result = thalamus.receive(
      makePayload({ channel: "cli", data: { text: "user input" } }),
    );

    const db = getDatabase();
    const row = db
      .prepare("SELECT text FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { text: string };
    expect(row.text).toBe("user input");
  });

  test("uses formatChannelData to format data into text (telegram)", () => {
    const result = thalamus.receive(
      makePayload({ channel: "telegram", data: { text: "telegram message" } }),
    );

    const db = getDatabase();
    const row = db
      .prepare("SELECT text FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { text: string };
    expect(row.text).toBe("telegram message");
  });

  test("uses formatChannelData for calendar with events", () => {
    const result = thalamus.receive(
      makePayload({
        channel: "calendar",
        data: {
          events: [{ startDate: "2026-03-01", title: "Meeting" }],
          windowDays: 7,
        },
      }),
    );

    const db = getDatabase();
    const row = db
      .prepare("SELECT text FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { text: string };
    expect(row.text).toContain("Calendar sync");
    expect(row.text).toContain("Meeting");
  });

  test("uses formatDefault (JSON.stringify) for unknown channel", () => {
    const data = { custom: "field", value: 42 };
    const result = thalamus.receive(makePayload({ channel: "unknown", data }));

    const db = getDatabase();
    const row = db
      .prepare("SELECT text FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { text: string };
    expect(row.text).toBe(JSON.stringify(data, null, 2));
  });

  // --- topicKey extraction ---

  test("extracts topicKey from data when present", () => {
    const result = thalamus.receive(
      makePayload({ data: { text: "msg", topicKey: "custom-topic" } }),
    );

    const db = getDatabase();
    const row = db
      .prepare("SELECT topic_key FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { topic_key: string };
    expect(row.topic_key).toBe("custom-topic");
  });

  test("uses channel name as topicKey when not in data", () => {
    const result = thalamus.receive(
      makePayload({ channel: "telegram", data: { text: "no topic key" } }),
    );

    const db = getDatabase();
    const row = db
      .prepare("SELECT topic_key FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { topic_key: string };
    expect(row.topic_key).toBe("telegram");
  });

  // --- userId extraction ---

  test("extracts userId from data when present", () => {
    const result = thalamus.receive(
      makePayload({ data: { text: "msg", userId: "custom-user" } }),
    );

    const db = getDatabase();
    const row = db
      .prepare("SELECT user_id FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { user_id: string };
    expect(row.user_id).toBe("custom-user");
  });

  test("uses 'system' as userId when not in data", () => {
    const result = thalamus.receive(
      makePayload({ data: { text: "no user id" } }),
    );

    const db = getDatabase();
    const row = db
      .prepare("SELECT user_id FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { user_id: string };
    expect(row.user_id).toBe("system");
  });

  // --- Dedup ---

  test("handles duplicate gracefully (returns duplicate: true)", () => {
    const payload = makePayload();

    const first = thalamus.receive(payload);
    expect(first.duplicate).toBe(false);
    expect(first.eventId).toMatch(/^evt_/);

    const second = thalamus.receive(payload);
    expect(second.duplicate).toBe(true);
    expect(second.eventId).toBe(first.eventId);
  });

  // --- Idempotency key format ---

  test("generates idempotencyKey as channel:externalId", () => {
    const payload = makePayload({ channel: "cli", externalId: "my-ext-id" });
    const result = thalamus.receive(payload);

    const db = getDatabase();
    const row = db
      .prepare("SELECT idempotency_key FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId }) as { idempotency_key: string };
    expect(row.idempotency_key).toBe("cli:my-ext-id");
  });
});

describe("thalamus.receive() with mode=buffered", () => {
  let thalamus: Thalamus;

  beforeEach(() => {
    initDatabase(":memory:");
    thalamus = new Thalamus();
  });

  afterEach(() => {
    closeDatabase();
  });

  test("writes to receptor_buffers table, NOT inbox", () => {
    const result = thalamus.receive(
      makePayload({ mode: "buffered", channel: "calendar" }),
    );
    expect(result.duplicate).toBe(false);

    const db = getDatabase();
    // Should be in receptor_buffers
    const bufferRow = db
      .prepare("SELECT id, channel FROM receptor_buffers WHERE id = $id")
      .get({ $id: result.eventId }) as { id: string; channel: string } | null;
    expect(bufferRow).not.toBeNull();
    expect(bufferRow!.channel).toBe("calendar");

    // Should NOT be in inbox
    const inboxRow = db
      .prepare("SELECT id FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId });
    expect(inboxRow).toBeNull();
  });

  test("returns eventId and duplicate=false for new entry", () => {
    const result = thalamus.receive(
      makePayload({ mode: "buffered", channel: "calendar" }),
    );
    expect(result.eventId).toMatch(/^rb_/);
    expect(result.duplicate).toBe(false);
  });

  test("detects duplicates (same channel+externalId)", () => {
    const payload = makePayload({ mode: "buffered", channel: "calendar" });

    const first = thalamus.receive(payload);
    expect(first.duplicate).toBe(false);

    const second = thalamus.receive(payload);
    expect(second.duplicate).toBe(true);
    expect(second.eventId).toBe(first.eventId);
  });

  test("mode=realtime still goes to inbox", () => {
    const result = thalamus.receive(
      makePayload({ mode: "realtime", channel: "telegram" }),
    );
    expect(result.duplicate).toBe(false);
    expect(result.eventId).toMatch(/^evt_/);

    const db = getDatabase();
    const inboxRow = db
      .prepare("SELECT id FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId });
    expect(inboxRow).not.toBeNull();
  });

  test("mode omitted still goes to inbox (backward compat)", () => {
    const result = thalamus.receive(makePayload());
    expect(result.duplicate).toBe(false);
    expect(result.eventId).toMatch(/^evt_/);

    const db = getDatabase();
    const inboxRow = db
      .prepare("SELECT id FROM inbox_messages WHERE id = $id")
      .get({ $id: result.eventId });
    expect(inboxRow).not.toBeNull();
  });
});

// --- Sync tests ---

// Mock Synapse server for sync tests
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

afterAll(() => {
  mockSynapse.stop(true);
});

function makeSynapseResponse(items: unknown[]) {
  return {
    id: "chat-test",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: JSON.stringify({ items }),
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeThalamusConfig(
  overrides?: Partial<ThalamusConfig>,
): ThalamusConfig {
  return {
    synapseUrl: mockSynapseUrl,
    thalamusModels: ["test-model"],
    synapseTimeoutMs: 30000,
    syncIntervalMs: 21_600_000,
    ...overrides,
  };
}

describe("thalamus.syncAll()", () => {
  beforeEach(() => {
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  test("returns early with no buffered data", async () => {
    let synapseCalled = false;
    mockSynapseHandler = () => {
      synapseCalled = true;
      return Response.json(makeSynapseResponse([]));
    };

    const thalamus = new Thalamus(makeThalamusConfig());
    await thalamus.syncAll();

    expect(synapseCalled).toBe(false);
  });

  test("calls Synapse and creates inbox messages from buffered data", async () => {
    // Insert test buffers
    insertReceptorBuffer({
      channel: "calendar",
      externalId: "cal-1",
      content: "Meeting with Bob tomorrow",
      occurredAt: Date.now(),
    });
    insertReceptorBuffer({
      channel: "calendar",
      externalId: "cal-2",
      content: "Dentist on Friday",
      occurredAt: Date.now() + 1000,
    });

    mockSynapseHandler = () =>
      Response.json(
        makeSynapseResponse([
          {
            topicKey: "weekly-schedule",
            priority: 2,
            summary: "2 upcoming appointments this week",
            rawBufferIds: ["rb_1", "rb_2"],
          },
        ]),
      );

    const thalamus = new Thalamus(makeThalamusConfig());
    await thalamus.syncAll();

    // Inbox should have a message
    const msg = claimNextInboxMessage();
    expect(msg).not.toBeNull();
    expect(msg!.channel).toBe("thalamus");
    expect(msg!.topic_key).toBe("weekly-schedule");
    expect(msg!.text).toBe("2 upcoming appointments this week");
    expect(msg!.priority).toBe(2);
    expect(msg!.user_id).toBe("system");

    // Metadata should contain source info
    const metadata = JSON.parse(msg!.metadata_json!);
    expect(metadata.source).toBe("thalamus-sync");
    expect(metadata.rawBufferIds).toEqual(["rb_1", "rb_2"]);

    // Buffers should be deleted
    const remaining = getUnprocessedBuffers();
    expect(remaining).toHaveLength(0);
  });

  test("groups buffers by channel in the prompt", async () => {
    insertReceptorBuffer({
      channel: "calendar",
      externalId: "cal-1",
      content: "Meeting",
      occurredAt: Date.now(),
    });
    insertReceptorBuffer({
      channel: "email",
      externalId: "email-1",
      content: "Invoice",
      occurredAt: Date.now(),
    });

    let capturedBody: {
      messages?: Array<{ role: string; content: string }>;
    } = {};

    mockSynapseHandler = async (req) => {
      capturedBody = (await req.json()) as typeof capturedBody;
      return Response.json(makeSynapseResponse([]));
    };

    const thalamus = new Thalamus(makeThalamusConfig());
    await thalamus.syncAll();

    const userMsg = capturedBody.messages?.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toContain("### Channel: calendar");
    expect(userMsg!.content).toContain("### Channel: email");
    expect(userMsg!.content).toContain("Meeting");
    expect(userMsg!.content).toContain("Invoice");
  });

  test("handles Synapse failure gracefully — buffers NOT deleted", async () => {
    insertReceptorBuffer({
      channel: "calendar",
      externalId: "cal-1",
      content: "Meeting",
      occurredAt: Date.now(),
    });

    mockSynapseHandler = () =>
      Response.json(
        { error: { message: "boom", type: "server_error" } },
        { status: 500 },
      );

    const thalamus = new Thalamus(makeThalamusConfig());
    await thalamus.syncAll();

    // Buffers should still exist (not deleted on error)
    const remaining = getUnprocessedBuffers();
    expect(remaining).toHaveLength(1);

    // No inbox messages created
    const msg = claimNextInboxMessage();
    expect(msg).toBeNull();
  });

  test("updates receptor cursors per channel", async () => {
    insertReceptorBuffer({
      channel: "calendar",
      externalId: "cal-1",
      content: "Meeting",
      occurredAt: Date.now(),
    });
    insertReceptorBuffer({
      channel: "email",
      externalId: "email-1",
      content: "Invoice",
      occurredAt: Date.now(),
    });

    mockSynapseHandler = () => Response.json(makeSynapseResponse([]));

    const thalamus = new Thalamus(makeThalamusConfig());
    await thalamus.syncAll();

    const calCursor = getReceptorCursor("calendar");
    expect(calCursor).not.toBeNull();
    expect(Number(calCursor!.cursorValue)).toBeGreaterThan(0);

    const emailCursor = getReceptorCursor("email");
    expect(emailCursor).not.toBeNull();
    expect(Number(emailCursor!.cursorValue)).toBeGreaterThan(0);
  });

  test("sends correct model and temperature to Synapse", async () => {
    insertReceptorBuffer({
      channel: "calendar",
      externalId: "cal-1",
      content: "Meeting",
      occurredAt: Date.now(),
    });

    let capturedBody: Record<string, unknown> = {};

    mockSynapseHandler = async (req) => {
      capturedBody = (await req.json()) as Record<string, unknown>;
      return Response.json(makeSynapseResponse([]));
    };

    const thalamus = new Thalamus(
      makeThalamusConfig({ thalamusModels: ["gpt-oss:20b"] }),
    );
    await thalamus.syncAll();

    expect(capturedBody.model).toBe("gpt-oss:20b");
    expect(capturedBody.temperature).toBe(0.3);
  });

  test("handles empty LLM items gracefully", async () => {
    insertReceptorBuffer({
      channel: "calendar",
      externalId: "cal-1",
      content: "Nothing interesting",
      occurredAt: Date.now(),
    });

    mockSynapseHandler = () => Response.json(makeSynapseResponse([]));

    const thalamus = new Thalamus(makeThalamusConfig());
    await thalamus.syncAll();

    // No inbox messages
    const msg = claimNextInboxMessage();
    expect(msg).toBeNull();

    // Buffers still cleaned up
    const remaining = getUnprocessedBuffers();
    expect(remaining).toHaveLength(0);
  });
});

describe("thalamus.syncChannel()", () => {
  beforeEach(() => {
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  test("filters to specific channel only", async () => {
    insertReceptorBuffer({
      channel: "calendar",
      externalId: "cal-1",
      content: "Calendar event",
      occurredAt: Date.now(),
    });
    insertReceptorBuffer({
      channel: "email",
      externalId: "email-1",
      content: "Email message",
      occurredAt: Date.now(),
    });

    let capturedBody: {
      messages?: Array<{ role: string; content: string }>;
    } = {};

    mockSynapseHandler = async (req) => {
      capturedBody = (await req.json()) as typeof capturedBody;
      return Response.json(makeSynapseResponse([]));
    };

    const thalamus = new Thalamus(makeThalamusConfig());
    await thalamus.syncChannel("calendar");

    // Should only include calendar data
    const userMsg = capturedBody.messages?.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toContain("### Channel: calendar");
    expect(userMsg!.content).not.toContain("### Channel: email");

    // Calendar buffer deleted, email buffer still exists
    const remaining = getUnprocessedBuffers();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].channel).toBe("email");
  });

  test("returns early with no buffered data for channel", async () => {
    insertReceptorBuffer({
      channel: "email",
      externalId: "email-1",
      content: "Email",
      occurredAt: Date.now(),
    });

    let synapseCalled = false;
    mockSynapseHandler = () => {
      synapseCalled = true;
      return Response.json(makeSynapseResponse([]));
    };

    const thalamus = new Thalamus(makeThalamusConfig());
    await thalamus.syncChannel("calendar");

    expect(synapseCalled).toBe(false);
  });
});
