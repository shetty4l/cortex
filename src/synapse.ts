/**
 * Thin Synapse client for Cortex.
 *
 * Calls the Synapse model proxy (OpenAI-compatible) at POST /v1/chat/completions.
 * Non-streaming only — Cortex is a backend agent loop, not a token-by-token UI.
 *
 * Synapse handles provider selection, health tracking, and failover.
 * Cortex sends `{ model, messages }` and gets back a chat completion.
 *
 * Model fallback: when multiple models are provided, chat() iterates through
 * them on 429 (rate limit). Non-429 errors return immediately.
 */

import { createLogger } from "@shetty4l/core/log";
import type { Result } from "@shetty4l/core/result";
import { err, ok } from "@shetty4l/core/result";

const log = createLogger("cortex");

// --- Types ---

export interface ToolCallFunction {
  name: string;
  arguments: string; // JSON string
}

export interface ToolCall {
  id: string;
  type: "function";
  function: ToolCallFunction;
}

export interface OpenAIToolFunction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface OpenAITool {
  type: "function";
  function: OpenAIToolFunction;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  name?: string;
}

export interface ChatResponse {
  content: string;
  finishReason: string;
  toolCalls?: ToolCall[];
}

// --- Client ---

const REQUEST_TIMEOUT_MS = 30_000;

export interface ChatOptions {
  tools?: OpenAITool[];
  timeoutMs?: number;
  temperature?: number;
}

/**
 * Send a chat completion request to Synapse.
 *
 * Accepts an array of models. On 429 (rate limit), logs and tries the next
 * model. On any other error, returns immediately. If all models are exhausted
 * on 429, returns the last error.
 *
 * Returns Ok with the assistant's text response, or Err on
 * non-2xx responses, timeouts, or malformed responses.
 */
export async function chat(
  messages: ChatMessage[],
  models: string[],
  synapseUrl: string,
  opts?: ChatOptions,
): Promise<Result<ChatResponse>> {
  const url = `${synapseUrl}/v1/chat/completions`;
  const effectiveTimeout = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let lastError = "";

  for (const model of models) {
    const startMs = performance.now();

    const requestBody: Record<string, unknown> = {
      model,
      messages,
      stream: false,
    };
    if (opts?.tools && opts.tools.length > 0) {
      requestBody.tools = opts.tools;
    }
    if (opts?.temperature !== undefined) {
      requestBody.temperature = opts.temperature;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(effectiveTimeout),
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "TimeoutError") {
        return err(`Synapse request timed out after ${effectiveTimeout}ms`);
      }
      if (e instanceof DOMException && e.name === "AbortError") {
        return err("Synapse request was aborted");
      }
      return err(
        `Synapse connection failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    let body: string;
    try {
      body = await response.text();
    } catch (e) {
      return err(
        `Synapse response body read failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (!response.ok) {
      const latency = ((performance.now() - startMs) / 1000).toFixed(1);
      lastError = `Synapse returned ${response.status}: ${body.slice(0, 500)}`;

      // On 429 (rate limit), try the next model in the fallback chain
      if (response.status === 429) {
        log(`synapse ${model} 429 ${latency}s — trying next model`);
        continue;
      }

      log(`synapse ${model} ${response.status} ${latency}s`);
      return err(lastError);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return err("Synapse returned invalid JSON");
    }

    // Parse OpenAI chat completion response
    const completion = parsed as {
      choices?: Array<{
        message?: {
          content?: string | null;
          role?: string;
          tool_calls?: ToolCall[];
        };
        finish_reason?: string;
      }>;
    };

    if (
      !completion.choices ||
      !Array.isArray(completion.choices) ||
      completion.choices.length === 0
    ) {
      return err("Synapse response missing choices array");
    }

    const choice = completion.choices[0];
    const content = choice.message?.content;
    const toolCalls = choice.message?.tool_calls;

    // When tool_calls are present, content may be null/empty — normalize to ""
    if (
      (content === undefined || content === null) &&
      (!toolCalls || toolCalls.length === 0)
    ) {
      return err("Synapse response has no content in choices[0].message");
    }

    const result: ChatResponse = {
      content: content ?? "",
      finishReason: choice.finish_reason ?? "stop",
    };

    if (toolCalls && toolCalls.length > 0) {
      result.toolCalls = toolCalls;
    }

    const latency = ((performance.now() - startMs) / 1000).toFixed(1);
    log(`synapse ${model} ${response.status} ${latency}s`);

    return ok(result);
  }

  // All models exhausted on 429
  return err(lastError || "No models provided");
}
