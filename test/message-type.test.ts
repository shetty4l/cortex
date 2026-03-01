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
import { CEREBELLUM_DEFAULTS } from "../src/cerebellum/types";
import type { CortexConfig } from "../src/config";
import { closeDatabase, getDatabase, initDatabase } from "../src/db";
import { getInboxMessage } from "../src/inbox";
import { getOutboxMessage, listOutboxMessagesByTopic } from "../src/outbox";
import { buildPrompt, loadAndRenderSystemPrompt } from "../src/prompt";
import { insertReceptorBuffer } from "../src/receptor-buffers";
import type { ChatMessage } from "../src/synapse";
import { Thalamus, type ThalamusConfig } from "../src/thalamus";

let stateLoader: StateLoader;

// --- Mock Synapse server for Thalamus sync tests ---

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
  stateLoader: StateLoader,
  overrides?: Partial<Omit<ThalamusConfig, "stateLoader">>,
): ThalamusConfig {
  return {
    synapseUrl: mockSynapseUrl,
    thalamusModels: ["test-model"],
    synapseTimeoutMs: 30000,
    syncIntervalMs: 21_600_000,
    stateLoader,
    ...overrides,
  };
}

describe("message_type flow", () => {
  beforeEach(() => {
    initDatabase(":memory:");
    stateLoader = new StateLoader(getDatabase());
  });

  afterEach(async () => {
    await stateLoader.flush();
    closeDatabase();
  });

  // --- Thalamus sets message_type ---

  describe("Thalamus sets message_type", () => {
    test("telegram channel gets conversational type", () => {
      const thalamus = new Thalamus(makeThalamusConfig(stateLoader));

      const result = thalamus.receive({
        channel: "telegram",
        externalId: "msg-1",
        data: { text: "Hello" },
        occurredAt: new Date().toISOString(),
      });

      const msg = getInboxMessage(stateLoader, result.eventId);
      expect(msg?.message_type).toBe("conversational");
    });

    test("cli channel gets conversational type", () => {
      const thalamus = new Thalamus(makeThalamusConfig(stateLoader));

      const result = thalamus.receive({
        channel: "cli",
        externalId: "msg-1",
        data: { text: "Hello" },
        occurredAt: new Date().toISOString(),
      });

      const msg = getInboxMessage(stateLoader, result.eventId);
      expect(msg?.message_type).toBe("conversational");
    });

    test("calendar channel gets notification type", () => {
      const thalamus = new Thalamus(makeThalamusConfig(stateLoader));

      const result = thalamus.receive({
        channel: "calendar",
        externalId: "cal-1",
        data: { events: [{ title: "Meeting", startDate: "2026-03-01" }] },
        occurredAt: new Date().toISOString(),
      });

      const msg = getInboxMessage(stateLoader, result.eventId);
      expect(msg?.message_type).toBe("notification");
    });

    test("callback type from metadata", () => {
      const thalamus = new Thalamus(makeThalamusConfig(stateLoader));

      const result = thalamus.receive({
        channel: "telegram",
        externalId: "cb-1",
        data: { text: "Task completed" },
        occurredAt: new Date().toISOString(),
        metadata: { type: "callback" },
      });

      const msg = getInboxMessage(stateLoader, result.eventId);
      expect(msg?.message_type).toBe("callback");
    });

    test("email channel gets conversational type (no special handling)", () => {
      const thalamus = new Thalamus(makeThalamusConfig(stateLoader));

      const result = thalamus.receive({
        channel: "email",
        externalId: "email-1",
        data: { text: "Email content" },
        occurredAt: new Date().toISOString(),
      });

      const msg = getInboxMessage(stateLoader, result.eventId);
      expect(msg?.message_type).toBe("conversational");
    });
  });

  // --- Thalamus sync sets message_type ---

  describe("Thalamus sync sets message_type", () => {
    test("calendar buffers synced as notification type", async () => {
      // Insert buffer and capture the actual ID
      const { id: bufferId } = insertReceptorBuffer(stateLoader, {
        channel: "calendar",
        externalId: "cal-sync-1",
        content: "Meeting with Bob tomorrow",
        occurredAt: Date.now(),
      });

      // Use the actual buffer ID in the mock response
      mockSynapseHandler = () =>
        Response.json(
          makeSynapseResponse([
            {
              topicKey: "meetings",
              topicName: "Meetings",
              priority: 2,
              summary: "You have a meeting with Bob tomorrow",
              rawBufferIds: [bufferId],
            },
          ]),
        );

      const thalamus = new Thalamus(makeThalamusConfig(stateLoader));
      await thalamus.syncAll();

      // Find the created inbox message
      const messages = stateLoader.find(
        (await import("../src/inbox")).InboxMessage,
        { where: { channel: "thalamus" } },
      );
      expect(messages).toHaveLength(1);
      expect(messages[0].message_type).toBe("notification");
    });

    test("non-calendar buffers synced as conversational type", async () => {
      const { id: bufferId } = insertReceptorBuffer(stateLoader, {
        channel: "email",
        externalId: "email-sync-1",
        content: "Important email about project",
        occurredAt: Date.now(),
      });

      mockSynapseHandler = () =>
        Response.json(
          makeSynapseResponse([
            {
              topicKey: "email-project",
              topicName: "Project Emails",
              priority: 3,
              summary: "Important email about the project",
              rawBufferIds: [bufferId],
            },
          ]),
        );

      const thalamus = new Thalamus(makeThalamusConfig(stateLoader));
      await thalamus.syncAll();

      const messages = stateLoader.find(
        (await import("../src/inbox")).InboxMessage,
        { where: { channel: "thalamus" } },
      );
      expect(messages).toHaveLength(1);
      expect(messages[0].message_type).toBe("conversational");
    });

    test("mixed buffers with calendar get notification type", async () => {
      const { id: calBufferId } = insertReceptorBuffer(stateLoader, {
        channel: "calendar",
        externalId: "cal-mixed-1",
        content: "Meeting tomorrow",
        occurredAt: Date.now(),
      });
      const { id: emailBufferId } = insertReceptorBuffer(stateLoader, {
        channel: "email",
        externalId: "email-mixed-1",
        content: "Email about meeting",
        occurredAt: Date.now(),
      });

      mockSynapseHandler = () =>
        Response.json(
          makeSynapseResponse([
            {
              topicKey: "meeting-updates",
              topicName: "Meeting Updates",
              priority: 2,
              summary: "Meeting tomorrow and related email",
              rawBufferIds: [calBufferId, emailBufferId], // Includes calendar buffer
            },
          ]),
        );

      const thalamus = new Thalamus(makeThalamusConfig(stateLoader));
      await thalamus.syncAll();

      const messages = stateLoader.find(
        (await import("../src/inbox")).InboxMessage,
        { where: { channel: "thalamus" } },
      );
      expect(messages).toHaveLength(1);
      // If any source buffer is from calendar, it should be notification
      expect(messages[0].message_type).toBe("notification");
    });
  });

  // --- message_type flows to outbox ---

  describe("message_type flows to outbox", () => {
    test("outbox message created with conversational type by default", () => {
      const { enqueueOutboxMessage } = require("../src/outbox");

      const id = enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic-1",
        text: "Hello",
      });

      const msg = getOutboxMessage(stateLoader, id);
      expect(msg?.message_type).toBe("conversational");
    });

    test("outbox message created with notification type", () => {
      const { enqueueOutboxMessage } = require("../src/outbox");

      const id = enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic-1",
        text: "Calendar notification",
        messageType: "notification",
      });

      const msg = getOutboxMessage(stateLoader, id);
      expect(msg?.message_type).toBe("notification");
    });

    test("outbox message created with callback type", () => {
      const { enqueueOutboxMessage } = require("../src/outbox");

      const id = enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic-1",
        text: "Task done",
        messageType: "callback",
      });

      const msg = getOutboxMessage(stateLoader, id);
      expect(msg?.message_type).toBe("callback");
    });

    test("outbox message created with reminder type", () => {
      const { enqueueOutboxMessage } = require("../src/outbox");

      const id = enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic-1",
        text: "Reminder to call",
        messageType: "reminder",
      });

      const msg = getOutboxMessage(stateLoader, id);
      expect(msg?.message_type).toBe("reminder");
    });
  });

  // --- Prompt addendum applied ---

  describe("prompt addendum applied", () => {
    test("conversational type has no addendum", () => {
      const systemPrompt = loadAndRenderSystemPrompt({ toolNames: [] });

      const messages = buildPrompt({
        systemPrompt,
        memories: [],
        turns: [],
        userText: "Hello",
        messageType: "conversational",
      });

      const system = messages.find((m) => m.role === "system");
      expect(system?.content).not.toContain("IMPORTANT:");
      expect(system?.content).not.toContain("notification");
      expect(system?.content).not.toContain("reminder");
      expect(system?.content).not.toContain("callback");
    });

    test("notification type adds informative instruction", () => {
      const systemPrompt = loadAndRenderSystemPrompt({ toolNames: [] });

      const messages = buildPrompt({
        systemPrompt,
        memories: [],
        turns: [],
        userText: "Calendar event info",
        messageType: "notification",
      });

      const system = messages.find((m) => m.role === "system");
      expect(system?.content).toContain("IMPORTANT:");
      expect(system?.content).toContain("notification message");
      expect(system?.content).toContain("Inform the user");
      expect(system?.content).toContain("do NOT ask clarifying questions");
    });

    test("reminder type adds brief instruction", () => {
      const systemPrompt = loadAndRenderSystemPrompt({ toolNames: [] });

      const messages = buildPrompt({
        systemPrompt,
        memories: [],
        turns: [],
        userText: "Time to take medication",
        messageType: "reminder",
      });

      const system = messages.find((m) => m.role === "system");
      expect(system?.content).toContain("IMPORTANT:");
      expect(system?.content).toContain("reminder message");
      expect(system?.content).toContain("brief and direct");
    });

    test("callback type adds acknowledgment instruction", () => {
      const systemPrompt = loadAndRenderSystemPrompt({ toolNames: [] });

      const messages = buildPrompt({
        systemPrompt,
        memories: [],
        turns: [],
        userText: "Action completed",
        messageType: "callback",
      });

      const system = messages.find((m) => m.role === "system");
      expect(system?.content).toContain("IMPORTANT:");
      expect(system?.content).toContain("callback message");
      expect(system?.content).toContain("Acknowledge the action");
    });

    test("addendum is appended after memories and summary", () => {
      const systemPrompt = loadAndRenderSystemPrompt({ toolNames: [] });

      const messages = buildPrompt({
        systemPrompt,
        memories: [
          {
            id: "m1",
            content: "User likes coffee",
            category: "fact",
            strength: 1,
            relevance: 0.9,
          },
        ],
        topicSummary: "Discussing calendar events",
        turns: [],
        userText: "What's next?",
        messageType: "notification",
      });

      const system = messages.find((m) => m.role === "system");
      const content = system?.content ?? "";

      // Memory section should come before addendum
      const memoryIndex = content.indexOf("User likes coffee");
      const summaryIndex = content.indexOf("Discussing calendar events");
      const addendumIndex = content.indexOf("IMPORTANT:");

      expect(memoryIndex).toBeGreaterThan(-1);
      expect(summaryIndex).toBeGreaterThan(memoryIndex);
      expect(addendumIndex).toBeGreaterThan(summaryIndex);
    });

    test("undefined messageType defaults to no addendum", () => {
      const systemPrompt = loadAndRenderSystemPrompt({ toolNames: [] });

      const messages = buildPrompt({
        systemPrompt,
        memories: [],
        turns: [],
        userText: "Hello",
        // messageType omitted
      });

      const system = messages.find((m) => m.role === "system");
      expect(system?.content).not.toContain("IMPORTANT:");
    });
  });
});
