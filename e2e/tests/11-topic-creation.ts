/**
 * Test 11: Topic creation - verify new topic is created.
 *
 * Sends a message with a new topicKey and verifies:
 * - Topic record is created in topics table
 * - Topic has non-empty name field
 */

import type { TestResult } from "../lib/types";
import { sendMessage } from "../lib/cortex";
import { waitForDeliveredMessage } from "../lib/outbox";
import { openCortexDb, queryOne } from "../lib/db";
import { assertTrue } from "../lib/assert";

export const name = "11-topic-creation";

interface Topic {
  id: string;
  key: string;
  name: string | null;
}

function generateTestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function run(): Promise<TestResult> {
  const startTime = Date.now();
  const testId = generateTestId();
  const testMarker = `[TEST-${testId}]`;
  const topicKey = `test-topic-creation-${testId}`;

  try {
    const beforeTimestampMs = Date.now();

    // Send a message with a new topicKey
    await sendMessage({
      text: `${testMarker} Hello, this is a test message to create a new topic.`,
      topicKey,
      channel: "cli",
    });

    // Wait for response to ensure processing completed
    await waitForDeliveredMessage(topicKey, beforeTimestampMs);

    // Query topics table to verify record exists
    const db = await openCortexDb();
    const topic = queryOne<Topic>(
      db,
      `SELECT id, key, name FROM topics WHERE key = $topicKey`,
      { $topicKey: topicKey }
    );

    // Assert topic exists
    assertTrue(topic !== null, `Expected topic "${topicKey}" to exist in database`);

    // Assert topic has non-empty name
    assertTrue(
      topic!.name !== null && topic!.name.length > 0,
      `Expected topic to have non-empty name, got: ${topic!.name}`
    );

    return {
      name,
      passed: true,
      duration: Date.now() - startTime,
      input: `${testMarker} Hello, this is a test message to create a new topic.`,
    };
  } catch (err) {
    return {
      name,
      passed: false,
      duration: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
