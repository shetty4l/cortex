import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CortexConfig } from "../src/config";
import {
  closeDatabase,
  getDatabase,
  getTelegramOffset,
  initDatabase,
} from "../src/db";
import { startTelegramIngestionLoop } from "../src/telegram";

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
  timeoutMs = 1000,
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

describe("telegram ingestion loop", () => {
  test("enqueues authorized text messages and advances cursor", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      if (fetchCalls === 1) {
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 100,
              message: {
                message_id: 1,
                date: 1700000000,
                from: { id: 111 },
                chat: { id: -42 },
                text: "blocked",
              },
            },
            {
              update_id: 101,
              message: {
                message_id: 2,
                date: 1700000001,
                from: { id: 222 },
                chat: { id: -42 },
                message_thread_id: 9,
                text: "hello from authorized user",
              },
            },
            {
              update_id: 102,
            },
          ],
        });
      }

      return Response.json({ ok: true, result: [] });
    }) as unknown as typeof fetch;

    const loop = startTelegramIngestionLoop(
      testConfig({ telegramAllowedUserIds: [222] }),
      { onErrorDelayMs: 1 },
    );

    await waitFor(() => getTelegramOffset("123:abc") === 103);
    await loop.stop();

    const db = getDatabase();
    const rows = db
      .prepare(
        "SELECT source, external_message_id, topic_key, user_id, idempotency_key, text, occurred_at FROM inbox_messages ORDER BY created_at ASC",
      )
      .all() as Array<{
      source: string;
      external_message_id: string;
      topic_key: string;
      user_id: string;
      idempotency_key: string;
      text: string;
      occurred_at: number;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("telegram");
    expect(rows[0].external_message_id).toBe("101:2");
    expect(rows[0].topic_key).toBe("-42:9");
    expect(rows[0].user_id).toBe("222");
    expect(rows[0].idempotency_key).toBe("101:2");
    expect(rows[0].text).toBe("hello from authorized user");
    expect(rows[0].occurred_at).toBe(1700000001000);
  });

  test("empty allowed-user list rejects all messages silently", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      if (fetchCalls === 1) {
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 7,
              message: {
                message_id: 99,
                date: 1700000100,
                from: { id: 12345 },
                chat: { id: 888 },
                text: "should be ignored",
              },
            },
          ],
        });
      }
      return Response.json({ ok: true, result: [] });
    }) as unknown as typeof fetch;

    const loop = startTelegramIngestionLoop(
      testConfig({ telegramAllowedUserIds: [] }),
      {
        onErrorDelayMs: 1,
      },
    );

    await waitFor(() => getTelegramOffset("123:abc") === 8);
    await loop.stop();

    const db = getDatabase();
    const row = db
      .prepare("SELECT COUNT(*) AS cnt FROM inbox_messages")
      .get() as { cnt: number };
    expect(row.cnt).toBe(0);
  });

  test("restores persisted offset on restart and does not reprocess old updates", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async (_url: any, init: any) => {
      fetchCalls++;

      if (fetchCalls === 1) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).not.toHaveProperty("offset");
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 201,
              message: {
                message_id: 20,
                date: 1700000200,
                from: { id: 222 },
                chat: { id: -42 },
                text: "first run message",
              },
            },
          ],
        });
      }

      return Response.json({ ok: true, result: [] });
    }) as unknown as typeof fetch;

    const firstLoop = startTelegramIngestionLoop(
      testConfig({ telegramAllowedUserIds: [222] }),
      { onErrorDelayMs: 1 },
    );

    await waitFor(() => getTelegramOffset("123:abc") === 202);
    await firstLoop.stop();

    let restartFetchCalls = 0;
    globalThis.fetch = (async (_url: any, init: any) => {
      restartFetchCalls++;
      if (restartFetchCalls === 1) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.offset).toBe(202);
      }
      return Response.json({ ok: true, result: [] });
    }) as unknown as typeof fetch;

    const secondLoop = startTelegramIngestionLoop(
      testConfig({ telegramAllowedUserIds: [222] }),
      { onErrorDelayMs: 1 },
    );

    await waitFor(() => restartFetchCalls >= 1);
    await secondLoop.stop();

    const db = getDatabase();
    const count = db
      .prepare("SELECT COUNT(*) AS cnt FROM inbox_messages")
      .get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  test("deduplicates duplicate update_id:message_id into one inbox message", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      if (fetchCalls === 1) {
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 501,
              message: {
                message_id: 77,
                date: 1700000300,
                from: { id: 222 },
                chat: { id: -42 },
                text: "duplicate candidate",
              },
            },
            {
              update_id: 501,
              message: {
                message_id: 77,
                date: 1700000300,
                from: { id: 222 },
                chat: { id: -42 },
                text: "duplicate candidate",
              },
            },
          ],
        });
      }

      return Response.json({ ok: true, result: [] });
    }) as unknown as typeof fetch;

    const loop = startTelegramIngestionLoop(
      testConfig({ telegramAllowedUserIds: [222] }),
      { onErrorDelayMs: 1 },
    );

    await waitFor(() => getTelegramOffset("123:abc") === 502);
    await loop.stop();

    const db = getDatabase();
    const rows = db
      .prepare(
        "SELECT external_message_id, idempotency_key FROM inbox_messages ORDER BY created_at ASC",
      )
      .all() as Array<{ external_message_id: string; idempotency_key: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].external_message_id).toBe("501:77");
    expect(rows[0].idempotency_key).toBe("501:77");
  });

  test("does not reuse cursor when bot token changes", async () => {
    let botAFetchCalls = 0;
    globalThis.fetch = (async () => {
      botAFetchCalls++;
      if (botAFetchCalls === 1) {
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 300,
              message: {
                message_id: 1,
                date: 1700000400,
                from: { id: 222 },
                chat: { id: -1 },
                text: "from bot a",
              },
            },
          ],
        });
      }

      return Response.json({ ok: true, result: [] });
    }) as unknown as typeof fetch;

    const botALoop = startTelegramIngestionLoop(
      testConfig({
        telegramBotToken: "token-a",
        telegramAllowedUserIds: [222],
      }),
      { onErrorDelayMs: 1, onEmptyDelayMs: 1 },
    );

    let botBLoop: ReturnType<typeof startTelegramIngestionLoop> | null = null;
    try {
      await waitFor(() => getTelegramOffset("token-a") === 301);
      await botALoop.stop();

      let firstBody: Record<string, unknown> | null = null;
      globalThis.fetch = (async (_url: any, init: any) => {
        if (!firstBody) {
          firstBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        }
        return Response.json({ ok: true, result: [] });
      }) as unknown as typeof fetch;

      botBLoop = startTelegramIngestionLoop(
        testConfig({
          telegramBotToken: "token-b",
          telegramAllowedUserIds: [222],
        }),
        { onErrorDelayMs: 1, onEmptyDelayMs: 1 },
      );

      await waitFor(() => firstBody !== null);

      expect(firstBody).not.toHaveProperty("offset");
      expect(getTelegramOffset("token-a")).toBe(301);
      expect(getTelegramOffset("token-b")).toBeNull();
    } finally {
      if (botBLoop) {
        await botBLoop.stop();
      }
      await botALoop.stop();
    }
  });

  test("stop waits for in-flight poll and exits cleanly", async () => {
    let releasePoll: (() => void) | null = null;
    let fetchCalls = 0;

    globalThis.fetch = (async () => {
      fetchCalls++;
      await new Promise<void>((resolve) => {
        releasePoll = resolve;
      });
      return Response.json({ ok: true, result: [] });
    }) as unknown as typeof fetch;

    const loop = startTelegramIngestionLoop(testConfig(), {
      onErrorDelayMs: 1,
    });

    await waitFor(() => fetchCalls === 1);

    let stopped = false;
    const stopPromise = loop.stop().then(() => {
      stopped = true;
    });

    await Bun.sleep(20);
    expect(stopped).toBe(false);

    releasePoll!();
    await stopPromise;
    expect(stopped).toBe(true);
    expect(fetchCalls).toBe(1);
  });
});
