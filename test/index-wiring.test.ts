import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Channel } from "../src/channels";
import { ChannelRegistry } from "../src/channels";
import type { CortexConfig } from "../src/config";
import { startCortexRuntime } from "../src/index";
import { createEmptyRegistry } from "../src/skills";
import { StateLoader } from "../src/state";

function testConfig(overrides: Partial<CortexConfig> = {}): CortexConfig {
  return {
    host: "127.0.0.1",
    port: 7751,
    ingestApiKey: "test-key",
    synapseUrl: "http://127.0.0.1:7750",
    engramUrl: "http://127.0.0.1:7749",
    models: ["test-model"],
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

function mockStateLoader(): StateLoader {
  // Create a mock database for StateLoader
  const { Database } = require("bun:sqlite");
  const db = new Database(":memory:");
  return new StateLoader(db as Database);
}

describe("index runtime wiring", () => {
  test("starts channels via registry after server and loop", async () => {
    const events: string[] = [];
    const stateLoader = mockStateLoader();

    const runtime = await startCortexRuntime(
      testConfig(),
      createEmptyRegistry(),
      stateLoader,
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
          registry.register(mockChannel("test-channel", events));
          return registry;
        },
        log: () => {},
      },
    );

    expect(events).toEqual([
      "server:start",
      "loop:start",
      "test-channel:start",
    ]);

    await runtime.stop();

    expect(events).toEqual([
      "server:start",
      "loop:start",
      "test-channel:start",
      "test-channel:stop",
      "loop:stop",
      "server:stop",
    ]);
  });

  test("runs with no channels when registry is empty", async () => {
    const events: string[] = [];
    const stateLoader = mockStateLoader();

    const runtime = await startCortexRuntime(
      testConfig(),
      createEmptyRegistry(),
      stateLoader,
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
    const stateLoader = mockStateLoader();

    const runtime = await startCortexRuntime(
      testConfig(),
      createEmptyRegistry(),
      stateLoader,
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
});
