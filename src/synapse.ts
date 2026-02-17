/**
 * Thin Synapse client for Cortex.
 *
 * Calls the Synapse model proxy (OpenAI-compatible) at POST /v1/chat/completions.
 * Non-streaming only — Cortex is a backend agent loop, not a token-by-token UI.
 *
 * Synapse handles provider selection, health tracking, and failover.
 * Cortex just sends `{ model, messages }` and gets back a chat completion.
 */

import type { Result } from "@shetty4l/core/result";
import { err, ok } from "@shetty4l/core/result";

// --- Types ---

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
}

export interface ChatResponse {
  content: string;
  finishReason: string;
}

// --- Client ---

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Send a chat completion request to Synapse.
 *
 * Returns Ok with the assistant's text response, or Err on
 * non-2xx responses, timeouts, or malformed responses.
 */
export async function chat(
  messages: ChatMessage[],
  model: string,
  synapseUrl: string,
): Promise<Result<ChatResponse>> {
  const url = `${synapseUrl}/v1/chat/completions`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      return err(`Synapse request timed out after ${REQUEST_TIMEOUT_MS}ms`);
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
    return err(`Synapse returned ${response.status}: ${body.slice(0, 500)}`);
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
      message?: { content?: string | null; role?: string };
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

  if (content === undefined || content === null) {
    return err("Synapse response has no content in choices[0].message");
  }

  return ok({
    content,
    finishReason: choice.finish_reason ?? "stop",
  });
}
