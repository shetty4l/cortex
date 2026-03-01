/**
 * Tick message helpers for E2E tests.
 *
 * Provides functions to poll for tick-channel messages in the inbox,
 * used for testing scheduled/overdue task notifications.
 *
 * Note: Tick generates inbox messages (not outbox), because tick warnings
 * are processed through the normal inbox → cortex → outbox flow.
 */

import { openCortexDb, queryOne } from "./db";
import { getConfig } from "./config";
import { waitFor } from "./wait";

export interface TickMessage {
  id: string;
  topic_key: string;
  channel: string;
  text: string;
  status: string;
  occurred_at: number;
  created_at: string;
}

export interface WaitForTickOptions {
  /** Task ID to filter for (optional) */
  taskId?: string;
  /** Warning type to filter for: 'overdue' or 'due_soon' (optional) */
  warningType?: "overdue" | "due_soon";
  /** Timeout in ms (defaults to config.timeouts.llmResponse) */
  timeout?: number;
  /** Polling interval in ms (default: 1000) */
  interval?: number;
  /** Show spinner while waiting */
  showSpinner?: boolean;
}

/**
 * Wait for a tick-channel message to appear in the inbox.
 *
 * Tick creates inbox_messages with channel='tick'. These get processed
 * through cortex and produce outbox responses.
 *
 * @param topicKey - The topic key to poll for
 * @param afterTimestampMs - Only consider messages created after this timestamp (ms since epoch)
 * @param opts - Wait options including optional filters
 * @returns The tick message when found
 */
export async function waitForTickMessage(
  topicKey: string,
  afterTimestampMs: number,
  opts: WaitForTickOptions = {}
): Promise<TickMessage> {
  const config = await getConfig();
  const {
    taskId,
    warningType,
    timeout = config.timeouts.llmResponse,
    interval = 1000,
    showSpinner = true,
  } = opts;

  const db = await openCortexDb();

  const message = await waitFor<TickMessage>(
    () => {
      // Poll for tick-channel inbox message
      // Use occurred_at (numeric) for reliable timestamp comparison
      const result = queryOne<TickMessage>(
        db,
        `SELECT id, topic_key, channel, text, status, occurred_at, created_at
         FROM inbox_messages
         WHERE topic_key = $topicKey
           AND channel = 'tick'
           AND occurred_at > $afterTimestampMs
         ORDER BY occurred_at DESC
         LIMIT 1`,
        { $topicKey: topicKey, $afterTimestampMs: afterTimestampMs }
      );

      if (!result) return null;

      // Apply optional filters
      if (taskId && !result.text.includes(taskId)) {
        return null;
      }
      if (warningType && !result.text.toLowerCase().includes(warningType.replace("_", " "))) {
        return null;
      }

      return result;
    },
    {
      timeout,
      interval,
      message: `No tick message found for topic ${topicKey}`,
      showSpinner,
    }
  );

  return message;
}

/**
 * Wait for any tick message in inbox after given timestamp.
 */
export async function waitForAnyTickMessage(
  afterTimestampMs: number,
  opts: WaitForTickOptions = {}
): Promise<TickMessage> {
  const config = await getConfig();
  const {
    taskId,
    warningType,
    timeout = config.timeouts.llmResponse,
    interval = 1000,
    showSpinner = true,
  } = opts;

  const db = await openCortexDb();

  const message = await waitFor<TickMessage>(
    () => {
      const result = queryOne<TickMessage>(
        db,
        `SELECT id, topic_key, channel, text, status, occurred_at, created_at
         FROM inbox_messages
         WHERE channel = 'tick'
           AND occurred_at > $afterTimestampMs
         ORDER BY occurred_at DESC
         LIMIT 1`,
        { $afterTimestampMs: afterTimestampMs }
      );

      if (!result) return null;

      if (taskId && !result.text.includes(taskId)) {
        return null;
      }
      if (warningType && !result.text.toLowerCase().includes(warningType.replace("_", " "))) {
        return null;
      }

      return result;
    },
    {
      timeout,
      interval,
      message: `No tick message found`,
      showSpinner,
    }
  );

  return message;
}
