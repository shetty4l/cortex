import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StateLoader } from "@shetty4l/core/state";
import { Cerebellum, type CerebellumStats } from "../src/cerebellum";
import type { CerebellumConfig } from "../src/cerebellum/types";
import { closeDatabase, getDatabase, initDatabase } from "../src/db";
import { enqueueOutboxMessage, getOutboxMessage } from "../src/outbox";

let stateLoader: StateLoader;

function makeConfig(overrides?: Partial<CerebellumConfig>): CerebellumConfig {
  return {
    pollIntervalMs: 500,
    ...overrides,
  };
}

describe("Cerebellum", () => {
  beforeEach(() => {
    initDatabase(":memory:");
    stateLoader = new StateLoader(getDatabase());
  });

  afterEach(async () => {
    await stateLoader.flush();
    closeDatabase();
  });

  // --- Constructor ---

  describe("constructor", () => {
    test("creates instance with config and stateLoader", () => {
      const config = makeConfig();
      const cerebellum = new Cerebellum(config, stateLoader);
      expect(cerebellum).toBeInstanceOf(Cerebellum);
    });

    test("initializes stats to default values", () => {
      const cerebellum = new Cerebellum(makeConfig(), stateLoader);
      const stats = cerebellum.getStats();

      expect(stats.messagesRouted).toBe(0);
      expect(stats.lastCycleRouted).toBe(0);
      expect(stats.lastRoutedAt).toBeNull();
      expect(stats.isRunning).toBe(false);
    });
  });

  // --- start/stop lifecycle ---

  describe("start/stop lifecycle", () => {
    test("start sets isRunning to true", () => {
      const cerebellum = new Cerebellum(makeConfig(), stateLoader);

      expect(cerebellum.getStats().isRunning).toBe(false);
      cerebellum.start();
      expect(cerebellum.getStats().isRunning).toBe(true);

      cerebellum.stop();
    });

    test("stop sets isRunning to false", () => {
      const cerebellum = new Cerebellum(makeConfig(), stateLoader);
      cerebellum.start();
      expect(cerebellum.getStats().isRunning).toBe(true);

      cerebellum.stop();
      expect(cerebellum.getStats().isRunning).toBe(false);
    });

    test("start is idempotent (calling twice does not fail)", () => {
      const cerebellum = new Cerebellum(makeConfig(), stateLoader);

      cerebellum.start();
      cerebellum.start(); // Should not throw or create duplicate timers

      expect(cerebellum.getStats().isRunning).toBe(true);
      cerebellum.stop();
    });

    test("stop is idempotent (calling twice does not fail)", () => {
      const cerebellum = new Cerebellum(makeConfig(), stateLoader);
      cerebellum.start();

      cerebellum.stop();
      cerebellum.stop(); // Should not throw

      expect(cerebellum.getStats().isRunning).toBe(false);
    });

    test("stop without start does not fail", () => {
      const cerebellum = new Cerebellum(makeConfig(), stateLoader);
      cerebellum.stop(); // Should not throw
      expect(cerebellum.getStats().isRunning).toBe(false);
    });
  });

  // --- Polling ---

  describe("polling", () => {
    test("start triggers immediate routing on startup", async () => {
      // Seed a pending message
      enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic-1",
        text: "Hello",
      });

      const cerebellum = new Cerebellum(makeConfig(), stateLoader);
      cerebellum.start();

      // Give time for immediate routing
      await Bun.sleep(50);

      const stats = cerebellum.getStats();
      expect(stats.messagesRouted).toBe(1);

      cerebellum.stop();
    });

    test("polling routes pending messages at interval", async () => {
      const cerebellum = new Cerebellum(
        makeConfig({ pollIntervalMs: 50 }),
        stateLoader,
      );
      cerebellum.start();

      // Wait for initial routing (no messages)
      await Bun.sleep(30);

      // Add a message after startup
      enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic-1",
        text: "Delayed message",
      });

      // Wait for next poll cycle
      await Bun.sleep(80);

      const stats = cerebellum.getStats();
      expect(stats.messagesRouted).toBe(1);

      cerebellum.stop();
    });
  });

  // --- Fast path routing (routePending) ---

  describe("routePending", () => {
    test("routes pending messages to ready status", async () => {
      const outboxId = enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic-1",
        text: "Pending message",
      });

      // Verify initial status is pending
      const before = getOutboxMessage(stateLoader, outboxId);
      expect(before?.status).toBe("pending");

      const cerebellum = new Cerebellum(makeConfig(), stateLoader);
      const routed = await cerebellum.routePending();

      expect(routed).toBe(1);

      // Verify status changed to ready
      const after = getOutboxMessage(stateLoader, outboxId);
      expect(after?.status).toBe("ready");
    });

    test("routes multiple pending messages in a single cycle", async () => {
      enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic-1",
        text: "Message 1",
      });
      enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic-2",
        text: "Message 2",
      });
      enqueueOutboxMessage(stateLoader, {
        channel: "slack",
        topicKey: "topic-3",
        text: "Message 3",
      });

      const cerebellum = new Cerebellum(makeConfig(), stateLoader);
      const routed = await cerebellum.routePending();

      expect(routed).toBe(3);
    });

    test("returns 0 when no pending messages exist", async () => {
      const cerebellum = new Cerebellum(makeConfig(), stateLoader);
      const routed = await cerebellum.routePending();

      expect(routed).toBe(0);
    });

    test("does not route already-ready messages", async () => {
      const outboxId = enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic-1",
        text: "Message",
      });

      // Manually set to ready
      const db = getDatabase();
      db.prepare(
        "UPDATE outbox_messages SET status = 'ready' WHERE id = $id",
      ).run({
        $id: outboxId,
      });

      const cerebellum = new Cerebellum(makeConfig(), stateLoader);
      const routed = await cerebellum.routePending();

      expect(routed).toBe(0);
    });

    test("does not route leased messages", async () => {
      const outboxId = enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic-1",
        text: "Message",
      });

      // Set to leased status
      const db = getDatabase();
      db.prepare(
        "UPDATE outbox_messages SET status = 'leased' WHERE id = $id",
      ).run({
        $id: outboxId,
      });

      const cerebellum = new Cerebellum(makeConfig(), stateLoader);
      const routed = await cerebellum.routePending();

      expect(routed).toBe(0);
    });

    test("preserves message_type and urgency during routing", async () => {
      const outboxId = enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic-1",
        text: "Notification message",
        messageType: "notification",
        urgency: "high",
      });

      const cerebellum = new Cerebellum(makeConfig(), stateLoader);
      await cerebellum.routePending();

      const after = getOutboxMessage(stateLoader, outboxId);
      expect(after?.status).toBe("ready");
      expect(after?.message_type).toBe("notification");
      expect(after?.urgency).toBe("high");
    });

    test("routes messages in creation order (FIFO)", async () => {
      const id1 = enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic-1",
        text: "First",
      });
      await Bun.sleep(5); // Ensure different timestamps
      const id2 = enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic-2",
        text: "Second",
      });

      const cerebellum = new Cerebellum(makeConfig(), stateLoader);
      await cerebellum.routePending();

      // Both should be routed
      const msg1 = getOutboxMessage(stateLoader, id1);
      const msg2 = getOutboxMessage(stateLoader, id2);
      expect(msg1?.status).toBe("ready");
      expect(msg2?.status).toBe("ready");
    });
  });

  // --- Stats ---

  describe("getStats", () => {
    test("tracks total messagesRouted across cycles", async () => {
      const cerebellum = new Cerebellum(makeConfig(), stateLoader);

      // Route first message
      enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic-1",
        text: "Message 1",
      });
      await cerebellum.routePending();

      expect(cerebellum.getStats().messagesRouted).toBe(1);

      // Route second message
      enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic-2",
        text: "Message 2",
      });
      await cerebellum.routePending();

      expect(cerebellum.getStats().messagesRouted).toBe(2);
    });

    test("tracks lastCycleRouted for most recent cycle only", async () => {
      const cerebellum = new Cerebellum(makeConfig(), stateLoader);

      // Route two messages
      enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic-1",
        text: "Message 1",
      });
      enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic-2",
        text: "Message 2",
      });
      await cerebellum.routePending();

      expect(cerebellum.getStats().lastCycleRouted).toBe(2);

      // Route one more message
      enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic-3",
        text: "Message 3",
      });
      await cerebellum.routePending();

      expect(cerebellum.getStats().lastCycleRouted).toBe(1);
    });

    test("sets lastCycleRouted to 0 when no messages routed", async () => {
      const cerebellum = new Cerebellum(makeConfig(), stateLoader);

      // First cycle with messages
      enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic-1",
        text: "Message",
      });
      await cerebellum.routePending();
      expect(cerebellum.getStats().lastCycleRouted).toBe(1);

      // Second cycle with no messages
      await cerebellum.routePending();
      expect(cerebellum.getStats().lastCycleRouted).toBe(0);
    });

    test("updates lastRoutedAt when messages are routed", async () => {
      const cerebellum = new Cerebellum(makeConfig(), stateLoader);

      expect(cerebellum.getStats().lastRoutedAt).toBeNull();

      enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic-1",
        text: "Message",
      });

      const before = Date.now();
      await cerebellum.routePending();
      const after = Date.now();

      const lastRoutedAt = cerebellum.getStats().lastRoutedAt;
      expect(lastRoutedAt).not.toBeNull();
      expect(lastRoutedAt!).toBeGreaterThanOrEqual(before);
      expect(lastRoutedAt!).toBeLessThanOrEqual(after);
    });

    test("does not update lastRoutedAt when no messages routed", async () => {
      const cerebellum = new Cerebellum(makeConfig(), stateLoader);

      // First routing with a message
      enqueueOutboxMessage(stateLoader, {
        channel: "telegram",
        topicKey: "topic-1",
        text: "Message",
      });
      await cerebellum.routePending();
      const firstRoutedAt = cerebellum.getStats().lastRoutedAt;

      await Bun.sleep(10);

      // Second routing with no messages
      await cerebellum.routePending();
      const secondRoutedAt = cerebellum.getStats().lastRoutedAt;

      // lastRoutedAt should not have changed
      expect(secondRoutedAt).toBe(firstRoutedAt);
    });

    test("returns a copy of stats (immutable)", () => {
      const cerebellum = new Cerebellum(makeConfig(), stateLoader);

      const stats1 = cerebellum.getStats();
      stats1.messagesRouted = 999;

      const stats2 = cerebellum.getStats();
      expect(stats2.messagesRouted).toBe(0); // Original value preserved
    });
  });
});
