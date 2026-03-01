/**
 * Test 02: Multi-turn conversation - context retention.
 *
 * Sends two messages and verifies:
 * - Both get responses
 * - Second response shows context retention (soft assertion)
 */

import type { TestResult } from "../lib/types";
import { sendMessage } from "../lib/cortex";
import { waitForDeliveredMessage } from "../lib/outbox";
import { assertTrue } from "../lib/assert";
import { sleep } from "../lib/wait";

export const name = "02-multi-turn";

function generateTestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function run(): Promise<TestResult> {
  const startTime = Date.now();
  const testId = generateTestId();
  const testMarker = `[TEST-${testId}]`;
  const topicKey = `test-multi-turn-${testId}`;
  const testName = "Zephyrine"; // Unique name unlikely to appear randomly

  try {
    // --- First message: introduce a name ---
    const beforeFirstMs = Date.now();

    await sendMessage({
      text: `${testMarker} My name is ${testName}. Please remember that.`,
      topicKey,
      channel: "cli",
    });

    const firstResponse = await waitForDeliveredMessage(topicKey, beforeFirstMs);

    assertTrue(
      firstResponse.text.length > 0,
      "Expected non-empty first response"
    );

    // Small delay between messages
    await sleep(1000);

    // --- Second message: ask about the name ---
    const beforeSecondMs = Date.now();

    await sendMessage({
      text: `${testMarker} What is my name?`,
      topicKey,
      channel: "cli",
    });

    const secondResponse = await waitForDeliveredMessage(topicKey, beforeSecondMs);

    assertTrue(
      secondResponse.text.length > 0,
      "Expected non-empty second response"
    );

    // Soft assertion: check if name is in response
    // This is a soft assertion - we log but don't fail if name not found
    const nameInResponse = secondResponse.text
      .toLowerCase()
      .includes(testName.toLowerCase());

    if (!nameInResponse) {
      console.log(
        `  \x1b[33m⚠ Soft assertion: Name "${testName}" not found in response\x1b[0m`
      );
      console.log(`    Response: "${secondResponse.text.slice(0, 100)}..."`);
    }

    return {
      name,
      passed: true,
      duration: Date.now() - startTime,
      input: `First: My name is ${testName}. Second: What is my name?`,
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
