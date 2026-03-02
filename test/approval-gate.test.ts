/**
 * Approval gate integration tests.
 *
 * Tests the end-to-end approval flow for mutating tools:
 * - Non-mutating tools execute immediately
 * - Mutating tools block and return needsApproval
 * - Re-run with approvalGranted=true executes blocked tools
 * - Rejected approvals complete message without execution
 * - Expired approvals mark message as failed
 * - One approval per message (uniqueness constraint)
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
  getApprovalById,
  isExpired,
  listPendingApprovals,
  PendingApproval,
  proposeApproval,
  resolveApproval,
} from "../src/approval";
import { CEREBELLUM_DEFAULTS } from "../src/cerebellum/types";
import type { CortexConfig } from "../src/config";
import { closeDatabase, getDatabase, initDatabase } from "../src/db";
import {
  enqueueInboxMessage,
  getInboxMessage,
  InboxMessage,
} from "../src/inbox";
import { startProcessingLoop } from "../src/loop";
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
    cerebellum: CEREBELLUM_DEFAULTS,
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
      topicKey: "topic-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value.needsApproval).toBeFalsy();
    expect(result.value.response).toBe("Read complete");
  });

  test("mutating tools block and return needsApproval", async () => {
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
      topicKey: "topic-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value.needsApproval).toBe(true);
    expect(result.value.blockedToolCalls).toHaveLength(1);
    expect(result.value.blockedToolCalls?.[0].function.name).toBe(
      "dangerous.delete",
    );
  });

  test("approvalGranted=true allows mutating tools to execute", async () => {
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
      topicKey: "topic-1",
      approvalGranted: true, // User approved
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value.needsApproval).toBeFalsy();
    expect(result.value.response).toBe("Deleted");
  });
});

describe("approval gate - expiration", () => {
  test("isExpired returns true for expired approval", () => {
    const { id: inboxMessageId } = ingestMessage({});
    const approval = proposeApproval(stateLoader, {
      topicKey: "topic-1",
      action: "test",
      inboxMessageId,
    });

    // Check at future time past expiry
    const futureTime = approval.proposedAt + APPROVAL_TTL_MS + 1000;
    expect(isExpired(approval, futureTime)).toBe(true);
  });
});

describe("approval gate - uniqueness", () => {
  test("proposeApproval throws if message already has pending approval", () => {
    const { id: inboxMessageId } = ingestMessage({});

    // First approval should succeed
    proposeApproval(stateLoader, {
      topicKey: "topic-1",
      action: "first",
      inboxMessageId,
    });

    // Second approval for same message should throw
    expect(() =>
      proposeApproval(stateLoader, {
        topicKey: "topic-1",
        action: "second",
        inboxMessageId,
      }),
    ).toThrow(/already has a pending approval/);
  });

  test("can create new approval after first is resolved", async () => {
    const { id: inboxMessageId } = ingestMessage({});

    const first = proposeApproval(stateLoader, {
      topicKey: "topic-1",
      action: "first",
      inboxMessageId,
    });
    await resolveApproval(stateLoader, first.id, "rejected");

    // Should succeed after first is resolved
    const second = proposeApproval(stateLoader, {
      topicKey: "topic-1",
      action: "second",
      inboxMessageId,
    });
    expect(second.id).toBeTruthy();
  });
});

describe("approval gate - getApprovalById", () => {
  test("getApprovalById returns approval", () => {
    const { id: inboxMessageId } = ingestMessage({});
    const created = proposeApproval(stateLoader, {
      topicKey: "topic-1",
      action: "test",
      inboxMessageId,
    });

    const found = getApprovalById(stateLoader, created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
  });

  test("getApprovalById returns null for non-existent", () => {
    const found = getApprovalById(stateLoader, "non-existent");
    expect(found).toBeNull();
  });
});

describe("approval gate - processing loop integration", () => {
  test("pending approval blocks new messages and re-presents buttons", async () => {
    // Create a pending approval (original message already processed/waiting)
    const { id: inboxMessageId } = ingestMessage({
      text: "Original message",
      topicKey: "topic-block",
    });
    // Mark original message as waiting for approval (won't be claimed)
    const origMsg = getInboxMessage(stateLoader, inboxMessageId)!;
    origMsg.status = "pending";
    origMsg.next_attempt_at = Date.now() + 24 * 60 * 60 * 1000; // Far future
    await origMsg.save();

    const approval = proposeApproval(stateLoader, {
      topicKey: "topic-block",
      action: "test",
      inboxMessageId,
      toolName: "dangerous.delete",
    });
    origMsg.approvalId = approval.id;
    await origMsg.save();

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
    expect(payload.buttons[0].data).toContain(approval.id);
  });

  test("approval response with approve re-queues message and it gets processed", async () => {
    // Create inbox message and approval
    const { id: inboxMessageId } = ingestMessage({
      text: "Delete something",
      topicKey: "topic-approve",
    });
    const inboxMsg = getInboxMessage(stateLoader, inboxMessageId)!;
    inboxMsg.status = "pending";
    inboxMsg.next_attempt_at = Date.now() + 24 * 60 * 60 * 1000; // Far future
    await inboxMsg.save();

    const approval = proposeApproval(stateLoader, {
      topicKey: "topic-approve",
      action: "test",
      inboxMessageId,
    });
    inboxMsg.approvalId = approval.id;
    await inboxMsg.save();

    // Ingest approval response
    const { eventId: responseId } = ingestMessage({
      text: "approve",
      topicKey: "topic-approve",
      metadata: {
        type: "approval_response",
        approvalId: approval.id,
        action: "approve",
      },
    });

    mockSynapseHandler = () =>
      Response.json(openaiResponse("Processing approved request"));

    const loop = startProcessingLoop(
      testConfig(),
      createMockRegistry({}),
      makeFastLoop(),
    );

    // Wait for response message to be processed
    await waitFor(
      () => getInboxMessage(stateLoader, responseId)?.status === "done",
    );

    // Wait a bit for original message to be re-queued and processed
    await waitFor(
      () => getInboxMessage(stateLoader, inboxMessageId)?.status === "done",
    );

    await loop.stop();

    // Approval should be resolved as approved
    const resolvedApproval = getApprovalById(stateLoader, approval.id);
    expect(resolvedApproval?.status).toBe("approved");

    // Original message should be done (was re-queued and processed)
    const originalMsg = getInboxMessage(stateLoader, inboxMessageId);
    expect(originalMsg?.status).toBe("done");

    // Outbox should have the response
    const outbox = listOutboxMessagesByTopic(stateLoader, "topic-approve");
    expect(
      outbox.some(
        (m) =>
          m.text.includes("Approved") || m.text.includes("Processing approved"),
      ),
    ).toBe(true);
  });

  test("approval response with reject completes message", async () => {
    // Create inbox message and approval
    const { id: inboxMessageId } = ingestMessage({
      text: "Delete something",
      topicKey: "topic-reject",
    });
    const inboxMsg = getInboxMessage(stateLoader, inboxMessageId)!;
    inboxMsg.status = "pending";
    inboxMsg.next_attempt_at = Date.now() + 24 * 60 * 60 * 1000;
    await inboxMsg.save();

    const approval = proposeApproval(stateLoader, {
      topicKey: "topic-reject",
      action: "test",
      inboxMessageId,
    });
    inboxMsg.approvalId = approval.id;
    await inboxMsg.save();

    // Ingest rejection response
    const { eventId: responseId } = ingestMessage({
      text: "reject",
      topicKey: "topic-reject",
      metadata: {
        type: "approval_response",
        approvalId: approval.id,
        action: "reject",
      },
    });

    mockSynapseHandler = () =>
      Response.json(openaiResponse("Should not be called"));

    const loop = startProcessingLoop(
      testConfig(),
      createMockRegistry({}),
      makeFastLoop(),
    );

    await waitFor(
      () => getInboxMessage(stateLoader, responseId)?.status === "done",
    );
    await loop.stop();

    // Original message should be marked done
    const originalMsg = getInboxMessage(stateLoader, inboxMessageId);
    expect(originalMsg?.status).toBe("done");

    // Approval should be rejected
    const resolvedApproval = getApprovalById(stateLoader, approval.id);
    expect(resolvedApproval?.status).toBe("rejected");

    // Outbox should have cancellation message
    const outbox = listOutboxMessagesByTopic(stateLoader, "topic-reject");
    expect(outbox.some((m) => m.text.includes("cancelled"))).toBe(true);
  });

  test("expired approval during response marks message as failed", async () => {
    // Create inbox message and expired approval
    const { id: inboxMessageId } = ingestMessage({
      text: "Delete something",
      topicKey: "topic-expired",
    });
    const inboxMsg = getInboxMessage(stateLoader, inboxMessageId)!;
    inboxMsg.status = "pending";
    inboxMsg.next_attempt_at = Date.now() + 24 * 60 * 60 * 1000;
    await inboxMsg.save();

    const approval = proposeApproval(stateLoader, {
      topicKey: "topic-expired",
      action: "test",
      inboxMessageId,
    });
    // Manually expire
    approval.expiresAt = Date.now() - 1000;
    await approval.save();
    inboxMsg.approvalId = approval.id;
    await inboxMsg.save();

    // Try to approve expired
    const { eventId: responseId } = ingestMessage({
      text: "approve",
      topicKey: "topic-expired",
      metadata: {
        type: "approval_response",
        approvalId: approval.id,
        action: "approve",
      },
    });

    mockSynapseHandler = () =>
      Response.json(openaiResponse("Should not be called"));

    const loop = startProcessingLoop(
      testConfig(),
      createMockRegistry({}),
      makeFastLoop(),
    );

    await waitFor(
      () => getInboxMessage(stateLoader, responseId)?.status === "done",
    );
    await loop.stop();

    // Original message should be marked failed
    const originalMsg = getInboxMessage(stateLoader, inboxMessageId);
    expect(originalMsg?.status).toBe("failed");
    expect(originalMsg?.error).toContain("expired");

    // Approval should be expired
    const resolvedApproval = getApprovalById(stateLoader, approval.id);
    expect(resolvedApproval?.status).toBe("expired");
  });

  test("approved message re-runs with approvalGranted and executes tools", async () => {
    // This test verifies the full flow:
    // 1. Message triggers mutating tool -> needsApproval
    // 2. Approval created, message linked
    // 3. Approve response -> message re-queued with approvalGranted
    // 4. Re-run executes tools

    let callNum = 0;
    mockSynapseHandler = async () => {
      callNum++;
      if (callNum === 1) {
        // First call: return tool call
        return Response.json(
          openaiToolCallResponse([
            { name: "dangerous.delete", arguments: '{"id":"999"}' },
          ]),
        );
      }
      if (callNum === 2) {
        // Second call: approval message generation
        return Response.json(
          openaiResponse("I need to delete item 999. Is that ok?"),
        );
      }
      if (callNum === 3) {
        // Third call: re-run after approval, return tool call again
        return Response.json(
          openaiToolCallResponse([
            { name: "dangerous.delete", arguments: '{"id":"999"}' },
          ]),
        );
      }
      // Fourth call: final response after tool execution
      return Response.json(openaiResponse("Item 999 deleted successfully"));
    };

    const { id: inboxMessageId } = ingestMessage({
      text: "Delete item 999",
      topicKey: "topic-full-flow",
    });

    const loop = startProcessingLoop(
      testConfig(),
      createMockRegistry({}),
      makeFastLoop(),
    );

    // Wait for approval to be created
    await waitFor(() => {
      const pending = listPendingApprovals(stateLoader, "topic-full-flow");
      return pending.length > 0;
    });

    const pending = listPendingApprovals(stateLoader, "topic-full-flow");
    const approval = pending[0];

    // Message should be waiting for approval
    const waitingMsg = getInboxMessage(stateLoader, inboxMessageId);
    expect(waitingMsg?.approvalId).toBe(approval.id);
    expect(waitingMsg?.status).toBe("pending");
    expect(waitingMsg?.next_attempt_at).toBeGreaterThan(Date.now());

    // Send approval response
    const { eventId: responseId } = ingestMessage({
      text: "approve",
      topicKey: "topic-full-flow",
      metadata: {
        type: "approval_response",
        approvalId: approval.id,
        action: "approve",
      },
    });

    // Wait for approval response to be processed
    await waitFor(
      () => getInboxMessage(stateLoader, responseId)?.status === "done",
    );

    // Wait for original message to be processed (re-run)
    await waitFor(
      () => getInboxMessage(stateLoader, inboxMessageId)?.status === "done",
    );

    await loop.stop();

    // Original message should be done
    const finalMsg = getInboxMessage(stateLoader, inboxMessageId);
    expect(finalMsg?.status).toBe("done");

    // Should have outbox messages including final response
    const outbox = listOutboxMessagesByTopic(stateLoader, "topic-full-flow");
    const finalResponse = outbox.find((m) => m.text.includes("deleted"));
    expect(finalResponse).toBeTruthy();
  });

  test("approved tool executes directly on approval (not on LLM re-run)", async () => {
    // This test verifies: the stored tool call executes immediately on approval,
    // regardless of what the LLM might return on a second call.
    //
    // BUG: Currently, approval just re-queues the message and hopes the LLM
    // makes the same tool call again. This test proves that's unreliable.

    let toolExecuted = false;
    let executedArgs = "";

    const mockRegistry: SkillRegistry = {
      tools: [
        {
          name: "dangerous.delete",
          description: "Mutating tool",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
          },
          mutatesState: true,
        },
      ],
      async executeTool(name: string, argsJson: string) {
        if (name === "dangerous.delete") {
          toolExecuted = true;
          executedArgs = argsJson;
          return ok({ content: `Deleted ${JSON.parse(argsJson).id}` });
        }
        return ok({ content: "ok" });
      },
      isMutating(name) {
        return name === "dangerous.delete";
      },
    };

    let callNum = 0;
    mockSynapseHandler = async () => {
      callNum++;
      if (callNum === 1) {
        // First: LLM requests tool call with id=999
        return Response.json(
          openaiToolCallResponse([
            { name: "dangerous.delete", arguments: '{"id":"999"}' },
          ]),
        );
      }
      if (callNum === 2) {
        // Second: approval message generation
        return Response.json(openaiResponse("Delete item 999?"));
      }
      // Third+: After approval, LLM returns DIFFERENT response (simulating non-determinism)
      // It does NOT call the tool again - just returns text
      return Response.json(openaiResponse("What would you like me to delete?"));
    };

    const { id: inboxMessageId } = ingestMessage({
      text: "Delete item 999",
      topicKey: "topic-direct-exec",
    });

    const loop = startProcessingLoop(
      testConfig(),
      mockRegistry,
      makeFastLoop(),
    );

    // Wait for approval to be created
    await waitFor(
      () => listPendingApprovals(stateLoader, "topic-direct-exec").length > 0,
    );
    const approval = listPendingApprovals(stateLoader, "topic-direct-exec")[0];

    // Verify tool details are stored in approval
    expect(approval.toolName).toBe("dangerous.delete");
    expect(approval.toolArgsJson).toBe('{"id":"999"}');

    // Tool should NOT have executed yet
    expect(toolExecuted).toBe(false);

    // Send approval response
    ingestMessage({
      text: "approve",
      topicKey: "topic-direct-exec",
      metadata: {
        type: "approval_response",
        approvalId: approval.id,
        action: "approve",
      },
    });

    // Wait for original message to complete
    await waitFor(
      () => getInboxMessage(stateLoader, inboxMessageId)?.status === "done",
    );
    await loop.stop();

    // CRITICAL ASSERTION: Tool was executed with the STORED args from approval
    // This should FAIL with current implementation (bug) and PASS after fix
    expect(toolExecuted).toBe(true);
    expect(executedArgs).toEqual('{"id":"999"}');
  });
});
