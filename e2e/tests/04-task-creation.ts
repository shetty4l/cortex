/**
 * Test 04: Task creation via natural language.
 *
 * Sends a task request message and verifies:
 * - Task is created in the database
 * - Task has due_at set
 * - Handles approval flow if needed
 */

import type { TestResult } from "../lib/types";
import { sendMessage, getPendingApproval, respondToApproval } from "../lib/cortex";
import { waitForDeliveredMessage } from "../lib/outbox";
import { findTaskByTitle } from "../lib/tasks";
import { assertTrue } from "../lib/assert";
import { waitFor, sleep } from "../lib/wait";

export const name = "04-task-creation";

function generateTestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function run(): Promise<TestResult> {
  const startTime = Date.now();
  const testId = generateTestId();
  const testMarker = `[TEST-${testId}]`;
  const topicKey = `test-task-creation-${testId}`;
  const taskTitle = `TestTask-${testId}`;

  try {
    const beforeTimestampMs = Date.now();

    // Send a task creation request
    await sendMessage({
      text: `${testMarker} Create a task called "${taskTitle}" due tomorrow at 3pm`,
      topicKey,
      channel: "cli",
    });

    // Wait for initial response
    await waitForDeliveredMessage(topicKey, beforeTimestampMs);

    // Check if approval is needed and handle it
    const approval = await getPendingApproval(topicKey);
    if (approval) {
      const beforeApprovalMs = Date.now();
      await respondToApproval(approval.id, "approve", topicKey);
      // Wait for confirmation response after approval
      await waitForDeliveredMessage(topicKey, beforeApprovalMs);
    }

    // Wait a bit for task to be created in DB
    await sleep(2000);

    // Verify task exists in database
    const task = await waitFor(
      () => findTaskByTitle(taskTitle),
      {
        timeout: 30000,
        interval: 1000,
        message: `Task "${taskTitle}" not found in database`,
      }
    );

    // Assert task has required fields
    assertTrue(task !== null, `Expected task "${taskTitle}" to exist`);
    assertTrue(
      task!.due_at !== null,
      `Expected task to have due_at set, but it was null`
    );

    return {
      name,
      passed: true,
      duration: Date.now() - startTime,
      input: `${testMarker} Create task "${taskTitle}" due tomorrow`,
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
