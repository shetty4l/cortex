/**
 * Test 10: Topic summary - verify topic_summaries table populated.
 *
 * Steps:
 * - Send 3 messages in a topic to trigger summary generation
 * - Query topic_summaries table directly
 * - Assert summary is non-empty
 */

import type { TestResult } from "../lib/types";
import { sendMessage } from "../lib/cortex";
import { waitForDeliveredMessage } from "../lib/outbox";
import { openCortexDb, queryOne } from "../lib/db";
import { assertTrue } from "../lib/assert";
import { sleep, waitFor } from "../lib/wait";

export const name = "10-topic-summary";

// 300s timeout for summary generation
const TEST_TIMEOUT = 300000;

function generateTestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface TopicSummary {
  key: string;
  summary: string;
  updated_at: string;
}

export async function run(): Promise<TestResult> {
  const startTime = Date.now();
  const testId = generateTestId();
  const testMarker = `[TEST-${testId}]`;
  const topicKey = `test-topic-summary-${testId}`;

  try {
    // --- Message 1 ---
    const beforeFirstMs = Date.now();

    await sendMessage({
      text: `${testMarker} Hello! I'm starting a conversation about gardening.`,
      topicKey,
      channel: "cli",
    });

    await waitForDeliveredMessage(topicKey, beforeFirstMs, { timeout: TEST_TIMEOUT });
    await sleep(2000);

    // --- Message 2 ---
    const beforeSecondMs = Date.now();

    await sendMessage({
      text: `${testMarker} I want to plant tomatoes in my backyard garden.`,
      topicKey,
      channel: "cli",
    });

    await waitForDeliveredMessage(topicKey, beforeSecondMs, { timeout: TEST_TIMEOUT });
    await sleep(2000);

    // --- Message 3 ---
    const beforeThirdMs = Date.now();

    await sendMessage({
      text: `${testMarker} What's the best time of year to plant tomatoes?`,
      topicKey,
      channel: "cli",
    });

    await waitForDeliveredMessage(topicKey, beforeThirdMs, { timeout: TEST_TIMEOUT });

    // --- Wait for summary generation ---
    // Summary generation happens asynchronously after messages
    console.log("  Waiting for topic summary to be generated...");

    const db = await openCortexDb();

    // First get the topic ID
    const topic = await waitFor<{ id: string }>(
      () =>
        queryOne<{ id: string }>(
          db,
          `SELECT id FROM topics WHERE key = $topicKey`,
          { $topicKey: topicKey }
        ),
      {
        timeout: 30000,
        interval: 1000,
        message: `Topic ${topicKey} not found`,
        showSpinner: true,
      }
    );

    // Wait for summary to appear (with longer timeout for async processing)
    // topic_summaries uses topicKey as the primary key
    // Summary might be empty initially, so check for non-empty content
    const summary = await waitFor<TopicSummary>(
      () => {
        const result = queryOne<TopicSummary>(
          db,
          `SELECT key, summary, updated_at 
           FROM topic_summaries 
           WHERE key = $topicKey 
             AND length(summary) > 0`,
          { $topicKey: topicKey }
        );
        return result;
      },
      {
        timeout: 90000, // 90s for async summary generation
        interval: 2000,
        message: `Topic summary not found for topic ${topicKey}`,
        showSpinner: true,
      }
    );

    // Assert summary is non-empty
    assertTrue(
      summary.summary.length > 0,
      `Expected non-empty summary, got empty string`
    );

    console.log(`  ✓ Found topic summary (${summary.summary.length} chars)`);
    console.log(`    Preview: "${summary.summary.slice(0, 100)}..."`);

    return {
      name,
      passed: true,
      duration: Date.now() - startTime,
      input: `3 messages about gardening in topic ${topicKey}`,
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
