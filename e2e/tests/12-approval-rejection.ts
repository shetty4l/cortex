/**
 * Test 12: Approval rejection - verify rejection prevents task creation.
 *
 * Triggers an approval flow, rejects it, and verifies:
 * - Approval status is 'rejected'
 * - No task was created
 */

import type { TestResult } from "../lib/types";
import { sendMessage, getPendingApproval, respondToApproval } from "../lib/cortex";
import { waitForDeliveredMessage } from "../lib/outbox";
import { openCortexDb, queryOne } from "../lib/db";
import { waitFor } from "../lib/wait";
import { assertTrue, assertEqual } from "../lib/assert";
import type { Task } from "../lib/types";

export const name = "12-approval-rejection";

interface Approval {
  id: string;
  topic_key: string;
  action: string;
  status: string;
}

function generateTestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function run(): Promise<TestResult> {
  const startTime = Date.now();
  const testId = generateTestId();
  const testMarker = `[TEST-${testId}]`;
  const topicKey = `test-approval-rejection-${testId}`;
  const taskTitle = `rejected-task-${testId}`;

  try {
    const beforeTimestampMs = Date.now();

    // Send a message that should trigger task creation requiring approval
    await sendMessage({
      text: `${testMarker} Please create a task called "${taskTitle}" for tomorrow.`,
      topicKey,
      channel: "cli",
    });

    // Wait for response
    await waitForDeliveredMessage(topicKey, beforeTimestampMs);

    // Wait for pending approval to appear
    const approval = await waitFor<Approval>(
      async () => getPendingApproval(topicKey),
      {
        timeout: 30000,
        interval: 1000,
        message: "pending approval not found",
      }
    );

    assertTrue(
      approval !== null,
      `Expected pending approval for topic "${topicKey}"`
    );

    // Reject the approval
    const rejectTimestampMs = Date.now();
    await respondToApproval(approval!.id, "reject", topicKey);

    // Wait for rejection response
    await waitForDeliveredMessage(topicKey, rejectTimestampMs);

    // Verify approval status is now 'rejected'
    const db = await openCortexDb();
    const updatedApproval = queryOne<Approval>(
      db,
      `SELECT id, topic_key, action, status FROM pending_approvals WHERE id = $id`,
      { $id: approval!.id }
    );

    assertEqual(
      updatedApproval?.status,
      "rejected",
      `Expected approval status to be 'rejected', got '${updatedApproval?.status}'`
    );

    // Verify NO task was created with this title
    const task = queryOne<Task>(
      db,
      `SELECT id, topic_id, title, description, status, due_at, completed_at
       FROM tasks
       WHERE title LIKE $pattern`,
      { $pattern: `%${taskTitle}%` }
    );

    assertTrue(
      task === null,
      `Expected no task with title containing "${taskTitle}" to exist, but found one`
    );

    return {
      name,
      passed: true,
      duration: Date.now() - startTime,
      input: `${testMarker} Please create a task called "${taskTitle}" for tomorrow.`,
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
