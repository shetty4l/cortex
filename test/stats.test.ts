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
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  resetDatabase,
} from "../src/db";
import { completeInboxMessage, enqueueInboxMessage } from "../src/inbox";
import { enqueueOutboxMessage } from "../src/outbox";
import { insertReceptorBuffer } from "../src/receptor-buffers";
import { startServer } from "../src/server";
import { type CortexStats, getStats } from "../src/stats";

const API_KEY = "test-stats-key";

function makeConfig(): CortexConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    ingestApiKey: API_KEY,
    models: ["test-model"],
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
    inboxMaxAttempts: 5,
    skillDirs: [],
    skillConfig: {},
    toolTimeoutMs: 20000,
    maxToolRounds: 8,
    synapseTimeoutMs: 60_000,
    thalamusModels: ["test-model"],
    thalamusSyncIntervalMs: 21_600_000,
    cerebellum: CEREBELLUM_DEFAULTS,
  };
}

describe("stats API", () => {
  let stateLoader: StateLoader;

  beforeEach(() => {
    resetDatabase();
    initDatabase(":memory:");
    stateLoader = new StateLoader(getDatabase());
  });

  afterEach(async () => {
    await stateLoader.flush();
    closeDatabase();
  });

  describe("getStats()", () => {
    test("returns zeros/nulls for empty database", () => {
      const stats = getStats(stateLoader);

      // Inbox
      expect(stats.inbox.pending).toBe(0);
      expect(stats.inbox.processing).toBe(0);
      expect(stats.inbox.done_24h).toBe(0);
      expect(stats.inbox.failed_24h).toBe(0);

      // Outbox
      expect(stats.outbox.pending).toBe(0);
      expect(stats.outbox.delivered_24h).toBe(0);
      expect(stats.outbox.dead_total).toBe(0);

      // Receptors
      expect(stats.receptors.thalamus_last_run_at).toBeNull();
      expect(stats.receptors.buffer_pending_total).toBe(0);

      // Processing latencies
      expect(stats.processing.p50_ms).toBeNull();
      expect(stats.processing.p95_ms).toBeNull();
      expect(stats.processing.p99_ms).toBeNull();
    });

    test("includes thalamus_last_run_at when thalamus provided", () => {
      const mockThalamus = {
        getLastSyncAt: () => 1234567890,
      };

      const stats = getStats(stateLoader, mockThalamus);
      expect(stats.receptors.thalamus_last_run_at).toBe(1234567890);
    });

    test("thalamus_last_run_at is null when thalamus not provided", () => {
      const stats = getStats(stateLoader);
      expect(stats.receptors.thalamus_last_run_at).toBeNull();
    });

    test("counts inbox messages by status", () => {
      // Create some inbox messages
      enqueueInboxMessage(stateLoader, {
        channel: "telegram",
        externalMessageId: "msg1",
        topicKey: "topic:1",
        userId: "user1",
        text: "Hello",
        occurredAt: Date.now(),
        idempotencyKey: "key1",
        priority: 5,
      });
      enqueueInboxMessage(stateLoader, {
        channel: "telegram",
        externalMessageId: "msg2",
        topicKey: "topic:1",
        userId: "user1",
        text: "Hello again",
        occurredAt: Date.now(),
        idempotencyKey: "key2",
        priority: 5,
      });

      const stats = getStats(stateLoader);
      expect(stats.inbox.pending).toBe(2);
    });

    test("counts done messages in last hour", async () => {
      // Create and complete a message
      const result = enqueueInboxMessage(stateLoader, {
        channel: "telegram",
        externalMessageId: "msg1",
        topicKey: "topic:1",
        userId: "user1",
        text: "Hello",
        occurredAt: Date.now(),
        idempotencyKey: "key1",
        priority: 5,
      });
      await completeInboxMessage(stateLoader, result.eventId, 500);

      const stats = getStats(stateLoader);
      expect(stats.inbox.done_24h).toBe(1);
      expect(stats.inbox.pending).toBe(0);
    });

    test("counts failed messages in last hour", async () => {
      const result = enqueueInboxMessage(stateLoader, {
        channel: "telegram",
        externalMessageId: "msg1",
        topicKey: "topic:1",
        userId: "user1",
        text: "Hello",
        occurredAt: Date.now(),
        idempotencyKey: "key1",
        priority: 5,
      });
      await completeInboxMessage(
        stateLoader,
        result.eventId,
        100,
        "some error",
      );

      const stats = getStats(stateLoader);
      expect(stats.inbox.failed_24h).toBe(1);
    });

    test("done_24h counts all done messages (24h filtering TBD)", () => {
      // Note: True 24h filtering requires updated_at field (fast-follow).
      // Currently counts all done messages regardless of age.
      // Insert two done messages
      const msg1 = enqueueInboxMessage(stateLoader, {
        channel: "telegram",
        externalMessageId: "msg1",
        topicKey: "topic:1",
        userId: "user1",
        text: "test 1",
        occurredAt: Date.now(),
        idempotencyKey: "key1",
        priority: 5,
      });
      const msg2 = enqueueInboxMessage(stateLoader, {
        channel: "telegram",
        externalMessageId: "msg2",
        topicKey: "topic:1",
        userId: "user1",
        text: "test 2",
        occurredAt: Date.now(),
        idempotencyKey: "key2",
        priority: 5,
      });

      // Mark both as done
      completeInboxMessage(stateLoader, msg1.eventId, 100);
      completeInboxMessage(stateLoader, msg2.eventId, 150);

      const stats = getStats(stateLoader);
      expect(stats.inbox.done_24h).toBe(2); // Both counted (no time filter)
    });

    test("counts outbox messages by status", () => {
      enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic:1",
        text: "Response 1",
      });
      enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic:1",
        text: "Response 2",
      });

      const stats = getStats(stateLoader);
      expect(stats.outbox.pending).toBe(2);
    });

    test("counts pending receptor buffers (total across all channels)", () => {
      insertReceptorBuffer(stateLoader, {
        channel: "calendar",
        externalId: "event-1",
        content: "Event content 1",
        occurredAt: Date.now(),
      });
      insertReceptorBuffer(stateLoader, {
        channel: "calendar",
        externalId: "event-2",
        content: "Event content 2",
        occurredAt: Date.now(),
      });

      const stats = getStats(stateLoader);
      expect(stats.receptors.buffer_pending_total).toBe(2);
    });

    test("sums buffer_pending_total across all channels", () => {
      // Insert buffers across multiple channels
      insertReceptorBuffer(stateLoader, {
        channel: "calendar",
        externalId: "cal-1",
        content: "Calendar event 1",
        occurredAt: Date.now(),
      });
      insertReceptorBuffer(stateLoader, {
        channel: "calendar",
        externalId: "cal-2",
        content: "Calendar event 2",
        occurredAt: Date.now(),
      });
      insertReceptorBuffer(stateLoader, {
        channel: "email",
        externalId: "email-1",
        content: "Email 1",
        occurredAt: Date.now(),
      });
      insertReceptorBuffer(stateLoader, {
        channel: "telegram",
        externalId: "tg-1",
        content: "Telegram message",
        occurredAt: Date.now(),
      });

      const stats = getStats(stateLoader);

      // buffer_pending_total sums all channels: 2 + 1 + 1 = 4
      expect(stats.receptors.buffer_pending_total).toBe(4);
    });

    test("buffer_pending_total is 0 when no buffers exist", () => {
      const stats = getStats(stateLoader);
      expect(stats.receptors.buffer_pending_total).toBe(0);
    });

    test("computes processing latency percentiles", async () => {
      // Create 10 messages with different processing times
      for (let i = 1; i <= 10; i++) {
        const result = enqueueInboxMessage(stateLoader, {
          channel: "telegram",
          externalMessageId: `msg${i}`,
          topicKey: "topic:1",
          userId: "user1",
          text: `Message ${i}`,
          occurredAt: Date.now(),
          idempotencyKey: `key${i}`,
          priority: 5,
        });
        // Processing times: 100, 200, 300, ..., 1000
        await completeInboxMessage(stateLoader, result.eventId, i * 100);
      }

      const stats = getStats(stateLoader);
      // p50 = 5th value = 500ms
      expect(stats.processing.p50_ms).toBe(500);
      // p95 = 10th value = 1000ms
      expect(stats.processing.p95_ms).toBe(1000);
      // p99 = 10th value = 1000ms
      expect(stats.processing.p99_ms).toBe(1000);
    });

    test("returns null percentiles when no processing data", () => {
      // Create a message but don't complete it
      enqueueInboxMessage(stateLoader, {
        channel: "telegram",
        externalMessageId: "msg1",
        topicKey: "topic:1",
        userId: "user1",
        text: "Hello",
        occurredAt: Date.now(),
        idempotencyKey: "key1",
        priority: 5,
      });

      const stats = getStats(stateLoader);
      expect(stats.processing.p50_ms).toBeNull();
      expect(stats.processing.p95_ms).toBeNull();
      expect(stats.processing.p99_ms).toBeNull();
    });
  });

  describe("GET /stats endpoint", () => {
    let server: { port: number; stop: () => void };
    let baseUrl: string;

    beforeAll(() => {
      resetDatabase();
      initDatabase(":memory:");
      server = startServer(makeConfig());
      baseUrl = `http://localhost:${server.port}`;
    });

    afterAll(() => {
      server.stop();
      closeDatabase();
    });

    test("returns 200 with correct shape", async () => {
      const response = await fetch(`${baseUrl}/stats`);
      expect(response.status).toBe(200);

      const data = (await response.json()) as CortexStats;

      // Verify shape
      expect(data).toHaveProperty("inbox");
      expect(data).toHaveProperty("outbox");
      expect(data).toHaveProperty("receptors");
      expect(data).toHaveProperty("processing");

      // Inbox shape
      expect(typeof data.inbox.pending).toBe("number");
      expect(typeof data.inbox.processing).toBe("number");
      expect(typeof data.inbox.done_24h).toBe("number");
      expect(typeof data.inbox.failed_24h).toBe("number");

      // Outbox shape
      expect(typeof data.outbox.pending).toBe("number");
      expect(typeof data.outbox.delivered_24h).toBe("number");
      expect(typeof data.outbox.dead_total).toBe("number");

      // Receptors shape
      expect(
        data.receptors.thalamus_last_run_at === null ||
          typeof data.receptors.thalamus_last_run_at === "number",
      ).toBe(true);
      expect(typeof data.receptors.buffer_pending_total).toBe("number");

      // Processing shape
      expect(
        data.processing.p50_ms === null ||
          typeof data.processing.p50_ms === "number",
      ).toBe(true);
      expect(
        data.processing.p95_ms === null ||
          typeof data.processing.p95_ms === "number",
      ).toBe(true);
      expect(
        data.processing.p99_ms === null ||
          typeof data.processing.p99_ms === "number",
      ).toBe(true);
    });

    test("does not require authentication", async () => {
      // No auth header — should still work
      const response = await fetch(`${baseUrl}/stats`);
      expect(response.status).toBe(200);
    });
  });
});
