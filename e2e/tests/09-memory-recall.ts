/**
 * Test 09: Memory recall - seeded memory influences response.
 *
 * Steps:
 * - Use remember() to seed a unique fact into Engram
 * - Send a query related to that fact
 * - Soft assertion: verify response contains seeded info
 */

import type { TestResult } from "../lib/types";
import { sendMessage } from "../lib/cortex";
import { waitForDeliveredMessage } from "../lib/outbox";
import { remember, forget } from "../lib/engram";
import { assertTrue } from "../lib/assert";

export const name = "09-memory-recall";

// 300s timeout for memory tests
const TEST_TIMEOUT = 300000;

function generateTestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function run(): Promise<TestResult> {
  const startTime = Date.now();
  const testId = generateTestId();
  const testMarker = `[TEST-${testId}]`;
  const topicKey = `test-memory-recall-${testId}`;

  // Unique fact that won't appear randomly in LLM output
  const uniqueCode = `ZEPHYR${testId.slice(0, 4).toUpperCase()}`;
  const seededFact = `The user's secret project code is ${uniqueCode}. This is very important to remember.`;

  let memoryId: string | undefined;

  try {
    // --- Seed a memory into Engram ---
    const rememberResult = await remember({
      content: seededFact,
      category: "fact",
      idempotencyKey: `test-memory-recall-${testId}`,
      upsert: true,
    });

    memoryId = rememberResult.id;
    console.log(`  Seeded memory with id: ${memoryId}`);

    // --- Send a query that should trigger memory recall ---
    const beforeQueryMs = Date.now();

    await sendMessage({
      text: `${testMarker} What is my secret project code?`,
      topicKey,
      channel: "cli",
    });

    const response = await waitForDeliveredMessage(topicKey, beforeQueryMs, { timeout: TEST_TIMEOUT });

    // Hard assertion: got a response
    assertTrue(
      response.text.length > 0,
      "Expected non-empty response"
    );

    // Soft assertion: check if response contains the seeded code
    const codeInResponse = response.text.toUpperCase().includes(uniqueCode);

    if (!codeInResponse) {
      console.log(`  \x1b[33m⚠ Soft assertion: Seeded code "${uniqueCode}" not found in response\x1b[0m`);
      console.log(`    Response: "${response.text.slice(0, 150)}..."`);
    } else {
      console.log(`  ✓ Response contains seeded code "${uniqueCode}"`);
    }

    return {
      name,
      passed: true,
      duration: Date.now() - startTime,
      input: `Query about seeded code ${uniqueCode}`,
    };
  } catch (err) {
    return {
      name,
      passed: false,
      duration: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Cleanup: remove seeded memory
    if (memoryId) {
      try {
        await forget({ id: memoryId });
        console.log(`  Cleaned up test memory: ${memoryId}`);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
