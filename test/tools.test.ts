import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChannelRegistry } from "../src/channels";
import { SilentChannel } from "../src/channels/silent";
import { closeDatabase, initDatabase } from "../src/db";
import type { SkillRegistry } from "../src/skills";
import {
  type BuiltinToolContext,
  createCombinedRegistry,
  resolveOutputChannel,
} from "../src/tools";
import { createSendMessageTool } from "../src/tools/send-message";

// --- Helpers ---

/** Minimal deliverable channel for testing. */
class FakeDeliverChannel {
  readonly name = "telegram";
  readonly canReceive = true;
  readonly canDeliver = true;
  readonly mode = "realtime" as const;
  readonly priority = 0;
  async start() {}
  async stop() {}
  async sync() {}
}

function makeChannelRegistry(
  ...extra: Array<{ name: string; canDeliver: boolean }>
) {
  const registry = new ChannelRegistry();
  for (const ch of extra) {
    registry.register({
      name: ch.name,
      canReceive: true,
      canDeliver: ch.canDeliver,
      mode: "realtime" as const,
      priority: 0,
      start: async () => {},
      stop: async () => {},
      sync: async () => {},
    });
  }
  registry.register(new SilentChannel());
  return registry;
}

function emptySkillRegistry(): SkillRegistry {
  return {
    tools: [],
    async executeTool() {
      throw new Error("no skills");
    },
    isMutating() {
      return false;
    },
  };
}

// --- resolveOutputChannel ---

describe("resolveOutputChannel", () => {
  test("echoes back user-facing channels unchanged", () => {
    expect(resolveOutputChannel("telegram", {})).toBe("telegram");
  });

  test("routes thalamus to silent", () => {
    expect(resolveOutputChannel("thalamus", {})).toBe("silent");
  });

  test("routes calendar to silent", () => {
    expect(resolveOutputChannel("calendar", {})).toBe("silent");
  });

  test("applies alias when channel resolves to silent", () => {
    expect(
      resolveOutputChannel("thalamus", { silentChannelAlias: "telegram" }),
    ).toBe("telegram");
  });

  test("applies alias for explicit silent channel", () => {
    expect(
      resolveOutputChannel("silent", { silentChannelAlias: "telegram" }),
    ).toBe("telegram");
  });

  test("does not apply alias for non-silent channels", () => {
    expect(
      resolveOutputChannel("telegram", { silentChannelAlias: "email" }),
    ).toBe("telegram");
  });
});

// --- createCombinedRegistry ---

describe("createCombinedRegistry", () => {
  test("merges built-in and skill tools", () => {
    const builtin: BuiltinToolContext = { topicKey: "test-topic" };
    const fakeBuiltin = {
      definition: {
        name: "my_tool",
        description: "test",
        inputSchema: {},
        mutatesState: false,
      },
      async execute() {
        return { ok: true as const, value: { content: "ok" } };
      },
    };

    const combined = createCombinedRegistry(
      [fakeBuiltin],
      emptySkillRegistry(),
      () => builtin,
    );

    expect(combined.tools).toHaveLength(1);
    expect(combined.tools[0].name).toBe("my_tool");
  });

  test("dispatches to built-in tool by name", async () => {
    const ctx: BuiltinToolContext = { topicKey: "test-topic" };
    let receivedCtx: BuiltinToolContext | undefined;

    const fakeBuiltin = {
      definition: {
        name: "my_tool",
        description: "test",
        inputSchema: {},
        mutatesState: false,
      },
      async execute(_argsJson: string, c: BuiltinToolContext) {
        receivedCtx = c;
        return { ok: true as const, value: { content: "builtin-result" } };
      },
    };

    const combined = createCombinedRegistry(
      [fakeBuiltin],
      emptySkillRegistry(),
      () => ctx,
    );

    const result = await combined.executeTool("my_tool", "{}", {} as never);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe("builtin-result");
    }
    expect(receivedCtx?.topicKey).toBe("test-topic");
  });

  test("reports built-in mutating state", () => {
    const fakeBuiltin = {
      definition: {
        name: "mutating_tool",
        description: "test",
        inputSchema: {},
        mutatesState: true,
      },
      async execute() {
        return { ok: true as const, value: { content: "ok" } };
      },
    };

    const combined = createCombinedRegistry(
      [fakeBuiltin],
      emptySkillRegistry(),
      () => ({ topicKey: "" }),
    );

    expect(combined.isMutating("mutating_tool")).toBe(true);
    expect(combined.isMutating("unknown")).toBe(false);
  });
});

// --- send_message tool ---

describe("send_message tool", () => {
  beforeEach(() => {
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  test("queues a message to a valid channel", async () => {
    const channels = makeChannelRegistry({
      name: "telegram",
      canDeliver: true,
    });
    const tool = createSendMessageTool(channels);
    const ctx: BuiltinToolContext = { topicKey: "trip-japan" };

    const result = await tool.execute(
      JSON.stringify({ channel: "telegram", text: "Hello!" }),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toContain("telegram");
    }
  });

  test("rejects unknown channel", async () => {
    const channels = makeChannelRegistry({
      name: "telegram",
      canDeliver: true,
    });
    const tool = createSendMessageTool(channels);
    const ctx: BuiltinToolContext = { topicKey: "trip-japan" };

    const result = await tool.execute(
      JSON.stringify({ channel: "email", text: "Hello!" }),
      ctx,
    );

    expect(result.ok).toBe(false);
  });

  test("rejects channel that cannot deliver", async () => {
    const channels = makeChannelRegistry({
      name: "calendar",
      canDeliver: false,
    });
    const tool = createSendMessageTool(channels);
    const ctx: BuiltinToolContext = { topicKey: "trip-japan" };

    const result = await tool.execute(
      JSON.stringify({ channel: "calendar", text: "Hello!" }),
      ctx,
    );

    expect(result.ok).toBe(false);
  });

  test("rejects system channel (thalamus)", async () => {
    const channels = makeChannelRegistry({
      name: "telegram",
      canDeliver: true,
    });
    const tool = createSendMessageTool(channels);
    const ctx: BuiltinToolContext = { topicKey: "trip-japan" };

    const result = await tool.execute(
      JSON.stringify({ channel: "thalamus", text: "Routed!" }),
      ctx,
    );

    // thalamus is not registered as a channel, so should fail
    expect(result.ok).toBe(false);
  });

  test("requires channel argument", async () => {
    const channels = makeChannelRegistry({
      name: "telegram",
      canDeliver: true,
    });
    const tool = createSendMessageTool(channels);

    const result = await tool.execute(JSON.stringify({ text: "Hello!" }), {
      topicKey: "test",
    });

    expect(result.ok).toBe(false);
  });

  test("requires text argument", async () => {
    const channels = makeChannelRegistry({
      name: "telegram",
      canDeliver: true,
    });
    const tool = createSendMessageTool(channels);

    const result = await tool.execute(JSON.stringify({ channel: "telegram" }), {
      topicKey: "test",
    });

    expect(result.ok).toBe(false);
  });
});
