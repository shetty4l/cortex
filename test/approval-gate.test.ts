/**
 * Approval gate integration tests.
 *
 * Tests the end-to-end approval flow for mutating tools:
 * - Non-mutating tools execute immediately
 * - Mutating tools block and create approval request
 * - Approved approvals execute blocked tools
 * - Rejected approvals cancel execution
 * - Expired approvals return error
 * - State serialization/deserialization works
 * - Pending approvals block new messages
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { ok } from "@shetty4l/core/result";
import { StateLoader } from "@shetty4l/core/state";
import { runAgentLoop } from "../src/agent";
import {
  APPROVAL_TTL_MS,
  getApprovalForTool,
  isExpired,
  listPendingApprovals,
  PendingApproval,
  proposeApproval,
  resolveApproval,
} from "../src/approval";
import type { CortexConfig } from "../src/config";
import { closeDatabase, getDatabase, initDatabase } from "../src/db";
import { enqueueInboxMessage, getInboxMessage } from "../src/inbox";
import { handleApprovalResponse, startProcessingLoop } from "../src/loop";
import { listOutboxMessagesByTopic } from "../src/outbox";
import type { SkillRegistry, SkillToolResult } from "../src/skills";
import type { OpenAITool } from "../src/synapse";

let stateLoader: StateLoader;

// --- Mock Synapse server ---

let mockSynapse: ReturnType<typeof Bun.serve>;
let mockSynapseUrl: string;
let mockSynapseHandler: (req: Request) => Response | Promise<Response>;

beforeAll(() => {
  mockSynapseHandler = () =>
    Response.json({ error: "no mock configured" }, { status: 500 });

  mockSynapse = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      return mockSynapseHandler(req);
    },
  });

  mockSynapseUrl = `http://127.0.0.1:${mockSynapse.port}`;
});

afterAll(() => {
  mockSynapse.stop(true);
});

beforeEach(() => {
  initDatabase(":memory:");
  stateLoader = new StateLoader(getDatabase());
});

afterEach(async () => {
  await stateLoader.flush();
  closeDatabase();
});

// --- Test helpers ---

function testConfig(): CortexConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    ingestApiKey: "test-key",
    synapseUrl: mockSynapseUrl,
    engramUrl: "http://127.0.0.1:1", // Unreachable - tests don't need Engram
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
  };
}

function openaiResponse(content: string) {
  return {
    id: "chat-test",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function openaiToolCallResponse(
  toolCalls: Array<{ name: string; arguments: string }>,
) {
  return {
    id: "chat-test",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: toolCalls.map((tc, i) => ({
            id: `call_${i}`,
            type: "function",
            function: tc,
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function createMockRegistry(opts: {
  mutatingTools?: string[];
  executeResult?: SkillToolResult;
}): SkillRegistry {
  const mutatingSet = new Set(opts.mutatingTools ?? []);
  const tools = [
    {
      name: "safe.read",
      description: "Read-only tool",
      inputSchema: { type: "object", properties: {} },
      mutatesState: false,
    },
    {
      name: "dangerous.delete",
      description: "Mutating tool",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      mutatesState: true,
    },
  ];

  return {
    tools,
    async executeTool(_name, _argumentsJson, _ctx) {
      return ok(opts.executeResult ?? { content: "executed" });
    },
    isMutating(name) {
      if (mutatingSet.has(name)) return true;
      return name === "dangerous.delete";
    },
  };
}

function ingestMessage(
  overrides: Partial<{
    channel: string;
    externalMessageId: string;
    topicKey: string;
    userId: string;
    text: string;
    metadata: Record<string, unknown>;
  }> = {},
) {
  const id = crypto.randomUUID().slice(0, 8);
  return enqueueInboxMessage(stateLoader, {
    channel: overrides.channel ?? "test",
    externalMessageId: overrides.externalMessageId ?? `msg-${id}`,
    topicKey: overrides.topicKey ?? "topic-1",
    userId: overrides.userId ?? "user-1",
    text: overrides.text ?? "Hello",
    occurredAt: Date.now(),
    idempotencyKey: `key-${id}`,
    metadata: overrides.metadata,
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  pollMs = 50,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await Bun.sleep(pollMs);
  }
}

function makeFastLoop() {
  return { pollBusyMs: 10, pollIdleMs: 50, stateLoader };
}

// --- Tests ---

describe("approval gate - agent loop", () => {
  test("non-mutating tools execute immediately without approval", async () => {
    const registry = createMockRegistry({});
    const openAITools: OpenAITool[] = registry.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    let callNum = 0;
    mockSynapseHandler = async () => {
      callNum++;
      if (callNum === 1) {
        return Response.json(
          openaiToolCallResponse([{ name: "safe.read", arguments: "{}" }]),
        );
      }
      return Response.json(openaiResponse("Read complete"));
    };

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Read something" }],
      tools: openAITools,
      registry,
      config: {
        models: ["test-model"],
        synapseUrl: mockSynapseUrl,
        toolTimeoutMs: 10000,
        maxToolRounds: 8,
        skillConfig: {},
      },
      stateLoader,
      topicKey: "topic-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value.needsApproval).toBeFalsy();
    expect(result.value.response).toBe("Read complete");

    // No approvals created
    const pending = listPendingApprovals(stateLoader);
    expect(pending).toHaveLength(0);
  });

  test("mutating tools block and create pending approval", async () => {
    const registry = createMockRegistry({});
    const openAITools: OpenAITool[] = registry.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    mockSynapseHandler = async () => {
      return Response.json(
        openaiToolCallResponse([
          { name: "dangerous.delete", arguments: '{"id":"123"}' },
        ]),
      );
    };

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Delete item 123" }],
      tools: openAITools,
      registry,
      config: {
        models: ["test-model"],
        synapseUrl: mockSynapseUrl,
        toolTimeoutMs: 10000,
        maxToolRounds: 8,
        skillConfig: {},
      },
      stateLoader,
      topicKey: "topic-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value.needsApproval).toBe(true);
    expect(result.value.approvalId).toBeTruthy();
    expect(result.value.blockedToolCalls).toHaveLength(1);
    expect(result.value.blockedToolCalls?.[0].function.name).toBe(
      "dangerous.delete",
    );

    // Approval created
    const pending = listPendingApprovals(stateLoader, "topic-1");
    expect(pending).toHaveLength(1);
    expect(pending[0].toolName).toBe("dangerous.delete");
    expect(pending[0].agentStateJson).toBeTruthy();
    expect(pending[0].toolCallsJson).toBeTruthy();
  });

  test("approved approval is consumed and tools execute", async () => {
    const registry = createMockRegistry({});
    const openAITools: OpenAITool[] = registry.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    // First create an approved approval
    const approval = proposeApproval(stateLoader, {
      topicKey: "topic-1",
      action: "test",
      toolName: "dangerous.delete",
      toolArgsJson: '{"id":"123"}',
    });
    await resolveApproval(stateLoader, approval.id, "approved");

    let callNum = 0;
    mockSynapseHandler = async () => {
      callNum++;
      if (callNum === 1) {
        return Response.json(
          openaiToolCallResponse([
            { name: "dangerous.delete", arguments: '{"id":"123"}' },
          ]),
        );
      }
      return Response.json(openaiResponse("Deleted"));
    };

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Delete item 123" }],
      tools: openAITools,
      registry,
      config: {
        models: ["test-model"],
        synapseUrl: mockSynapseUrl,
        toolTimeoutMs: 10000,
        maxToolRounds: 8,
        skillConfig: {},
      },
      stateLoader,
      topicKey: "topic-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value.needsApproval).toBeFalsy();
    expect(result.value.response).toBe("Deleted");

    // Approval consumed
    const consumed = stateLoader.get(PendingApproval, approval.id);
    expect(consumed?.status).toBe("consumed");
  });
});

describe("approval gate - expiration", () => {
  test("isExpired returns true for expired approval", () => {
    const approval = proposeApproval(stateLoader, {
      topicKey: "topic-1",
      action: "test",
    });

    // Check at future time past expiry
    const futureTime = approval.proposedAt + APPROVAL_TTL_MS + 1000;
    expect(isExpired(approval, futureTime)).toBe(true);
  });

  test("expired approval is not consumed", async () => {
    const registry = createMockRegistry({});
    const openAITools: OpenAITool[] = registry.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    // Create an approved but expired approval
    const approval = proposeApproval(stateLoader, {
      topicKey: "topic-1",
      action: "test",
      toolName: "dangerous.delete",
    });
    // Manually set expiresAt to past
    approval.expiresAt = Date.now() - 1000;
    await approval.save();
    await resolveApproval(stateLoader, approval.id, "approved");

    mockSynapseHandler = async () => {
      return Response.json(
        openaiToolCallResponse([
          { name: "dangerous.delete", arguments: '{"id":"123"}' },
        ]),
      );
    };

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Delete" }],
      tools: openAITools,
      registry,
      config: {
        models: ["test-model"],
        synapseUrl: mockSynapseUrl,
        toolTimeoutMs: 10000,
        maxToolRounds: 8,
        skillConfig: {},
      },
      stateLoader,
      topicKey: "topic-1",
    });

    // Should need new approval since the existing one is expired
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value.needsApproval).toBe(true);
  });
});

describe("approval gate - state serialization", () => {
  test("agent state is correctly serialized in approval", async () => {
    const registry = createMockRegistry({});
    const openAITools: OpenAITool[] = registry.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    mockSynapseHandler = async () => {
      return Response.json(
        openaiToolCallResponse([
          { name: "dangerous.delete", arguments: '{"id":"456"}' },
        ]),
      );
    };

    const result = await runAgentLoop({
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Delete item 456" },
      ],
      tools: openAITools,
      registry,
      config: {
        models: ["test-model"],
        synapseUrl: mockSynapseUrl,
        toolTimeoutMs: 10000,
        maxToolRounds: 8,
        skillConfig: {},
      },
      stateLoader,
      topicKey: "topic-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value.needsApproval).toBe(true);

    const pending = listPendingApprovals(stateLoader, "topic-1");
    expect(pending).toHaveLength(1);

    // Verify state is correctly serialized
    const agentState = JSON.parse(pending[0].agentStateJson!);
    expect(agentState).toBeArray();
    // Should include system, user, and assistant (with tool_calls) messages
    expect(agentState.length).toBeGreaterThanOrEqual(3);
    expect(agentState[0].role).toBe("system");
    expect(agentState[1].role).toBe("user");
    expect(agentState[2].role).toBe("assistant");
    expect(agentState[2].tool_calls).toBeTruthy();

    // Verify tool calls are serialized
    const toolCalls = JSON.parse(pending[0].toolCallsJson!);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].function.name).toBe("dangerous.delete");
    expect(toolCalls[0].function.arguments).toBe('{"id":"456"}');
  });
});

describe("approval gate - handleApprovalResponse", () => {
  test("reject action returns cancellation message", async () => {
    const registry = createMockRegistry({});
    const openAITools: OpenAITool[] = registry.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    const approval = proposeApproval(stateLoader, {
      topicKey: "topic-1",
      action: "test",
      toolName: "dangerous.delete",
      agentStateJson: "[]",
      toolCallsJson: "[]",
    });

    const result = await handleApprovalResponse(
      stateLoader,
      approval.id,
      "reject",
      testConfig(),
      registry,
      openAITools,
    );

    expect(result).not.toBeNull();
    expect(result!.response).toBe("Action cancelled.");

    // Approval should be rejected
    const updated = stateLoader.get(PendingApproval, approval.id);
    expect(updated?.status).toBe("rejected");
  });

  test("not found approval returns error message", async () => {
    const registry = createMockRegistry({});
    const openAITools: OpenAITool[] = registry.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    const result = await handleApprovalResponse(
      stateLoader,
      "non-existent-id",
      "approve",
      testConfig(),
      registry,
      openAITools,
    );

    expect(result).not.toBeNull();
    expect(result!.response).toContain("not found");
  });

  test("already processed approval returns error message", async () => {
    const registry = createMockRegistry({});
    const openAITools: OpenAITool[] = registry.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    const approval = proposeApproval(stateLoader, {
      topicKey: "topic-1",
      action: "test",
    });
    await resolveApproval(stateLoader, approval.id, "approved");

    const result = await handleApprovalResponse(
      stateLoader,
      approval.id,
      "approve",
      testConfig(),
      registry,
      openAITools,
    );

    expect(result).not.toBeNull();
    expect(result!.response).toContain("already been processed");
  });

  test("expired approval returns expiry message", async () => {
    const registry = createMockRegistry({});
    const openAITools: OpenAITool[] = registry.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    const approval = proposeApproval(stateLoader, {
      topicKey: "topic-1",
      action: "test",
    });
    // Manually expire
    approval.expiresAt = Date.now() - 1000;
    await approval.save();

    const result = await handleApprovalResponse(
      stateLoader,
      approval.id,
      "approve",
      testConfig(),
      registry,
      openAITools,
    );

    expect(result).not.toBeNull();
    expect(result!.response).toContain("expired");

    // Should be marked as expired
    const updated = stateLoader.get(PendingApproval, approval.id);
    expect(updated?.status).toBe("expired");
  });

  test("approve action resumes agent loop and executes tools", async () => {
    const registry = createMockRegistry({
      executeResult: { content: "Tool executed!" },
    });
    const openAITools: OpenAITool[] = registry.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    // Create approval with serialized state
    const agentState = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Delete item" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_0",
            type: "function",
            function: { name: "dangerous.delete", arguments: '{"id":"999"}' },
          },
        ],
      },
    ];
    const toolCalls = [
      {
        id: "call_0",
        type: "function",
        function: { name: "dangerous.delete", arguments: '{"id":"999"}' },
      },
    ];

    const approval = proposeApproval(stateLoader, {
      topicKey: "topic-1",
      action: "test",
      toolName: "dangerous.delete",
      toolArgsJson: '{"id":"999"}',
      agentStateJson: JSON.stringify(agentState),
      toolCallsJson: JSON.stringify(toolCalls),
    });

    let callNum = 0;
    mockSynapseHandler = async () => {
      callNum++;
      // After tool execution, return final response
      return Response.json(openaiResponse("Item deleted successfully"));
    };

    const result = await handleApprovalResponse(
      stateLoader,
      approval.id,
      "approve",
      testConfig(),
      registry,
      openAITools,
    );

    expect(result).not.toBeNull();
    expect(result!.response).toBe("Item deleted successfully");

    // Approval should be approved
    const updated = stateLoader.get(PendingApproval, approval.id);
    expect(updated?.status).toBe("approved");
  });
});

describe("approval gate - processing loop integration", () => {
  test("pending approval blocks new messages and re-presents buttons", async () => {
    // Create a pending approval
    const approval = proposeApproval(stateLoader, {
      topicKey: "topic-block",
      action: "test",
      toolName: "dangerous.delete",
    });

    mockSynapseHandler = () =>
      Response.json(openaiResponse("Should not reach here"));

    const { eventId } = ingestMessage({
      text: "New message while approval pending",
      topicKey: "topic-block",
    });

    const loop = startProcessingLoop(
      testConfig(),
      createMockRegistry({}),
      makeFastLoop(),
    );

    await waitFor(
      () => getInboxMessage(stateLoader, eventId)?.status === "done",
    );
    await loop.stop();

    // Message should be done
    const inbox = getInboxMessage(stateLoader, eventId);
    expect(inbox?.status).toBe("done");

    // Outbox should have a message with approval buttons
    const outbox = listOutboxMessagesByTopic(stateLoader, "topic-block");
    expect(outbox).toHaveLength(1);
    expect(outbox[0].text).toContain("pending approval");

    const payload = JSON.parse(outbox[0].payload_json!);
    expect(payload.buttons).toHaveLength(2);
    expect(payload.buttons[0].callback_data).toContain(approval.id);
  });
});
