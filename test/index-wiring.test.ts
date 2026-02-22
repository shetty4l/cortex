import { describe, expect, test } from "bun:test";
import { TelegramChannel } from "../src/channels/telegram";
import type { CortexConfig } from "../src/config";
import { startCortexRuntime } from "../src/index";
import { createEmptyRegistry } from "../src/skills";

function testConfig(overrides: Partial<CortexConfig> = {}): CortexConfig {
  return {
    host: "127.0.0.1",
    port: 7751,
    ingestApiKey: "test-key",
    synapseUrl: "http://127.0.0.1:7750",
    engramUrl: "http://127.0.0.1:7749",
    model: "test-model",
    activeWindowSize: 10,
    extractionInterval: 3,
    turnTtlDays: 30,
    schedulerTickSeconds: 30,
    schedulerTimezone: "UTC",
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

describe("index runtime wiring", () => {
  test("starts telegram channel only when token exists", async () => {
    const events: string[] = [];

    const runtime = await startCortexRuntime(
      testConfig({ telegramBotToken: "123:abc" }),
      createEmptyRegistry(),
      {
        startServer: () => {
          events.push("server:start");
          return {
            port: 0,
            stop: () => {
              events.push("server:stop");
            },
          };
        },
        startProcessingLoop: () => {
          events.push("loop:start");
          return {
            stop: async () => {
              events.push("loop:stop");
            },
          };
        },
        createTelegramChannel: () => {
          return {
            name: "telegram",
            canReceive: true,
            canDeliver: true,
            mode: "realtime" as const,
            priority: 0,
            start: async () => {
              events.push("telegram:start");
            },
            stop: async () => {
              events.push("telegram:stop");
            },
            sync: async () => {},
          } as unknown as TelegramChannel;
        },
        log: () => {},
      },
    );

    expect(events).toEqual(["server:start", "loop:start", "telegram:start"]);

    await runtime.stop();

    expect(events).toEqual([
      "server:start",
      "loop:start",
      "telegram:start",
      "telegram:stop",
      "loop:stop",
      "server:stop",
    ]);
  });

  test("keeps telegram channel disabled when token is missing", async () => {
    const events: string[] = [];
    const logs: string[] = [];

    const runtime = await startCortexRuntime(
      testConfig(),
      createEmptyRegistry(),
      {
        startServer: () => {
          events.push("server:start");
          return {
            port: 0,
            stop: () => {
              events.push("server:stop");
            },
          };
        },
        startProcessingLoop: () => {
          events.push("loop:start");
          return {
            stop: async () => {
              events.push("loop:stop");
            },
          };
        },
        createTelegramChannel: () => null,
        log: (message) => {
          logs.push(message);
        },
      },
    );

    await runtime.stop();

    expect(events).toEqual([
      "server:start",
      "loop:start",
      "loop:stop",
      "server:stop",
    ]);
    expect(logs).toContain("telegram channel disabled (no token configured)");
  });

  test("cleans up started components when telegram startup fails", async () => {
    const events: string[] = [];

    await expect(
      startCortexRuntime(
        testConfig({ telegramBotToken: "123:abc" }),
        createEmptyRegistry(),
        {
          startServer: () => {
            events.push("server:start");
            return {
              port: 0,
              stop: () => {
                events.push("server:stop");
              },
            };
          },
          startProcessingLoop: () => {
            events.push("loop:start");
            return {
              stop: async () => {
                events.push("loop:stop");
              },
            };
          },
          createTelegramChannel: () => {
            return {
              name: "telegram",
              canReceive: true,
              canDeliver: true,
              mode: "realtime" as const,
              priority: 0,
              start: async () => {
                events.push("telegram:start");
                throw new Error("telegram startup failed");
              },
              stop: async () => {
                events.push("telegram:stop");
              },
              sync: async () => {},
            } as unknown as TelegramChannel;
          },
          log: () => {},
        },
      ),
    ).rejects.toThrow("telegram startup failed");

    expect(events).toEqual([
      "server:start",
      "loop:start",
      "telegram:start",
      "telegram:stop",
      "loop:stop",
      "server:stop",
    ]);
  });

  test("logs warning when telegram enabled with empty allowedUserIds", async () => {
    const logs: string[] = [];

    const runtime = await startCortexRuntime(
      testConfig({ telegramBotToken: "123:abc", telegramAllowedUserIds: [] }),
      createEmptyRegistry(),
      {
        startServer: () => ({ port: 0, stop: () => {} }),
        startProcessingLoop: () => ({ stop: async () => {} }),
        createTelegramChannel: () => {
          return {
            name: "telegram",
            canReceive: true,
            canDeliver: true,
            mode: "realtime" as const,
            priority: 0,
            start: async () => {},
            stop: async () => {},
            sync: async () => {},
          } as unknown as TelegramChannel;
        },
        log: (message) => {
          logs.push(message);
        },
      },
    );

    await runtime.stop();

    expect(
      logs.some((l) =>
        l.includes(
          "telegram channel enabled with empty allowedUserIds — all messages will be rejected",
        ),
      ),
    ).toBe(true);
  });

  test("logs detailed cleanup errors on startup failure", async () => {
    const logs: string[] = [];

    await expect(
      startCortexRuntime(
        testConfig({ telegramBotToken: "123:abc" }),
        createEmptyRegistry(),
        {
          startServer: () => ({
            port: 0,
            stop: () => {
              throw new Error("server cleanup failed");
            },
          }),
          startProcessingLoop: () => ({
            stop: async () => {
              throw new Error("loop cleanup failed");
            },
          }),
          createTelegramChannel: () => {
            return {
              name: "telegram",
              canReceive: true,
              canDeliver: true,
              mode: "realtime" as const,
              priority: 0,
              start: async () => {
                throw new Error("telegram startup failed");
              },
              stop: async () => {},
              sync: async () => {},
            } as unknown as TelegramChannel;
          },
          log: (message) => {
            logs.push(message);
          },
        },
      ),
    ).rejects.toThrow("telegram startup failed");

    const cleanupLog = logs.find((l) =>
      l.includes("startup cleanup encountered"),
    );
    expect(cleanupLog).toBeDefined();
    expect(cleanupLog).toContain("2 errors");
    expect(cleanupLog).toContain("loop cleanup failed");
    expect(cleanupLog).toContain("server cleanup failed");
  });
});
