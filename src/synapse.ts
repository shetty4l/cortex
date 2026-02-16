/**
 * Thin Synapse client for Cortex.
 *
 * Calls the Synapse model proxy (OpenAI-compatible) at POST /v1/chat/completions.
 * Non-streaming only — Cortex is a backend agent loop, not a token-by-token UI.
 *
 * Synapse handles provider selection, health tracking, and failover.
 * Cortex just sends `{ model, messages }` and gets back a chat completion.
 */

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

export class SynapseError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "SynapseError";
  }
}

// --- Client ---

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Send a chat completion request to Synapse.
 *
 * Returns the assistant's text response. Throws SynapseError on
 * non-2xx responses, timeouts, or malformed responses.
 */
export async function chat(
  messages: ChatMessage[],
  model: string,
  synapseUrl: string,
): Promise<ChatResponse> {
  const url = `${synapseUrl}/v1/chat/completions`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new SynapseError(
        `Synapse request timed out after ${REQUEST_TIMEOUT_MS}ms`,
        0,
      );
    }
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new SynapseError("Synapse request was aborted", 0);
    }
    throw new SynapseError(
      `Synapse connection failed: ${err instanceof Error ? err.message : String(err)}`,
      0,
    );
  }

  let body: string;
  try {
    body = await response.text();
  } catch (err) {
    throw new SynapseError(
      `Synapse response body read failed: ${err instanceof Error ? err.message : String(err)}`,
      response.status,
    );
  }

  if (!response.ok) {
    throw new SynapseError(
      `Synapse returned ${response.status}: ${body.slice(0, 500)}`,
      response.status,
      body,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new SynapseError(
      "Synapse returned invalid JSON",
      response.status,
      body,
    );
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
    throw new SynapseError(
      "Synapse response missing choices array",
      response.status,
      body,
    );
  }

  const choice = completion.choices[0];
  const content = choice.message?.content;

  if (content === undefined || content === null) {
    throw new SynapseError(
      "Synapse response has no content in choices[0].message",
      response.status,
      body,
    );
  }

  return {
    content,
    finishReason: choice.finish_reason ?? "stop",
  };
}
