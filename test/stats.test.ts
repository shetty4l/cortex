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
  type CortexStats,
  closeDatabase,
  completeInboxMessage,
  enqueueInboxMessage,
  enqueueOutboxMessage,
  getDatabase,
  getStats,
  initDatabase,
  insertReceptorBuffer,
  resetDatabase,
  upsertReceptorCursor,
} from "../src/db";
import { startServer } from "../src/server";

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
  };
}

describe("stats API", () => {
  beforeEach(() => {
    resetDatabase();
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  describe("getStats()", () => {
    test("returns zeros/nulls for empty database", () => {
      const stats = getStats();

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
      expect(stats.receptors.calendar_last_sync_at).toBeNull();
      expect(stats.receptors.calendar_buffer_pending).toBe(0);
      expect(stats.receptors.thalamus_last_run_at).toBeNull();

      // Processing latencies
      expect(stats.processing.p50_ms).toBeNull();
      expect(stats.processing.p95_ms).toBeNull();
      expect(stats.processing.p99_ms).toBeNull();
    });

    test("includes thalamus_last_run_at when thalamus provided", () => {
      const mockThalamus = {
        getLastSyncAt: () => 1234567890,
      };

      const stats = getStats(mockThalamus);
      expect(stats.receptors.thalamus_last_run_at).toBe(1234567890);
    });

    test("thalamus_last_run_at is null when thalamus not provided", () => {
      const stats = getStats();
      expect(stats.receptors.thalamus_last_run_at).toBeNull();
    });

    test("counts inbox messages by status", () => {
      // Create some inbox messages
      enqueueInboxMessage({
        channel: "telegram",
        externalMessageId: "msg1",
        topicKey: "topic:1",
        userId: "user1",
        text: "Hello",
        occurredAt: Date.now(),
        idempotencyKey: "key1",
        priority: 5,
      });
      enqueueInboxMessage({
        channel: "telegram",
        externalMessageId: "msg2",
        topicKey: "topic:1",
        userId: "user1",
        text: "Hello again",
        occurredAt: Date.now(),
        idempotencyKey: "key2",
        priority: 5,
      });

      const stats = getStats();
      expect(stats.inbox.pending).toBe(2);
    });

    test("counts done messages in last hour", () => {
      // Create and complete a message
      const result = enqueueInboxMessage({
        channel: "telegram",
        externalMessageId: "msg1",
        topicKey: "topic:1",
        userId: "user1",
        text: "Hello",
        occurredAt: Date.now(),
        idempotencyKey: "key1",
        priority: 5,
      });
      completeInboxMessage(result.eventId, 500);

      const stats = getStats();
      expect(stats.inbox.done_24h).toBe(1);
      expect(stats.inbox.pending).toBe(0);
    });

    test("counts failed messages in last hour", () => {
      const result = enqueueInboxMessage({
        channel: "telegram",
        externalMessageId: "msg1",
        topicKey: "topic:1",
        userId: "user1",
        text: "Hello",
        occurredAt: Date.now(),
        idempotencyKey: "key1",
        priority: 5,
      });
      completeInboxMessage(result.eventId, 100, "some error");

      const stats = getStats();
      expect(stats.inbox.failed_24h).toBe(1);
    });

    test("excludes old done/failed messages from 24h counts", () => {
      // Manually insert a message with old updated_at
      const db = getDatabase();
      const twoDaysAgo = Date.now() - 2 * 24 * 3600 * 1000;
      db.prepare(`
        INSERT INTO inbox_messages
        (id, channel, external_message_id, topic_key, user_id, text, occurred_at,
         idempotency_key, priority, status, attempts, next_attempt_at, created_at, updated_at)
        VALUES
        ('old_done', 'telegram', 'old1', 'topic:1', 'user1', 'test', $now,
         'key_old', 5, 'done', 0, 0, $twoDaysAgo, $twoDaysAgo)
      `).run({ $now: Date.now(), $twoDaysAgo: twoDaysAgo });

      const stats = getStats();
      expect(stats.inbox.done_24h).toBe(0); // Old message not counted
    });

    test("counts outbox messages by status", () => {
      enqueueOutboxMessage({
        channel: "telegram",
        topicKey: "topic:1",
        text: "Response 1",
      });
      enqueueOutboxMessage({
        channel: "telegram",
        topicKey: "topic:1",
        text: "Response 2",
      });

      const stats = getStats();
      expect(stats.outbox.pending).toBe(2);
    });

    test("reports receptor cursor timestamps", () => {
      upsertReceptorCursor("calendar", "cursor-value-1");

      const stats = getStats();
      // last_synced_at is set to Date.now() by the function
      expect(stats.receptors.calendar_last_sync_at).not.toBeNull();
      expect(typeof stats.receptors.calendar_last_sync_at).toBe("number");
    });

    test("counts pending receptor buffers", () => {
      insertReceptorBuffer({
        channel: "calendar",
        externalId: "event-1",
        content: "Event content 1",
        occurredAt: Date.now(),
      });
      insertReceptorBuffer({
        channel: "calendar",
        externalId: "event-2",
        content: "Event content 2",
        occurredAt: Date.now(),
      });

      const stats = getStats();
      expect(stats.receptors.calendar_buffer_pending).toBe(2);
    });

    test("computes processing latency percentiles", () => {
      // Create 10 messages with different processing times
      for (let i = 1; i <= 10; i++) {
        const result = enqueueInboxMessage({
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
        completeInboxMessage(result.eventId, i * 100);
      }

      const stats = getStats();
      // p50 = 5th value = 500ms
      expect(stats.processing.p50_ms).toBe(500);
      // p95 = 10th value = 1000ms
      expect(stats.processing.p95_ms).toBe(1000);
      // p99 = 10th value = 1000ms
      expect(stats.processing.p99_ms).toBe(1000);
    });

    test("returns null percentiles when no processing data", () => {
      // Create a message but don't complete it
      enqueueInboxMessage({
        channel: "telegram",
        externalMessageId: "msg1",
        topicKey: "topic:1",
        userId: "user1",
        text: "Hello",
        occurredAt: Date.now(),
        idempotencyKey: "key1",
        priority: 5,
      });

      const stats = getStats();
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
        data.receptors.calendar_last_sync_at === null ||
          typeof data.receptors.calendar_last_sync_at === "number",
      ).toBe(true);
      expect(typeof data.receptors.calendar_buffer_pending).toBe("number");
      expect(
        data.receptors.thalamus_last_run_at === null ||
          typeof data.receptors.thalamus_last_run_at === "number",
      ).toBe(true);

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
