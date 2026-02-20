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
 */

import { createLogger } from "@shetty4l/core/log";
import type { Result } from "@shetty4l/core/result";
import { err, ok } from "@shetty4l/core/result";
import type { SkillRegistry, SkillRuntimeContext } from "./skills";
import type { ChatMessage, OpenAITool, ToolCall } from "./synapse";
import { chat } from "./synapse";

const log = createLogger("cortex");

// --- Types ---

export interface AgentConfig {
  model: string;
  synapseUrl: string;
  toolTimeoutMs: number;
  maxToolRounds: number;
  skillConfig: Record<string, unknown>;
}

export interface AgentResult {
  /** Final text response from model. */
  response: string;
  /** All NEW assistant+tool messages from the loop (for history). */
  turns: ChatMessage[];
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
 * Returns all new messages generated during the loop (assistant + tool)
 * for the caller to persist to history.
 */
export async function runAgentLoop(opts: {
  messages: ChatMessage[];
  tools: OpenAITool[];
  registry: SkillRegistry;
  config: AgentConfig;
}): Promise<Result<AgentResult>> {
  const { tools, registry, config } = opts;
  const messages = [...opts.messages]; // Don't mutate caller's array
  const newTurns: ChatMessage[] = [];
  let rounds = 0;

  while (true) {
    // Call LLM
    const result = await chat(messages, config.model, config.synapseUrl, tools);
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

  try {
    // Execute with timeout
    const startMs = performance.now();
    const result = await withTimeout(
      registry.executeTool(qualifiedName, toolCall.function.arguments, ctx),
      config.toolTimeoutMs,
      `Tool execution timed out after ${config.toolTimeoutMs / 1000}s`,
    );
    const duration = ((performance.now() - startMs) / 1000).toFixed(1);

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
    log(`tool ${qualifiedName} failed: ${message}`);
    return {
      role: "tool",
      content: `Error: ${message}`,
      tool_call_id: toolCall.id,
      name: qualifiedName,
    };
  }
}
