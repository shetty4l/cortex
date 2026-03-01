/**
 * Test 05: Task approval flow.
 *
 * Triggers an approval request and verifies:
 * - Approval is created with status='pending'
 * - After approve response, status='approved'
 * - Task is created after approval
 */

import type { TestResult } from "../lib/types";
import { sendMessage, getPendingApproval, respondToApproval } from "../lib/cortex";
import { waitForDeliveredMessage } from "../lib/outbox";
import { findTaskByTitle } from "../lib/tasks";
import { openCortexDb, queryOne } from "../lib/db";
import { assertTrue, assertEqual } from "../lib/assert";
import { waitFor, sleep } from "../lib/wait";
import type { Approval } from "../lib/cortex";

export const name = "05-task-approval";

function generateTestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function getApprovalById(approvalId: string): Promise<Approval | null> {
  const db = await openCortexDb();
  return queryOne<Approval>(
    db,
    `SELECT id, topic_key, action, status FROM pending_approvals WHERE id = $id`,
    { $id: approvalId }
  );
}

export async function run(): Promise<TestResult> {
  const startTime = Date.now();
  const testId = generateTestId();
  const testMarker = `[TEST-${testId}]`;
  const topicKey = `test-task-approval-${testId}`;
  const taskTitle = `ApprovalTask-${testId}`;

  try {
    const beforeTimestampMs = Date.now();

    // Send a task creation request that should trigger approval
    await sendMessage({
      text: `${testMarker} Create a task called "${taskTitle}" due next week`,
      topicKey,
      channel: "cli",
    });

    // Wait for response (which may include approval request)
    await waitForDeliveredMessage(topicKey, beforeTimestampMs);

    // Wait for pending approval to appear
    const approval = await waitFor(
      () => getPendingApproval(topicKey),
      {
        timeout: 30000,
        interval: 1000,
        message: `No pending approval found for topic ${topicKey}`,
      }
    );

    assertTrue(approval !== null, "Expected pending approval to exist");
    assertEqual(
      approval!.status,
      "pending",
      `Expected approval status='pending', got '${approval!.status}'`
    );

    // Send approve response
    const beforeApprovalMs = Date.now();
    await respondToApproval(approval!.id, "approve", topicKey);

    // Wait for confirmation response
    await waitForDeliveredMessage(topicKey, beforeApprovalMs);

    // Give time for approval status update and task creation
    await sleep(2000);

    // Verify approval status changed to 'approved'
    const updatedApproval = await getApprovalById(approval!.id);
    assertTrue(
      updatedApproval !== null,
      "Expected approval record to still exist"
    );
    assertEqual(
      updatedApproval!.status,
      "approved",
      `Expected approval status='approved', got '${updatedApproval!.status}'`
    );

    // Verify task was created
    const task = await waitFor(
      () => findTaskByTitle(taskTitle),
      {
        timeout: 30000,
        interval: 1000,
        message: `Task "${taskTitle}" not found after approval`,
      }
    );

    assertTrue(task !== null, `Expected task "${taskTitle}" to exist after approval`);

    return {
      name,
      passed: true,
      duration: Date.now() - startTime,
      input: `${testMarker} Create task "${taskTitle}" → approve`,
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
