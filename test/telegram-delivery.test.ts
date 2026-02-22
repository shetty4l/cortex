import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  parseTelegramTopicKey,
  TelegramChannel,
} from "../src/channels/telegram";
import type { CortexConfig } from "../src/config";
import {
  ackOutboxMessage,
  closeDatabase,
  enqueueOutboxMessage,
  getOutboxMessage,
  initDatabase,
} from "../src/db";

const originalFetch = globalThis.fetch;

/** Helper to start a TelegramChannel for delivery testing. */
function startTelegramDeliveryLoop(
  config: CortexConfig,
  options?: {
    maxBatch?: number;
    leaseSeconds?: number;
    onErrorDelayMs?: number;
    onEmptyDelayMs?: number;
  },
): { stop(): Promise<void> } {
  const channel = new TelegramChannel(config, {
    deliveryMaxBatch: options?.maxBatch,
    deliveryLeaseSeconds: options?.leaseSeconds,
    deliveryOnErrorDelayMs: options?.onErrorDelayMs,
    deliveryOnEmptyDelayMs: options?.onEmptyDelayMs,
    ingestionOnEmptyDelayMs: 50,
  });
  channel.start();
  return { stop: () => channel.stop() };
}

/**
 * Wrap a fetch mock to also handle getUpdates calls (return empty updates).
 * This is needed because TelegramChannel runs both ingestion and delivery.
 */
function withGetUpdatesStub(
  sendHandler: (url: string, init: RequestInit) => Promise<Response>,
): typeof fetch {
  return (async (input: any, init: any) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (typeof url === "string" && url.includes("/getUpdates")) {
      return Response.json({ ok: true, result: [] });
    }
    return sendHandler(url as string, init as RequestInit);
  }) as unknown as typeof fetch;
}

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
    synapseTimeoutMs: 60_000,
    thalamusModel: "test-model",
    thalamusSyncIntervalMs: 21_600_000,
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
});

describe("telegram delivery loop", () => {
  test("delivers text with MarkdownV2 parse mode and then acks", async () => {
    const messageId = enqueueOutboxMessage({
      channel: "telegram",
      topicKey: "-100:7",
      text: "hello **world**",
    });

    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = withGetUpdatesStub(async (_url, init) => {
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
    });

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
      channel: "telegram",
      topicKey: "-200",
      text,
    });

    let callCount = 0;
    globalThis.fetch = withGetUpdatesStub(async (_url, _init) => {
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
    });

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
      channel: "telegram",
      topicKey: "-201",
      text,
    });

    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = withGetUpdatesStub(async (_url, init) => {
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
    });

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
      channel: "telegram",
      topicKey: "-300",
      text: "test message",
    });

    let fetchCalled = false;
    globalThis.fetch = withGetUpdatesStub(async () => {
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
    });

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

  test("delivers to fallback private chat for non-numeric topic keys", async () => {
    const messageId = enqueueOutboxMessage({
      channel: "telegram",
      topicKey: "manchester-united-football-matches",
      text: "Upcoming match tomorrow",
    });

    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = withGetUpdatesStub(async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(payload);
      return Response.json({
        ok: true,
        result: { message_id: 1, date: 1700000000, chat: { id: 6052033650 } },
      });
    });

    const loop = startTelegramDeliveryLoop(
      testConfig({ telegramAllowedUserIds: [6052033650] }),
      { maxBatch: 1, onErrorDelayMs: 1, onEmptyDelayMs: 1 },
    );

    await waitFor(() => getOutboxMessage(messageId)?.status === "delivered");
    await loop.stop();

    expect(requests).toHaveLength(1);
    expect(requests[0].chat_id).toBe(6052033650);
    expect(requests[0].message_thread_id).toBeUndefined();
  });

  test("fails delivery when no fallback user ID and non-numeric topic key", async () => {
    const messageId = enqueueOutboxMessage({
      channel: "telegram",
      topicKey: "some-semantic-topic",
      text: "This should fail",
    });

    globalThis.fetch = withGetUpdatesStub(async () => {
      return Response.json({
        ok: true,
        result: { message_id: 1, date: 1700000000, chat: { id: 1 } },
      });
    });

    const loop = startTelegramDeliveryLoop(
      testConfig({ telegramAllowedUserIds: [] }),
      { maxBatch: 1, onErrorDelayMs: 1, onEmptyDelayMs: 1 },
    );

    // Wait briefly — message should NOT be delivered (no fallback)
    await Bun.sleep(100);
    await loop.stop();

    const row = getOutboxMessage(messageId);
    expect(row).not.toBeNull();
    expect(row!.status).not.toBe("delivered");
  });
});
