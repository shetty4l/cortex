/**
 * Send a message through Cortex and wait for the response.
 *
 * Acts as a mini-connector: POST /ingest → poll /outbox/poll → ack /outbox/ack.
 * Used by `cortex send` CLI command and tests.
 */

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30_000;
const SEND_SOURCE = "cli";

export interface SendOptions {
  baseUrl: string;
  apiKey: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

/**
 * Send a message to Cortex and wait for the assistant's response.
 *
 * 1. POST /ingest with source="cli"
 * 2. Poll /outbox/poll for source="cli" until response appears
 * 3. Ack via /outbox/ack
 * 4. Return response text
 *
 * Throws on timeout, connection failure, or unexpected errors.
 */
export async function sendMessage(
  text: string,
  options: SendOptions,
): Promise<string> {
  const { baseUrl, apiKey } = options;
  const pollInterval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const pollTimeout = options.pollTimeoutMs ?? POLL_TIMEOUT_MS;

  const topicKey = `cli:${crypto.randomUUID()}`;
  const externalMessageId = `cli-${crypto.randomUUID()}`;

  // 1. Ingest
  const ingestResponse = await fetch(`${baseUrl}/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      source: SEND_SOURCE,
      externalMessageId,
      idempotencyKey: `cli:${externalMessageId}`,
      topicKey,
      userId: "cli:local",
      text,
      occurredAt: new Date().toISOString(),
    }),
  });

  if (!ingestResponse.ok) {
    const body = await ingestResponse.text();
    throw new Error(`Ingest failed (${ingestResponse.status}): ${body}`);
  }

  // 2. Poll outbox
  const start = Date.now();

  while (Date.now() - start < pollTimeout) {
    await Bun.sleep(pollInterval);

    const pollResponse = await fetch(`${baseUrl}/outbox/poll`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        source: SEND_SOURCE,
        topicKey,
        max: 1,
        leaseSeconds: 30,
      }),
    });

    if (!pollResponse.ok) {
      const body = await pollResponse.text();
      throw new Error(`Poll failed (${pollResponse.status}): ${body}`);
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
    const ackResponse = await fetch(`${baseUrl}/outbox/ack`, {
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

    if (!ackResponse.ok) {
      const body = await ackResponse.text();
      throw new Error(`Ack failed (${ackResponse.status}): ${body}`);
    }

    return match.text;
  }

  throw new Error(`Timed out after ${pollTimeout}ms waiting for response`);
}
