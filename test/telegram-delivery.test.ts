import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CortexConfig } from "../src/config";
import {
  ackOutboxMessage,
  closeDatabase,
  enqueueOutboxMessage,
  getOutboxMessage,
  initDatabase,
} from "../src/db";
import {
  parseTelegramTopicKey,
  splitTelegramMessageText,
  startTelegramDeliveryLoop,
} from "../src/telegram";

const originalFetch = globalThis.fetch;

function testConfig(overrides: Partial<CortexConfig> = {}): CortexConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    ingestApiKey: "test-key",
    synapseUrl: "http://127.0.0.1:7750",
    engramUrl: "http://127.0.0.1:7749",
    model: "test-model",
    activeWindowSize: 10,
    extractionInterval: 3,
    turnTtlDays: 30,
    schedulerTickSeconds: 30,
    schedulerTimezone: "UTC",
    telegramBotToken: "123:abc",
    telegramAllowedUserIds: [],
    outboxPollDefaultBatch: 20,
    outboxLeaseSeconds: 60,
    outboxMaxAttempts: 10,
    skillDirs: [],
    skillConfig: {},
    toolTimeoutMs: 20000,
    maxToolRounds: 8,
    ...overrides,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1500,
  pollMs = 10,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await Bun.sleep(pollMs);
  }
}

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  closeDatabase();
});

describe("telegram delivery helpers", () => {
  test("parseTelegramTopicKey accepts chat and chat:thread forms", () => {
    expect(parseTelegramTopicKey("-100")).toEqual({ chatId: -100 });
    expect(parseTelegramTopicKey("-100:42")).toEqual({
      chatId: -100,
      threadId: 42,
    });
    expect(parseTelegramTopicKey("bad")).toBeNull();
    expect(parseTelegramTopicKey("1:2:3")).toBeNull();
  });

  test("splitTelegramMessageText prefers paragraph, then line boundaries", () => {
    const text = `${"A".repeat(4090)}\n\n${"B".repeat(300)}\n${"C".repeat(300)}`;
    const chunks = splitTelegramMessageText(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].endsWith("\n\n")).toBe(true);
    expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  test("splitTelegramMessageText never exceeds 4096 at boundary edges", () => {
    const paragraphEdge = `${"A".repeat(4096)}\n\n${"B".repeat(32)}`;
    const lineEdge = `${"A".repeat(4096)}\n${"B".repeat(32)}`;
    const wordEdge = `${"A".repeat(4096)} ${"B".repeat(32)}`;

    for (const text of [paragraphEdge, lineEdge, wordEdge]) {
      const chunks = splitTelegramMessageText(text);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
      expect(chunks.join("")).toBe(text);
    }
  });

  test("splitTelegramMessageText guarantees forward progress on tiny limits", () => {
    const text = `\n\n${"a".repeat(10)} ${"b".repeat(10)}`;
    const chunks = splitTelegramMessageText(text, 1);

    expect(chunks.length).toBe(text.length);
    expect(chunks.every((chunk) => chunk.length === 1)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });
});

describe("telegram delivery loop", () => {
  test("delivers text with MarkdownV2 parse mode and then acks", async () => {
    const messageId = enqueueOutboxMessage({
      source: "telegram",
      topicKey: "-100:7",
      text: "hello **world**",
    });

    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(payload);

      return Response.json({
        ok: true,
        result: {
          message_id: 1,
          date: 1700000000,
          chat: { id: -100 },
        },
      });
    }) as unknown as typeof fetch;

    const loop = startTelegramDeliveryLoop(testConfig(), {
      maxBatch: 1,
      onErrorDelayMs: 1,
      onEmptyDelayMs: 1,
    });

    await waitFor(() => getOutboxMessage(messageId)?.status === "delivered");
    await loop.stop();

    expect(requests).toHaveLength(1);
    expect(requests[0].parse_mode).toBe("MarkdownV2");
    expect(requests[0].text).toBe("hello *world*");
    expect(requests[0].message_thread_id).toBe(7);
  });

  test("does not ack when any chunk fails", async () => {
    const text = `${"hello ".repeat(800)}\n\n${"world ".repeat(800)}`;
    const messageId = enqueueOutboxMessage({
      source: "telegram",
      topicKey: "-200",
      text,
    });

    let callCount = 0;
    globalThis.fetch = (async (_url: any, _init: any) => {
      callCount++;
      if (callCount === 2) {
        return new Response("upstream error", { status: 500 });
      }

      return Response.json({
        ok: true,
        result: {
          message_id: callCount,
          date: 1700000000,
          chat: { id: -200 },
        },
      });
    }) as unknown as typeof fetch;

    const loop = startTelegramDeliveryLoop(testConfig(), {
      maxBatch: 1,
      onErrorDelayMs: 1,
      onEmptyDelayMs: 1,
    });

    await waitFor(() => callCount >= 2);
    await Bun.sleep(30);
    await loop.stop();

    const row = getOutboxMessage(messageId);
    expect(row).not.toBeNull();
    expect(row!.status).not.toBe("delivered");
  });

  test("delivers long MarkdownV2 content without chunk parse errors", async () => {
    const text = `${"snake_case_value ".repeat(260)}\n\n${"more_text_with_underscores ".repeat(260)}`;
    const messageId = enqueueOutboxMessage({
      source: "telegram",
      topicKey: "-201",
      text,
    });

    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(payload);
      const chunk = String(payload.text ?? "");

      if (chunk.endsWith("\\")) {
        return new Response("can't parse entities", { status: 400 });
      }

      return Response.json({
        ok: true,
        result: {
          message_id: requests.length,
          date: 1700000000,
          chat: { id: -201 },
        },
      });
    }) as unknown as typeof fetch;

    const loop = startTelegramDeliveryLoop(testConfig(), {
      maxBatch: 1,
      onErrorDelayMs: 1,
      onEmptyDelayMs: 1,
    });

    await waitFor(
      () => getOutboxMessage(messageId)?.status === "delivered",
      3000,
    );
    await loop.stop();

    expect(requests.length).toBeGreaterThan(1);
    expect(
      requests.every((payload) => payload.parse_mode === "MarkdownV2"),
    ).toBe(true);
  });

  test("logs lease_conflict when ack fails due to expired lease", async () => {
    const messageId = enqueueOutboxMessage({
      source: "telegram",
      topicKey: "-300",
      text: "test message",
    });

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      await Bun.sleep(150);
      return Response.json({
        ok: true,
        result: {
          message_id: 1,
          date: 1700000000,
          chat: { id: -300 },
        },
      });
    }) as unknown as typeof fetch;

    const loop = startTelegramDeliveryLoop(testConfig(), {
      maxBatch: 1,
      leaseSeconds: 0.1,
      onErrorDelayMs: 1,
      onEmptyDelayMs: 1,
    });

    await waitFor(() => fetchCalled, 2000);
    await Bun.sleep(200);
    await loop.stop();

    expect(fetchCalled).toBe(true);

    const row = getOutboxMessage(messageId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("leased");
    expect(row!.attempts).toBeGreaterThanOrEqual(1);
  });
});
