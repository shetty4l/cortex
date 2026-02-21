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
  closeDatabase,
  getDatabase,
  getTelegramOffset,
  initDatabase,
} from "../src/db";
import { startProcessingLoop } from "../src/loop";
import { createEmptyRegistry } from "../src/skills";
import {
  startTelegramDeliveryLoop,
  startTelegramIngestionLoop,
} from "../src/telegram";

const originalFetch = globalThis.fetch;

let mockSynapse: ReturnType<typeof Bun.serve>;
let mockEngram: ReturnType<typeof Bun.serve>;
let mockSynapseUrl: string;
let mockEngramUrl: string;

beforeAll(() => {
  mockSynapse = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      Response.json({
        id: "chat-roundtrip",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Roundtrip reply from synapse",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
  });

  mockEngram = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ memories: [], fallback_mode: false }),
  });

  mockSynapseUrl = `http://127.0.0.1:${mockSynapse.port}`;
  mockEngramUrl = `http://127.0.0.1:${mockEngram.port}`;
});

afterAll(() => {
  mockSynapse.stop(true);
  mockEngram.stop(true);
});

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  closeDatabase();
});

function testConfig(overrides: Partial<CortexConfig> = {}): CortexConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    ingestApiKey: "test-key",
    synapseUrl: mockSynapseUrl,
    engramUrl: mockEngramUrl,
    model: "test-model",
    activeWindowSize: 10,
    extractionInterval: 3,
    turnTtlDays: 30,
    schedulerTickSeconds: 30,
    schedulerTimezone: "UTC",
    telegramBotToken: "123:abc",
    telegramAllowedUserIds: [222],
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
  timeoutMs = 2500,
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

describe("telegram roundtrip", () => {
  test("ingests update, processes response, delivers outbox, and acks delivered", async () => {
    let getUpdatesCalls = 0;
    const sentPayloads: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (input: any, init: any) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (!url.startsWith("https://api.telegram.org/")) {
        return originalFetch(input as RequestInfo | URL, init);
      }

      if (url.endsWith("/getUpdates")) {
        getUpdatesCalls++;
        if (getUpdatesCalls === 1) {
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 900,
                message: {
                  message_id: 11,
                  date: 1700001000,
                  from: { id: 222 },
                  chat: { id: -42 },
                  message_thread_id: 9,
                  text: "hello from telegram user",
                },
              },
            ],
          });
        }

        return Response.json({ ok: true, result: [] });
      }

      if (url.endsWith("/sendMessage")) {
        const payload = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        sentPayloads.push(payload);
        return Response.json({
          ok: true,
          result: {
            message_id: 501,
            date: 1700001001,
            chat: { id: -42 },
          },
        });
      }

      return Response.json(
        { ok: false, description: "unexpected Telegram method" },
        { status: 404 },
      );
    }) as unknown as typeof fetch;

    const config = testConfig();
    const processingLoop = startProcessingLoop(config, createEmptyRegistry(), {
      pollBusyMs: 5,
      pollIdleMs: 5,
    });
    const ingestionLoop = startTelegramIngestionLoop(config, {
      onErrorDelayMs: 1,
      onEmptyDelayMs: 1,
    });
    const deliveryLoop = startTelegramDeliveryLoop(config, {
      maxBatch: 2,
      onErrorDelayMs: 1,
      onEmptyDelayMs: 1,
    });

    try {
      await waitFor(() => {
        const db = getDatabase();
        const inboxRow = db
          .prepare(
            "SELECT status FROM inbox_messages WHERE source = 'telegram' AND external_message_id = '900:11'",
          )
          .get() as { status: string } | null;
        const outboxRow = db
          .prepare(
            "SELECT status FROM outbox_messages WHERE source = 'telegram' AND topic_key = '-42:9' ORDER BY created_at DESC LIMIT 1",
          )
          .get() as { status: string } | null;

        return (
          getTelegramOffset("123:abc") === 901 &&
          inboxRow?.status === "done" &&
          outboxRow?.status === "delivered" &&
          sentPayloads.length === 1
        );
      });
    } finally {
      await deliveryLoop.stop();
      await ingestionLoop.stop();
      await processingLoop.stop();
    }

    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0].chat_id).toBe(-42);
    expect(sentPayloads[0].message_thread_id).toBe(9);
    expect(sentPayloads[0].text).toBe("Roundtrip reply from synapse");
    expect(sentPayloads[0].parse_mode).toBe("MarkdownV2");
  });
});
