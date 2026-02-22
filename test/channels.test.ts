import { describe, expect, test } from "bun:test";
import { type Channel, ChannelRegistry } from "../src/channels/index";

function mockChannel(
  name: string,
  overrides: Partial<Channel> = {},
): Channel & { calls: string[] } {
  const calls: string[] = [];
  return {
    name,
    canReceive: true,
    canDeliver: true,
    mode: "realtime",
    priority: 0,
    async start() {
      calls.push(`start:${name}`);
    },
    async stop() {
      calls.push(`stop:${name}`);
    },
    async sync() {
      calls.push(`sync:${name}`);
    },
    calls,
    ...overrides,
  };
}

describe("ChannelRegistry", () => {
  test("register a channel and retrieve via getAll", () => {
    const registry = new ChannelRegistry();
    const ch = mockChannel("telegram");
    registry.register(ch);

    const all = registry.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("telegram");
  });

  test("register duplicate name throws error", () => {
    const registry = new ChannelRegistry();
    registry.register(mockChannel("telegram"));

    expect(() => registry.register(mockChannel("telegram"))).toThrow(
      "Channel 'telegram' already registered",
    );
  });

  test("get returns registered channel by name", () => {
    const registry = new ChannelRegistry();
    const ch = mockChannel("calendar");
    registry.register(ch);

    expect(registry.get("calendar")).toBe(ch);
  });

  test("get returns undefined for unknown name", () => {
    const registry = new ChannelRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  test("getAll returns empty array when no channels registered", () => {
    const registry = new ChannelRegistry();
    expect(registry.getAll()).toEqual([]);
  });

  test("startAll calls start on all channels in registration order", async () => {
    const registry = new ChannelRegistry();
    const order: string[] = [];
    const a = mockChannel("a");
    const b = mockChannel("b");
    const c = mockChannel("c");
    // share a single order array
    a.start = async () => {
      order.push("start:a");
    };
    b.start = async () => {
      order.push("start:b");
    };
    c.start = async () => {
      order.push("start:c");
    };

    registry.register(a);
    registry.register(b);
    registry.register(c);

    await registry.startAll();
    expect(order).toEqual(["start:a", "start:b", "start:c"]);
  });

  test("stopAll calls stop on all channels in reverse order", async () => {
    const registry = new ChannelRegistry();
    const order: string[] = [];
    const a = mockChannel("a");
    const b = mockChannel("b");
    const c = mockChannel("c");
    a.stop = async () => {
      order.push("stop:a");
    };
    b.stop = async () => {
      order.push("stop:b");
    };
    c.stop = async () => {
      order.push("stop:c");
    };

    registry.register(a);
    registry.register(b);
    registry.register(c);

    await registry.stopAll();
    expect(order).toEqual(["stop:c", "stop:b", "stop:a"]);
  });

  test("register multiple channels and getAll preserves order", () => {
    const registry = new ChannelRegistry();
    registry.register(mockChannel("telegram"));
    registry.register(mockChannel("calendar"));
    registry.register(mockChannel("silent"));

    const names = registry.getAll().map((c) => c.name);
    expect(names).toEqual(["telegram", "calendar", "silent"]);
  });
});
