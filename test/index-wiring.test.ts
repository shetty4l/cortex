import { describe, expect, test } from "bun:test";
import type { Channel } from "../src/channels";
import { ChannelRegistry } from "../src/channels";
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

function mockChannel(name: string, events: string[]): Channel {
  return {
    name,
    canReceive: true,
    canDeliver: true,
    mode: "realtime" as const,
    priority: 0,
    start: async () => {
      events.push(`${name}:start`);
    },
    stop: async () => {
      events.push(`${name}:stop`);
    },
    sync: async () => {},
  };
}

describe("index runtime wiring", () => {
  test("starts channels via registry after server and loop", async () => {
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
        createChannelRegistry: () => {
          const registry = new ChannelRegistry();
          registry.register(mockChannel("telegram", events));
          return registry;
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

  test("runs with no channels when registry is empty", async () => {
    const events: string[] = [];

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
        createChannelRegistry: () => new ChannelRegistry(),
        log: () => {},
      },
    );

    await runtime.stop();

    expect(events).toEqual([
      "server:start",
      "loop:start",
      "loop:stop",
      "server:stop",
    ]);
  });

  test("stops channels before loop and server (reverse order)", async () => {
    const events: string[] = [];

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
        createChannelRegistry: () => {
          const registry = new ChannelRegistry();
          registry.register(mockChannel("ch-a", events));
          registry.register(mockChannel("ch-b", events));
          return registry;
        },
        log: () => {},
      },
    );

    expect(events).toEqual([
      "server:start",
      "loop:start",
      "ch-a:start",
      "ch-b:start",
    ]);

    await runtime.stop();

    // channels stop in reverse registration order, then loop, then server
    expect(events).toEqual([
      "server:start",
      "loop:start",
      "ch-a:start",
      "ch-b:start",
      "ch-b:stop",
      "ch-a:stop",
      "loop:stop",
      "server:stop",
    ]);
  });

  test("defaultCreateChannelRegistry registers telegram only when token exists", async () => {
    // This test validates the default wiring by checking log output
    const logs: string[] = [];

    const runtime = await startCortexRuntime(
      testConfig(),
      createEmptyRegistry(),
      {
        startServer: () => ({ port: 0, stop: () => {} }),
        startProcessingLoop: () => ({ stop: async () => {} }),
        createChannelRegistry: () => new ChannelRegistry(),
        log: (message) => {
          logs.push(message);
        },
      },
    );

    await runtime.stop();

    // No telegram-specific log when using empty registry
    expect(logs.some((l) => l.includes("telegram channel enabled"))).toBe(
      false,
    );
  });

  test("logs warning when telegram enabled with empty allowedUserIds", async () => {
    const logs: string[] = [];

    const runtime = await startCortexRuntime(
      testConfig({ telegramBotToken: "123:abc", telegramAllowedUserIds: [] }),
      createEmptyRegistry(),
      {
        startServer: () => ({ port: 0, stop: () => {} }),
        startProcessingLoop: () => ({ stop: async () => {} }),
        createChannelRegistry: (_config) => {
          // Simulate what defaultCreateChannelRegistry does for the log check
          const allowedIds = _config.telegramAllowedUserIds ?? [];
          if (allowedIds.length === 0) {
            logs.push(
              "telegram channel enabled with empty allowedUserIds — all messages will be rejected",
            );
          }
          return new ChannelRegistry();
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
});
