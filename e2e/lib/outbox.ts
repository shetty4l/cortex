/**
 * Outbox polling helpers for E2E tests.
 *
 * Polls the Cortex outbox_messages table for messages that have been processed
 * and are ready for delivery. The test boundary ends at status='ready',
 * not 'delivered' - Wilson effector delivery is outside test scope.
 */

import { openCortexDb, query, queryOne } from "./db";
import { getConfig } from "./config";
import { waitFor } from "./wait";

export interface OutboxMessage {
  id: string;
  topic_key: string;
  channel: string;
  text: string;
  message_type: string;
  status: string;
  created_at: string;
  updated_at: string;
  created_at_ms: number;
}

export interface WaitForMessageOptions {
  /** Timeout in ms (defaults to config.timeouts.llmResponse) */
  timeout?: number;
  /** Polling interval in ms (default: 1000) */
  interval?: number;
  /** Show spinner while waiting */
  showSpinner?: boolean;
}

/**
 * Wait for a message to appear in the outbox with status='ready'.
 *
 * This polls the Cortex outbox_messages table for messages matching the given topic.
 * The test boundary ends at status='ready' - we don't wait for 'delivered'
 * because the Wilson effector (Telegram delivery) is outside test scope.
 *
 * @param topicKey - The topic key to poll for
 * @param afterTimestampMs - Only consider messages created after this timestamp (ms since epoch)
 * @param opts - Wait options
 * @returns The outbox message when found
 */
export async function waitForDeliveredMessage(
  topicKey: string,
  afterTimestampMs: number,
  opts: WaitForMessageOptions = {}
): Promise<OutboxMessage> {
  const config = await getConfig();
  const {
    timeout = config.timeouts.llmResponse,
    interval = 1000,
    showSpinner = true,
  } = opts;

  const db = await openCortexDb();

  const message = await waitFor<OutboxMessage>(
    () => {
      // Poll for outbox message with status='ready' (not 'delivered')
      // Use created_at_ms for reliable numeric comparison
      return queryOne<OutboxMessage>(
        db,
        `SELECT id, topic_key, channel, text, message_type, 
                status, created_at, updated_at, created_at_ms
         FROM outbox_messages
         WHERE topic_key = $topicKey
           AND status = 'ready'
           AND created_at_ms > $afterTimestampMs
         ORDER BY created_at_ms DESC
         LIMIT 1`,
        { $topicKey: topicKey, $afterTimestampMs: afterTimestampMs }
      );
    },
    {
      timeout,
      interval,
      message: `No outbox message found for topic ${topicKey} with status='ready'`,
      showSpinner,
    }
  );

  return message;
}

/**
 * Wait for any message in the outbox with status='ready' after given timestamp.
 * Useful when you don't know the exact topic key.
 */
export async function waitForAnyReadyMessage(
  afterTimestampMs: number,
  opts: WaitForMessageOptions = {}
): Promise<OutboxMessage> {
  const config = await getConfig();
  const {
    timeout = config.timeouts.llmResponse,
    interval = 1000,
    showSpinner = true,
  } = opts;

  const db = await openCortexDb();

  const message = await waitFor<OutboxMessage>(
    () => {
      return queryOne<OutboxMessage>(
        db,
        `SELECT id, topic_key, channel, text, message_type, 
                status, created_at, updated_at, created_at_ms
         FROM outbox_messages
         WHERE status = 'ready'
           AND created_at_ms > $afterTimestampMs
         ORDER BY created_at_ms DESC
         LIMIT 1`,
        { $afterTimestampMs: afterTimestampMs }
      );
    },
    {
      timeout,
      interval,
      message: `No outbox message found with status='ready' after timestamp`,
      showSpinner,
    }
  );

  return message;
}

/**
 * Get all ready messages for a topic (useful for multi-message tests).
 */
export async function getReadyMessages(
  topicKey: string,
  afterTimestampMs: number
): Promise<OutboxMessage[]> {
  const db = await openCortexDb();

  return query<OutboxMessage>(
    db,
    `SELECT id, topic_key, channel, text, message_type,
            status, created_at, updated_at, created_at_ms
     FROM outbox_messages
     WHERE topic_key = $topicKey
       AND status = 'ready'
       AND created_at_ms > $afterTimestampMs
     ORDER BY created_at_ms ASC`,
    { $topicKey: topicKey, $afterTimestampMs: afterTimestampMs }
  );
}
