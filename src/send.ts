/**
 * Send a message through Cortex and wait for the response.
 *
 * Acts as a mini-connector: POST /receive → poll /outbox/poll → ack /outbox/ack.
 * Used by `cortex send` CLI command and tests.
 */

import type { Result } from "@shetty4l/core/result";
import { err, ok } from "@shetty4l/core/result";

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30_000;
const SEND_CHANNEL = "cli";

export interface SendOptions {
  baseUrl: string;
  apiKey: string;
  /** Fixed topic key. If omitted, a random cli:{uuid} key is generated per call. */
  topicKey?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

/**
 * Send a message to Cortex and wait for the assistant's response.
 *
 * 1. POST /receive with channel="cli"
 * 2. Poll /outbox/poll for channel="cli" until response appears
 * 3. Ack via /outbox/ack
 * 4. Return response text
 *
 * Returns Err on timeout, connection failure, or unexpected errors.
 */
export async function sendMessage(
  text: string,
  options: SendOptions,
): Promise<Result<string>> {
  const { baseUrl, apiKey } = options;
  const pollInterval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const pollTimeout = options.pollTimeoutMs ?? POLL_TIMEOUT_MS;

  const topicKey = options.topicKey ?? `cli:${crypto.randomUUID()}`;
  const externalId = `cli-${crypto.randomUUID()}`;

  // 1. Receive (via thalamus gate)
  let receiveResponse: Response;
  try {
    receiveResponse = await fetch(`${baseUrl}/receive`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        channel: SEND_CHANNEL,
        externalId,
        data: {
          text,
          topicKey,
          userId: "cli:local",
        },
        occurredAt: new Date().toISOString(),
      }),
    });
  } catch (e) {
    return err(
      `Receive connection failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!receiveResponse.ok) {
    const body = await receiveResponse.text();
    return err(`Receive failed (${receiveResponse.status}): ${body}`);
  }

  // 2. Poll outbox
  const start = Date.now();

  while (Date.now() - start < pollTimeout) {
    await Bun.sleep(pollInterval);

    let pollResponse: Response;
    try {
      pollResponse = await fetch(`${baseUrl}/outbox/poll`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          channel: SEND_CHANNEL,
          topicKey,
          max: 1,
          leaseSeconds: 30,
        }),
      });
    } catch (e) {
      return err(
        `Poll connection failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (!pollResponse.ok) {
      const body = await pollResponse.text();
      return err(`Poll failed (${pollResponse.status}): ${body}`);
    }

    const pollBody = (await pollResponse.json()) as {
      messages: Array<{
        messageId: string;
        leaseToken: string;
        topicKey: string;
        text: string;
      }>;
    };

    if (pollBody.messages.length === 0) continue;

    const match = pollBody.messages[0];

    // 3. Ack
    let ackResponse: Response;
    try {
      ackResponse = await fetch(`${baseUrl}/outbox/ack`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          messageId: match.messageId,
          leaseToken: match.leaseToken,
        }),
      });
    } catch (e) {
      return err(
        `Ack connection failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (!ackResponse.ok) {
      const body = await ackResponse.text();
      return err(`Ack failed (${ackResponse.status}): ${body}`);
    }

    return ok(match.text);
  }

  return err(`Timed out after ${pollTimeout}ms waiting for response`);
}
