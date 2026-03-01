import { describe, expect, test } from "bun:test";
import type { SkillRegistry } from "../src/skills";
import {
  type BuiltinToolContext,
  createCombinedRegistry,
  resolveOutputChannel,
} from "../src/tools";

// --- Helpers ---

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
