/**
 * Test 01: Single message - basic conversational flow.
 *
 * Sends a single message and verifies:
 * - Response is non-empty
 * - message_type = 'conversational'
 */

import type { TestResult } from "../lib/types";
import { sendMessage } from "../lib/cortex";
import { waitForDeliveredMessage } from "../lib/outbox";
import { assertTrue, assertEqual } from "../lib/assert";

export const name = "01-single-message";

function generateTestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function run(): Promise<TestResult> {
  const startTime = Date.now();
  const testId = generateTestId();
  const testMarker = `[TEST-${testId}]`;
  const topicKey = `test-single-message-${testId}`;

  try {
    const beforeTimestampMs = Date.now();

    // Send a simple message
    await sendMessage({
      text: `${testMarker} Hello, how are you today?`,
      topicKey,
      channel: "cli",
    });

    // Wait for response in outbox
    const message = await waitForDeliveredMessage(topicKey, beforeTimestampMs);

    // Assert non-empty response
    assertTrue(
      message.text.length > 0,
      "Expected non-empty response text"
    );

    // Assert message_type is conversational
    assertEqual(
      message.message_type,
      "conversational",
      `Expected message_type='conversational', got '${message.message_type}'`
    );

    return {
      name,
      passed: true,
      duration: Date.now() - startTime,
      input: `${testMarker} Hello, how are you today?`,
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
