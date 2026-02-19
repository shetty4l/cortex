import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { join } from "path";
import type { AgentConfig } from "../src/agent";
import { runAgentLoop } from "../src/agent";
import type { SkillRegistry } from "../src/skills";
import { createEmptyRegistry, loadSkills } from "../src/skills";
import type { ChatMessage, OpenAITool } from "../src/synapse";

// --- Mock Synapse server ---

let mockServer: ReturnType<typeof Bun.serve>;
let mockUrl: string;
let mockHandler: (req: Request) => Response | Promise<Response>;

beforeAll(() => {
  mockHandler = () =>
    Response.json({ error: "no mock configured" }, { status: 500 });

  mockServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      return mockHandler(req);
    },
  });

  mockUrl = `http://127.0.0.1:${mockServer.port}`;
});

afterAll(() => {
  mockServer.stop(true);
});

// --- Helpers ---

function agentConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    model: "test-model",
    synapseUrl: mockUrl,
    toolTimeoutMs: 5000,
    maxToolRounds: 8,
    skillConfig: {},
    ...overrides,
  };
}

function openaiResponse(content: string, finishReason = "stop") {
  return {
    id: "chat-test",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function toolCallResponse(
  toolCalls: Array<{ id: string; name: string; arguments: string }>,
  content: string | null = null,
) {
  return {
    id: "chat-test",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

// Load real skills from fixtures
let registry: SkillRegistry;
let tools: OpenAITool[];

beforeAll(async () => {
  const skillDir = join(import.meta.dir, "fixtures/skills-valid");
  const result = await loadSkills([skillDir], {});
  if (!result.ok) throw new Error(`Failed to load skills: ${result.error}`);
  registry = result.value;
  tools = registry.tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
});

// --- Tests ---

describe("runAgentLoop", () => {
  test("no tool calls — pass-through response", async () => {
    mockHandler = () => Response.json(openaiResponse("Hello! How can I help?"));

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Hi" }],
      tools,
      registry,
      config: agentConfig(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.response).toBe("Hello! How can I help?");
    expect(result.value.turns).toHaveLength(1);
    expect(result.value.turns[0].role).toBe("assistant");
    expect(result.value.turns[0].content).toBe("Hello! How can I help?");
  });

  test("single tool call round trip", async () => {
    let callNum = 0;
    mockHandler = () => {
      callNum++;
      if (callNum === 1) {
        return Response.json(
          toolCallResponse([
            {
              id: "call_1",
              name: "echo.say",
              arguments: '{"text":"hello world"}',
            },
          ]),
        );
      }
      return Response.json(openaiResponse("The echo says: hello world"));
    };

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Echo hello world" }],
      tools,
      registry,
      config: agentConfig(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.response).toBe("The echo says: hello world");
    // Turns: assistant(tool_calls) + tool(result) + assistant(final)
    expect(result.value.turns).toHaveLength(3);
    expect(result.value.turns[0].role).toBe("assistant");
    expect(result.value.turns[0].tool_calls).toHaveLength(1);
    expect(result.value.turns[1].role).toBe("tool");
    expect(result.value.turns[1].tool_call_id).toBe("call_1");
    expect(result.value.turns[2].role).toBe("assistant");
    expect(result.value.turns[2].content).toBe("The echo says: hello world");
  });

  test("multiple parallel tool calls", async () => {
    let callNum = 0;
    mockHandler = () => {
      callNum++;
      if (callNum === 1) {
        return Response.json(
          toolCallResponse([
            {
              id: "call_a",
              name: "echo.say",
              arguments: '{"text":"first"}',
            },
            {
              id: "call_b",
              name: "math.add",
              arguments: '{"a":10,"b":20}',
            },
          ]),
        );
      }
      return Response.json(openaiResponse("Echo said first, and 10+20 = 30"));
    };

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Echo and add" }],
      tools,
      registry,
      config: agentConfig(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Turns: assistant(2 tool_calls) + 2 tool results + assistant(final)
    expect(result.value.turns).toHaveLength(4);
    expect(result.value.turns[0].tool_calls).toHaveLength(2);
    expect(result.value.turns[1].role).toBe("tool");
    expect(result.value.turns[2].role).toBe("tool");
  });

  test("multi-round tool calling", async () => {
    let callNum = 0;
    mockHandler = () => {
      callNum++;
      if (callNum === 1) {
        return Response.json(
          toolCallResponse([
            {
              id: "c1",
              name: "math.add",
              arguments: '{"a":1,"b":2}',
            },
          ]),
        );
      }
      if (callNum === 2) {
        // Second round — use result from first
        return Response.json(
          toolCallResponse([
            {
              id: "c2",
              name: "math.add",
              arguments: '{"a":3,"b":4}',
            },
          ]),
        );
      }
      return Response.json(openaiResponse("1+2=3, then 3+4=7"));
    };

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Do two additions" }],
      tools,
      registry,
      config: agentConfig(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.response).toBe("1+2=3, then 3+4=7");
    // 2 rounds: (assistant+tool) + (assistant+tool) + final_assistant = 5 turns
    expect(result.value.turns).toHaveLength(5);
  });

  test("tool error — skill throws", async () => {
    let callNum = 0;
    mockHandler = () => {
      callNum++;
      if (callNum === 1) {
        return Response.json(
          toolCallResponse([
            {
              id: "c1",
              name: "echo.say",
              // Missing required field — skill will throw when parsing
              arguments: "{}",
            },
          ]),
        );
      }
      return Response.json(openaiResponse("I encountered an error"));
    };

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Echo nothing" }],
      tools,
      registry,
      config: agentConfig(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The tool result should still be present (with error content)
    // and the model should have been called again
    expect(result.value.turns).toHaveLength(3);
    expect(result.value.turns[1].role).toBe("tool");
  });

  test("tool timeout", async () => {
    // Create a custom registry with a slow tool
    const slowRegistry: SkillRegistry = {
      tools: [
        {
          name: "slow.wait",
          description: "A slow tool",
          inputSchema: { type: "object", properties: {} },
          mutatesState: false,
        },
      ],
      async executeTool(_name, _args, _ctx) {
        // Wait longer than timeout
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return { ok: true, value: { content: "done" } } as never;
      },
      isMutating: () => false,
    };

    let callNum = 0;
    mockHandler = () => {
      callNum++;
      if (callNum === 1) {
        return Response.json(
          toolCallResponse([{ id: "c1", name: "slow.wait", arguments: "{}" }]),
        );
      }
      return Response.json(openaiResponse("Tool timed out"));
    };

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Wait" }],
      tools: [
        {
          type: "function",
          function: {
            name: "slow.wait",
            description: "A slow tool",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      registry: slowRegistry,
      config: agentConfig({ toolTimeoutMs: 100 }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.turns[1].role).toBe("tool");
    expect(result.value.turns[1].content).toContain("timed out");
  });

  test("argument parse failure", async () => {
    let callNum = 0;
    mockHandler = () => {
      callNum++;
      if (callNum === 1) {
        return Response.json(
          toolCallResponse([
            {
              id: "c1",
              name: "echo.say",
              arguments: "not valid json{{{",
            },
          ]),
        );
      }
      return Response.json(openaiResponse("Parse error handled"));
    };

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Bad args" }],
      tools,
      registry,
      config: agentConfig(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.turns[1].role).toBe("tool");
    expect(result.value.turns[1].content).toContain("Invalid JSON");
  });

  test("max rounds exceeded", async () => {
    // Every call returns tool_calls
    mockHandler = () =>
      Response.json(
        toolCallResponse([
          {
            id: `c_${Date.now()}`,
            name: "echo.say",
            arguments: '{"text":"loop"}',
          },
        ]),
      );

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Loop forever" }],
      tools,
      registry,
      config: agentConfig({ maxToolRounds: 2 }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.response).toContain("unable to complete the task");
    // 2 rounds: each has assistant + tool = 4 turns
    expect(result.value.turns).toHaveLength(4);
  });

  test("Synapse error during loop", async () => {
    let callNum = 0;
    mockHandler = () => {
      callNum++;
      if (callNum === 1) {
        return Response.json(
          toolCallResponse([
            {
              id: "c1",
              name: "echo.say",
              arguments: '{"text":"hi"}',
            },
          ]),
        );
      }
      // Second call fails
      return Response.json(
        { error: { message: "boom", type: "server_error" } },
        { status: 500 },
      );
    };

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Will fail" }],
      tools,
      registry,
      config: agentConfig(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("500");
  });

  test("unknown tool returns error to model", async () => {
    let callNum = 0;
    mockHandler = () => {
      callNum++;
      if (callNum === 1) {
        return Response.json(
          toolCallResponse([
            {
              id: "c1",
              name: "nonexistent.tool",
              arguments: "{}",
            },
          ]),
        );
      }
      return Response.json(openaiResponse("Tool not found"));
    };

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Unknown tool" }],
      tools,
      registry,
      config: agentConfig(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.turns[1].role).toBe("tool");
    expect(result.value.turns[1].content).toContain("Error:");
    expect(result.value.turns[1].content).toContain("unknown tool");
  });
});
