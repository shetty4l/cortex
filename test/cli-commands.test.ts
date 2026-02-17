import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDatabase,
  enqueueInboxMessage,
  enqueueOutboxMessage,
  initDatabase,
  listInboxMessages,
  listOutboxMessages,
  purgeMessages,
} from "../src/db";

describe("list and purge operations", () => {
  beforeEach(() => {
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  function seedInbox(text: string): string {
    const id = crypto.randomUUID().slice(0, 8);
    const result = enqueueInboxMessage({
      source: "telegram",
      externalMessageId: `msg-${id}`,
      topicKey: "topic-1",
      userId: "user-1",
      text,
      occurredAt: Date.now(),
      idempotencyKey: `key-${id}`,
    });
    return result.eventId;
  }

  function seedOutbox(text: string): string {
    return enqueueOutboxMessage({
      source: "telegram",
      topicKey: "topic-1",
      text,
    });
  }

  // --- listInboxMessages ---

  describe("listInboxMessages", () => {
    test("returns empty array when no messages exist", () => {
      const messages = listInboxMessages();
      expect(messages).toHaveLength(0);
    });

    test("returns messages ordered by created_at DESC (most recent first)", async () => {
      seedInbox("First");
      await Bun.sleep(5);
      seedInbox("Second");
      await Bun.sleep(5);
      seedInbox("Third");

      const messages = listInboxMessages();
      expect(messages).toHaveLength(3);
      expect(messages[0].text).toBe("Third");
      expect(messages[1].text).toBe("Second");
      expect(messages[2].text).toBe("First");
    });

    test("respects limit parameter", async () => {
      seedInbox("One");
      await Bun.sleep(5);
      seedInbox("Two");
      await Bun.sleep(5);
      seedInbox("Three");

      const messages = listInboxMessages(2);
      expect(messages).toHaveLength(2);
      expect(messages[0].text).toBe("Three");
      expect(messages[1].text).toBe("Two");
    });

    test("returns all fields", () => {
      seedInbox("Hello");

      const messages = listInboxMessages();
      expect(messages).toHaveLength(1);
      const msg = messages[0];
      expect(msg.id).toMatch(/^evt_/);
      expect(msg.source).toBe("telegram");
      expect(msg.topic_key).toBe("topic-1");
      expect(msg.user_id).toBe("user-1");
      expect(msg.text).toBe("Hello");
      expect(msg.status).toBe("pending");
      expect(typeof msg.created_at).toBe("number");
    });
  });

  // --- listOutboxMessages ---

  describe("listOutboxMessages", () => {
    test("returns empty array when no messages exist", () => {
      const messages = listOutboxMessages();
      expect(messages).toHaveLength(0);
    });

    test("returns messages ordered by created_at DESC (most recent first)", async () => {
      seedOutbox("First");
      await Bun.sleep(5);
      seedOutbox("Second");
      await Bun.sleep(5);
      seedOutbox("Third");

      const messages = listOutboxMessages();
      expect(messages).toHaveLength(3);
      expect(messages[0].text).toBe("Third");
      expect(messages[1].text).toBe("Second");
      expect(messages[2].text).toBe("First");
    });

    test("respects limit parameter", async () => {
      seedOutbox("One");
      await Bun.sleep(5);
      seedOutbox("Two");
      await Bun.sleep(5);
      seedOutbox("Three");

      const messages = listOutboxMessages(2);
      expect(messages).toHaveLength(2);
    });

    test("returns all fields", () => {
      seedOutbox("Reply");

      const messages = listOutboxMessages();
      expect(messages).toHaveLength(1);
      const msg = messages[0];
      expect(msg.id).toMatch(/^out_/);
      expect(msg.source).toBe("telegram");
      expect(msg.topic_key).toBe("topic-1");
      expect(msg.text).toBe("Reply");
      expect(msg.status).toBe("pending");
      expect(msg.attempts).toBe(0);
      expect(typeof msg.created_at).toBe("number");
    });
  });

  // --- purgeMessages ---

  describe("purgeMessages", () => {
    test("returns zero counts on empty database", () => {
      const counts = purgeMessages();
      expect(counts.inbox).toBe(0);
      expect(counts.outbox).toBe(0);
    });

    test("deletes all inbox and outbox messages", () => {
      seedInbox("Inbox 1");
      seedInbox("Inbox 2");
      seedOutbox("Outbox 1");
      seedOutbox("Outbox 2");
      seedOutbox("Outbox 3");

      const counts = purgeMessages();
      expect(counts.inbox).toBe(2);
      expect(counts.outbox).toBe(3);

      // Verify they're actually gone
      expect(listInboxMessages()).toHaveLength(0);
      expect(listOutboxMessages()).toHaveLength(0);
    });

    test("can purge inbox only when outbox is empty", () => {
      seedInbox("Inbox 1");

      const counts = purgeMessages();
      expect(counts.inbox).toBe(1);
      expect(counts.outbox).toBe(0);
    });

    test("is idempotent — purging twice returns zero on second call", () => {
      seedInbox("Inbox 1");
      seedOutbox("Outbox 1");

      purgeMessages();
      const counts = purgeMessages();
      expect(counts.inbox).toBe(0);
      expect(counts.outbox).toBe(0);
    });
  });
});
