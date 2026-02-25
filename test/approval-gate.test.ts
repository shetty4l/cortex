import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { join } from "path";
import type { AgentConfig } from "../src/agent";
import { runAgentLoop } from "../src/agent";
import {
  consumeApproval,
  getApprovalForTool,
  listPendingApprovals,
  proposeApproval,
  resolveApproval,
} from "../src/approval";
import { closeDatabase, getDatabase, initDatabase } from "../src/db";
import type { SkillRegistry } from "../src/skills";
import { StateLoader } from "../src/state";
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

// --- Database setup ---

let stateLoader: StateLoader;

beforeEach(() => {
  initDatabase(":memory:");
  stateLoader = new StateLoader(getDatabase());
});

afterEach(() => {
  closeDatabase();
});

// --- Helpers ---

function agentConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    models: ["test-model"],
    synapseUrl: mockUrl,
    toolTimeoutMs: 5000,
    maxToolRounds: 8,
    skillConfig: {},
    topicKey: "test-topic",
    stateLoader,
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

// Create a mock registry with both mutating and non-mutating tools
function createMockRegistry(): {
  registry: SkillRegistry;
  tools: OpenAITool[];
} {
  const toolDefs = [
    {
      name: "safe.read",
      description: "A safe read-only tool",
      inputSchema: { type: "object", properties: {} },
      mutatesState: false,
    },
    {
      name: "dangerous.delete",
      description: "A dangerous mutating tool",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
      },
      mutatesState: true,
    },
    {
      name: "dangerous.create",
      description: "Another mutating tool",
      inputSchema: { type: "object", properties: {} },
      mutatesState: true,
    },
  ];

  const registry: SkillRegistry = {
    tools: toolDefs,
    async executeTool(name, _args, _ctx) {
      if (name === "safe.read") {
        return { ok: true, value: { content: "Read data: [item1, item2]" } };
      }
      if (name === "dangerous.delete") {
        return { ok: true, value: { content: "Deleted successfully" } };
      }
      if (name === "dangerous.create") {
        return { ok: true, value: { content: "Created successfully" } };
      }
      return { ok: false, error: `unknown tool: ${name}` };
    },
    isMutating(name: string) {
      return toolDefs.find((t) => t.name === name)?.mutatesState ?? false;
    },
  };

  const tools: OpenAITool[] = toolDefs.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));

  return { registry, tools };
}

// --- Approval gate tests ---

describe("approval gate - non-mutating tools", () => {
  test("non-mutating tool executes immediately without approval", async () => {
    const { registry, tools } = createMockRegistry();

    let callNum = 0;
    mockHandler = () => {
      callNum++;
      if (callNum === 1) {
        return Response.json(
          toolCallResponse([
            { id: "call_1", name: "safe.read", arguments: "{}" },
          ]),
        );
      }
      return Response.json(openaiResponse("Here's the data I read"));
    };

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Read data" }],
      tools,
      registry,
      config: agentConfig(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Tool should execute directly
    expect(result.value.turns[1].role).toBe("tool");
    expect(result.value.turns[1].content).toContain("Read data");

    // No pending approvals should be created
    const pending = listPendingApprovals(undefined, stateLoader);
    expect(pending).toHaveLength(0);
  });

  test("non-mutating tool executes even with topicKey set", async () => {
    const { registry, tools } = createMockRegistry();

    let callNum = 0;
    mockHandler = () => {
      callNum++;
      if (callNum === 1) {
        return Response.json(
          toolCallResponse([
            { id: "call_1", name: "safe.read", arguments: "{}" },
          ]),
        );
      }
      return Response.json(openaiResponse("Done"));
    };

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Read" }],
      tools,
      registry,
      config: agentConfig({ topicKey: "my-topic" }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.turns[1].content).toContain("Read data");
  });
});

describe("approval gate - mutating tools", () => {
  test("mutating tool creates pending approval and returns waiting message", async () => {
    const { registry, tools } = createMockRegistry();

    let callNum = 0;
    mockHandler = () => {
      callNum++;
      if (callNum === 1) {
        return Response.json(
          toolCallResponse([
            {
              id: "call_1",
              name: "dangerous.delete",
              arguments: '{"id":"abc123"}',
            },
          ]),
        );
      }
      return Response.json(
        openaiResponse("I need approval to delete that item."),
      );
    };

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Delete item abc123" }],
      tools,
      registry,
      config: agentConfig({ topicKey: "test-topic" }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Tool result should indicate waiting for approval
    const toolMsg = result.value.turns[1];
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.content).toContain("requires approval");
    expect(toolMsg.content).toContain("dangerous.delete");

    // Should have approval_id in metadata
    expect(toolMsg.metadata?.approval_id).toBeTruthy();

    // Pending approval should be created
    const pending = listPendingApprovals("test-topic", stateLoader);
    expect(pending).toHaveLength(1);
    expect(pending[0].tool_name).toBe("dangerous.delete");
    expect(pending[0].tool_args_json).toBe('{"id":"abc123"}');
    expect(pending[0].status).toBe("pending");
  });

  test("mutating tool without topicKey executes immediately", async () => {
    const { registry, tools } = createMockRegistry();

    let callNum = 0;
    mockHandler = () => {
      callNum++;
      if (callNum === 1) {
        return Response.json(
          toolCallResponse([
            { id: "call_1", name: "dangerous.delete", arguments: "{}" },
          ]),
        );
      }
      return Response.json(openaiResponse("Deleted"));
    };

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Delete" }],
      tools,
      registry,
      config: agentConfig({ topicKey: undefined }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Without topicKey, mutating tools execute immediately
    expect(result.value.turns[1].content).toContain("Deleted successfully");
  });
});

describe("approval resolution flow", () => {
  test("approved approval allows tool execution", async () => {
    const { registry, tools } = createMockRegistry();
    const argsJson = '{"id":"item-to-delete"}';

    // Pre-create an approved approval
    const approval = proposeApproval(
      {
        topic_key: "test-topic",
        action: "Execute tool dangerous.delete",
        tool_name: "dangerous.delete",
        tool_args_json: argsJson,
      },
      stateLoader,
    );
    await resolveApproval(approval.id, "approved", stateLoader);

    let callNum = 0;
    mockHandler = () => {
      callNum++;
      if (callNum === 1) {
        return Response.json(
          toolCallResponse([
            { id: "call_1", name: "dangerous.delete", arguments: argsJson },
          ]),
        );
      }
      return Response.json(openaiResponse("Item deleted"));
    };

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Delete item" }],
      tools,
      registry,
      config: agentConfig({ topicKey: "test-topic" }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Tool should execute successfully
    expect(result.value.turns[1].content).toBe("Deleted successfully");

    // Approval should be consumed
    const stored = getApprovalForTool(
      "test-topic",
      "dangerous.delete",
      argsJson,
      stateLoader,
    );
    expect(stored?.status).toBe("consumed");
  });

  test("rejected approval returns error message without executing", async () => {
    const { registry, tools } = createMockRegistry();
    const argsJson = '{"id":"item-x"}';

    // Pre-create a rejected approval
    const approval = proposeApproval(
      {
        topic_key: "test-topic",
        action: "Execute tool dangerous.delete",
        tool_name: "dangerous.delete",
        tool_args_json: argsJson,
      },
      stateLoader,
    );
    await resolveApproval(approval.id, "rejected", stateLoader);

    let callNum = 0;
    mockHandler = () => {
      callNum++;
      if (callNum === 1) {
        return Response.json(
          toolCallResponse([
            { id: "call_1", name: "dangerous.delete", arguments: argsJson },
          ]),
        );
      }
      return Response.json(openaiResponse("User rejected the action"));
    };

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Delete item-x" }],
      tools,
      registry,
      config: agentConfig({ topicKey: "test-topic" }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should return rejection message
    expect(result.value.turns[1].content).toContain("rejected");
    expect(result.value.turns[1].content).toContain("declined");
  });

  test("expired approval triggers reproposal", async () => {
    const { registry, tools } = createMockRegistry();
    const argsJson = '{"id":"expired-item"}';

    // Pre-create an expired approval
    const oldApproval = proposeApproval(
      {
        topic_key: "test-topic",
        action: "Execute tool dangerous.delete",
        tool_name: "dangerous.delete",
        tool_args_json: argsJson,
      },
      stateLoader,
    );
    await resolveApproval(oldApproval.id, "expired", stateLoader);

    let callNum = 0;
    mockHandler = () => {
      callNum++;
      if (callNum === 1) {
        return Response.json(
          toolCallResponse([
            { id: "call_1", name: "dangerous.delete", arguments: argsJson },
          ]),
        );
      }
      return Response.json(
        openaiResponse("Previous approval expired, asking again"),
      );
    };

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Delete" }],
      tools,
      registry,
      config: agentConfig({ topicKey: "test-topic" }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should indicate reproposal
    expect(result.value.turns[1].content).toContain("requires approval");
    expect(result.value.turns[1].content).toContain("expired");

    // New approval should be created (pending)
    const newApprovalId = result.value.turns[1].metadata?.approval_id as string;
    expect(newApprovalId).toBeTruthy();
    expect(newApprovalId).not.toBe(oldApproval.id);

    // There should now be one pending approval
    const pending = listPendingApprovals("test-topic", stateLoader);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(newApprovalId);
  });

  test("consumed approval creates new pending approval for retry", async () => {
    const { registry, tools } = createMockRegistry();
    const argsJson = '{"id":"already-used"}';

    // Pre-create and consume an approval
    const oldApproval = proposeApproval(
      {
        topic_key: "test-topic",
        action: "Execute tool dangerous.delete",
        tool_name: "dangerous.delete",
        tool_args_json: argsJson,
      },
      stateLoader,
    );
    await resolveApproval(oldApproval.id, "approved", stateLoader);
    await consumeApproval(oldApproval.id, stateLoader);

    let callNum = 0;
    mockHandler = () => {
      callNum++;
      if (callNum === 1) {
        return Response.json(
          toolCallResponse([
            { id: "call_1", name: "dangerous.delete", arguments: argsJson },
          ]),
        );
      }
      return Response.json(openaiResponse("Need new approval"));
    };

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Delete again" }],
      tools,
      registry,
      config: agentConfig({ topicKey: "test-topic" }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should require new approval since old one is consumed
    expect(result.value.turns[1].content).toContain("requires approval");

    // New pending approval created
    const newApprovalId = result.value.turns[1].metadata?.approval_id as string;
    expect(newApprovalId).not.toBe(oldApproval.id);

    const pending = listPendingApprovals("test-topic", stateLoader);
    expect(pending).toHaveLength(1);
  });

  test("still-pending approval returns waiting message", async () => {
    const { registry, tools } = createMockRegistry();
    const argsJson = '{"id":"pending-item"}';

    // Pre-create a pending approval (not resolved)
    const pendingApproval = proposeApproval(
      {
        topic_key: "test-topic",
        action: "Execute tool dangerous.delete",
        tool_name: "dangerous.delete",
        tool_args_json: argsJson,
      },
      stateLoader,
    );

    let callNum = 0;
    mockHandler = () => {
      callNum++;
      if (callNum === 1) {
        return Response.json(
          toolCallResponse([
            { id: "call_1", name: "dangerous.delete", arguments: argsJson },
          ]),
        );
      }
      return Response.json(openaiResponse("Still waiting for approval"));
    };

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Delete pending item" }],
      tools,
      registry,
      config: agentConfig({ topicKey: "test-topic" }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should return same approval ID (reuse pending)
    expect(result.value.turns[1].content).toContain("requires approval");
    expect(result.value.turns[1].metadata?.approval_id).toBe(
      pendingApproval.id,
    );

    // No new approvals created
    const pending = listPendingApprovals("test-topic", stateLoader);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(pendingApproval.id);
  });
});

describe("approval gate - edge cases", () => {
  test("different tool args create different approvals", async () => {
    const { registry, tools } = createMockRegistry();

    // First call with args1
    let callNum = 0;
    mockHandler = () => {
      callNum++;
      if (callNum === 1) {
        return Response.json(
          toolCallResponse([
            {
              id: "call_1",
              name: "dangerous.delete",
              arguments: '{"id":"item1"}',
            },
          ]),
        );
      }
      if (callNum === 2) {
        return Response.json(openaiResponse("Waiting for approval 1"));
      }
      if (callNum === 3) {
        return Response.json(
          toolCallResponse([
            {
              id: "call_2",
              name: "dangerous.delete",
              arguments: '{"id":"item2"}',
            },
          ]),
        );
      }
      return Response.json(openaiResponse("Waiting for approval 2"));
    };

    // First request
    await runAgentLoop({
      messages: [{ role: "user", content: "Delete item1" }],
      tools,
      registry,
      config: agentConfig({ topicKey: "test-topic" }),
    });

    // Second request with different args
    await runAgentLoop({
      messages: [{ role: "user", content: "Delete item2" }],
      tools,
      registry,
      config: agentConfig({ topicKey: "test-topic" }),
    });

    // Should have two separate pending approvals
    const pending = listPendingApprovals("test-topic", stateLoader);
    expect(pending).toHaveLength(2);
    const args = pending.map((p) => p.tool_args_json).sort();
    expect(args).toContain('{"id":"item1"}');
    expect(args).toContain('{"id":"item2"}');
  });

  test("approval for one tool does not affect another tool", async () => {
    const { registry, tools } = createMockRegistry();

    // Create approval for dangerous.delete
    const approval = proposeApproval(
      {
        topic_key: "test-topic",
        action: "Execute tool dangerous.delete",
        tool_name: "dangerous.delete",
        tool_args_json: "{}",
      },
      stateLoader,
    );
    await resolveApproval(approval.id, "approved", stateLoader);

    let callNum = 0;
    mockHandler = () => {
      callNum++;
      if (callNum === 1) {
        // LLM requests dangerous.create instead
        return Response.json(
          toolCallResponse([
            { id: "call_1", name: "dangerous.create", arguments: "{}" },
          ]),
        );
      }
      return Response.json(openaiResponse("Need approval for create"));
    };

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Create something" }],
      tools,
      registry,
      config: agentConfig({ topicKey: "test-topic" }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // dangerous.create should still need its own approval
    expect(result.value.turns[1].content).toContain("requires approval");
    expect(result.value.turns[1].content).toContain("dangerous.create");
  });
});
