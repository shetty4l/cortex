/**
 * Agent tool-calling loop for Cortex.
 *
 * Executes a multi-round tool-calling loop: sends messages to the LLM,
 * executes any requested tool calls in parallel, appends results, and
 * repeats until the model produces a final text response or the maximum
 * number of rounds is reached.
 *
 * Design:
 * - Tools are frozen across iterations (cache-aware — stable prefix)
 * - All tool calls within a single round execute in parallel
 * - Per-tool timeout via Promise.race with config.toolTimeoutMs
 * - Tool errors are returned to the model as structured results, not thrown
 * - SkillRuntimeContext.db is deferred (undefined for now)
 * - Mutating tools require approval before execution
 */

import { createLogger } from "@shetty4l/core/log";
import type { Result } from "@shetty4l/core/result";
import { err, ok } from "@shetty4l/core/result";
import type { StateLoader } from "@shetty4l/core/state";
import {
  consumeApproval,
  getApprovalForTool,
  isExpired,
  proposeApproval,
} from "./approval";
import { getDebugLogger } from "./debug-logger";
import type { SkillRegistry, SkillRuntimeContext } from "./skills";
import type { ChatMessage, OpenAITool, ToolCall } from "./synapse";
import { chat } from "./synapse";
import { getTraceId } from "./trace";

const log = createLogger("cortex");

// --- Types ---

export interface AgentConfig {
  models: string[];
  synapseUrl: string;
  toolTimeoutMs: number;
  maxToolRounds: number;
  skillConfig: Record<string, unknown>;
  synapseTimeoutMs?: number;
}

export interface AgentResult {
  /** Final text response from model. */
  response: string;
  /** All NEW assistant+tool messages from the loop (for history). */
  turns: ChatMessage[];
  /** If set, the agent is blocked waiting for approval. */
  needsApproval?: boolean;
  /** The approval ID if needsApproval is true. */
  approvalId?: string;
  /** The tool calls blocked pending approval. */
  blockedToolCalls?: ToolCall[];
}

// --- Loop ---

/**
 * Run the agent tool-calling loop.
 *
 * Sends messages to the LLM with tools available. If the model requests
 * tool calls, executes them in parallel, appends results to the conversation,
 * and loops. Continues until the model produces a text response without
 * tool calls or the max rounds are exhausted.
 *
 * If any requested tool is mutating, the loop blocks and returns a
 * needsApproval result. The caller must handle the approval flow and
 * resume execution by calling runAgentLoop again with the approved state.
 *
 * Returns all new messages generated during the loop (assistant + tool)
 * for the caller to persist to history.
 */
export async function runAgentLoop(opts: {
  messages: ChatMessage[];
  tools: OpenAITool[];
  registry: SkillRegistry;
  config: AgentConfig;
  /** StateLoader for approval persistence (optional for backward compatibility) */
  stateLoader?: StateLoader;
  /** Topic key for approval scoping (required if stateLoader is provided) */
  topicKey?: string;
  /**
   * Tool calls to execute immediately without calling the LLM first.
   * Used when resuming from an approved approval to execute the blocked tools.
   */
  resumeToolCalls?: ToolCall[];
}): Promise<Result<AgentResult>> {
  const { tools, registry, config, stateLoader, topicKey, resumeToolCalls } =
    opts;
  const messages = [...opts.messages]; // Don't mutate caller's array
  const newTurns: ChatMessage[] = [];
  let rounds = 0;

  // If resuming with tool calls, execute them first before entering the loop
  if (resumeToolCalls && resumeToolCalls.length > 0) {
    // Execute the resumed tool calls directly (approval already granted)
    const toolResults = await executeToolCalls(
      resumeToolCalls,
      registry,
      config,
    );

    // Append tool results
    for (const toolMsg of toolResults) {
      messages.push(toolMsg);
      newTurns.push(toolMsg);
    }

    rounds++;
  }

  while (true) {
    // Call LLM
    const result = await chat(messages, config.models, config.synapseUrl, {
      tools,
      timeoutMs: config.synapseTimeoutMs,
    });
    if (!result.ok) {
      return err(result.error);
    }

    const response = result.value;

    // No tool calls — final response
    if (!response.toolCalls || response.toolCalls.length === 0) {
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: response.content,
      };
      newTurns.push(assistantMsg);
      return ok({ response: response.content, turns: newTurns });
    }

    // Assistant message with tool_calls (content may be empty)
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: response.content,
      tool_calls: response.toolCalls,
    };
    messages.push(assistantMsg);
    newTurns.push(assistantMsg);

    // Check if any tool is mutating — if so, we need approval
    const hasMutating = response.toolCalls.some((tc) =>
      registry.isMutating(tc.function.name),
    );

    if (hasMutating && stateLoader && topicKey) {
      // Check for existing approved approval for these tools
      const approvalResult = await checkAndConsumeApproval(
        response.toolCalls,
        registry,
        stateLoader,
        topicKey,
        messages,
        newTurns,
        config,
      );

      if (approvalResult.needsApproval) {
        // Create new approval and return blocked state
        return ok(approvalResult);
      }

      // Approval was consumed, execute the tools normally
      // (toolResults are already in approvalResult.toolResults if consumed)
    }

    // Execute all tool calls in parallel
    const toolResults = await executeToolCalls(
      response.toolCalls,
      registry,
      config,
    );

    // Append tool results
    for (const toolMsg of toolResults) {
      messages.push(toolMsg);
      newTurns.push(toolMsg);
    }

    rounds++;

    // Max rounds reached — return with whatever content we have
    if (rounds >= config.maxToolRounds) {
      log(`max tool rounds exhausted (${config.maxToolRounds})`);
      const fallback =
        response.content ||
        "I was unable to complete the task within the allowed number of tool calls.";
      return ok({ response: fallback, turns: newTurns });
    }
  }
}

// --- Approval check ---

/**
 * Check if we have an approved (and not expired) approval for the mutating tools.
 * If approved, consume it and return needsApproval: false.
 * If not approved or no approval exists, create a new pending approval and return
 * needsApproval: true with the approval details.
 */
async function checkAndConsumeApproval(
  toolCalls: ToolCall[],
  registry: SkillRegistry,
  stateLoader: StateLoader,
  topicKey: string,
  messages: ChatMessage[],
  newTurns: ChatMessage[],
  _config: AgentConfig,
): Promise<AgentResult> {
  // Find the first mutating tool for approval lookup
  const mutatingToolCall = toolCalls.find((tc) =>
    registry.isMutating(tc.function.name),
  );

  if (!mutatingToolCall) {
    // No mutating tool (shouldn't happen if we get here, but be safe)
    return { response: "", turns: newTurns, needsApproval: false };
  }

  const toolName = mutatingToolCall.function.name;

  // Check for existing approved approval
  const existingApproval = getApprovalForTool(stateLoader, topicKey, toolName);

  if (existingApproval && !isExpired(existingApproval)) {
    // Consume the approval and allow execution
    await consumeApproval(stateLoader, existingApproval.id);
    return { response: "", turns: newTurns, needsApproval: false };
  }

  // No valid approval — create a new pending approval
  // Serialize the current state for resumption
  const agentStateJson = JSON.stringify(messages);
  const toolCallsJson = JSON.stringify(toolCalls);

  // Build tool description for the approval action
  const toolDescriptions = toolCalls
    .filter((tc) => registry.isMutating(tc.function.name))
    .map((tc) => {
      try {
        const args = JSON.parse(tc.function.arguments);
        return `${tc.function.name}(${JSON.stringify(args)})`;
      } catch {
        return `${tc.function.name}(${tc.function.arguments})`;
      }
    })
    .join(", ");

  const approval = proposeApproval(stateLoader, {
    topicKey,
    action: `execute: ${toolDescriptions}`,
    toolName,
    toolArgsJson: mutatingToolCall.function.arguments,
    agentStateJson,
    toolCallsJson,
  });

  log(`[${topicKey}] approval required for ${toolName}: ${approval.id}`);

  return {
    response: "",
    turns: newTurns,
    needsApproval: true,
    approvalId: approval.id,
    blockedToolCalls: toolCalls,
  };
}

// --- Helpers ---

/**
 * Race a promise against a timeout. Clears the timer in all cases.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  errorMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(errorMessage)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// --- Tool execution ---

/**
 * Execute all tool calls in parallel with per-tool timeout.
 */
async function executeToolCalls(
  toolCalls: ToolCall[],
  registry: SkillRegistry,
  config: AgentConfig,
): Promise<ChatMessage[]> {
  const promises = toolCalls.map((tc) =>
    executeOneToolCall(tc, registry, config),
  );
  return Promise.all(promises);
}

/**
 * Execute a single tool call with timeout handling.
 */
async function executeOneToolCall(
  toolCall: ToolCall,
  registry: SkillRegistry,
  config: AgentConfig,
): Promise<ChatMessage> {
  const qualifiedName = toolCall.function.name;

  // Validate arguments is valid JSON
  try {
    JSON.parse(toolCall.function.arguments);
  } catch {
    return {
      role: "tool",
      content: `Error: Invalid JSON in tool arguments: ${toolCall.function.arguments}`,
      tool_call_id: toolCall.id,
      name: qualifiedName,
    };
  }

  // Build runtime context
  const ctx: SkillRuntimeContext = {
    nowIso: new Date().toISOString(),
    config:
      (config.skillConfig as Record<string, Record<string, unknown>>)[
        qualifiedName.split(".")[0]
      ] ?? {},
    db: {
      query: () => {
        throw new Error(
          "db is not available in the current skill runtime context",
        );
      },
      run: () => {
        throw new Error(
          "db is not available in the current skill runtime context",
        );
      },
    },
    http: { fetch: globalThis.fetch },
  };

  const startMs = performance.now();
  try {
    // Execute with timeout
    const result = await withTimeout(
      registry.executeTool(qualifiedName, toolCall.function.arguments, ctx),
      config.toolTimeoutMs,
      `Tool execution timed out after ${config.toolTimeoutMs / 1000}s`,
    );
    const duration = ((performance.now() - startMs) / 1000).toFixed(1);
    const latencyMs = Math.round(performance.now() - startMs);

    // Emit tool debug event
    const debug = getDebugLogger();
    const traceId = getTraceId();
    if (debug.isEnabled() && traceId) {
      debug.log({
        type: "tool",
        traceId,
        timestamp: new Date().toISOString(),
        name: qualifiedName,
        args: toolCall.function.arguments,
        output: result.ok ? result.value.content : `Error: ${result.error}`,
        latencyMs,
        ok: result.ok,
      });
    }

    if (!result.ok) {
      log(`tool ${qualifiedName} failed in ${duration}s: ${result.error}`);
      return {
        role: "tool",
        content: `Error: ${result.error}`,
        tool_call_id: toolCall.id,
        name: qualifiedName,
      };
    }

    log(`tool ${qualifiedName} ok in ${duration}s`);
    return {
      role: "tool",
      content: result.value.content,
      tool_call_id: toolCall.id,
      name: qualifiedName,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const latencyMs = Math.round(performance.now() - startMs);

    // Emit tool debug event for exception
    const debug = getDebugLogger();
    const traceId = getTraceId();
    if (debug.isEnabled() && traceId) {
      debug.log({
        type: "tool",
        traceId,
        timestamp: new Date().toISOString(),
        name: qualifiedName,
        args: toolCall.function.arguments,
        output: `Error: ${message}`,
        latencyMs,
        ok: false,
      });
    }

    log(`tool ${qualifiedName} failed: ${message}`);
    return {
      role: "tool",
      content: `Error: ${message}`,
      tool_call_id: toolCall.id,
      name: qualifiedName,
    };
  }
}
