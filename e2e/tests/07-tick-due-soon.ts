/**
 * Test 07: Tick due soon - task due soon notification.
 *
 * Inserts a task with future due_at (now + 6 hours) directly into DB
 * and waits for tick notification with 'due_soon' warning.
 */

import type { TestResult } from "../lib/types";
import { openCortexDb, execute } from "../lib/db";
import { insertTask, deleteTask } from "../lib/tasks";
import { waitForTickMessage } from "../lib/tick";
import { assertTrue } from "../lib/assert";

export const name = "07-tick-due-soon";

function generateTestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function run(): Promise<TestResult> {
  const startTime = Date.now();
  const testId = generateTestId();
  const testMarker = `[TEST-${testId}]`;
  const topicKey = `test-tick-due-soon-${testId}`;

  let taskId: string | null = null;
  let topicId: string | null = null;

  try {
    const db = await openCortexDb();
    const beforeTimestampMs = Date.now();

    // Create topic directly in DB for this test
    // topics table has: id, key, name, description, status, starts_at, ends_at, created_at, updated_at
    topicId = crypto.randomUUID();
    const now = new Date().toISOString();
    execute(
      db,
      `INSERT INTO topics (id, key, name, status, created_at, updated_at)
       VALUES ($id, $key, $name, 'active', $createdAt, $updatedAt)`,
      {
        $id: topicId,
        $key: topicKey,
        $name: `Test Topic ${testMarker}`,
        $createdAt: now,
        $updatedAt: now,
      }
    );

    // Insert task with due_at = now + 6 hours (within 24h, triggers due_soon)
    const sixHoursFromNow = Date.now() + 6 * 60 * 60 * 1000;
    taskId = await insertTask({
      title: `${testMarker} Due soon task`,
      topicId: topicId,
      dueAt: sixHoursFromNow,
      status: "pending",
    });

    // Wait for tick message with 'due_soon' warning (120s timeout)
    const tickMessage = await waitForTickMessage(topicKey, beforeTimestampMs, {
      warningType: "due_soon",
      timeout: 120_000,
    });

    // Assert tick message contains expected warning
    assertTrue(
      tickMessage.text.toLowerCase().includes("due_soon") ||
        tickMessage.text.toLowerCase().includes("due soon"),
      `Expected tick message to contain 'due_soon' or 'due soon', got: ${tickMessage.text}`
    );

    return {
      name,
      passed: true,
      duration: Date.now() - startTime,
      input: `Task with due_at = now + 6 hours`,
    };
  } catch (err) {
    return {
      name,
      passed: false,
      duration: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Cleanup: delete test task and topic
    if (taskId) {
      try {
        await deleteTask(taskId);
      } catch {
        // Ignore cleanup errors
      }
    }
    if (topicId) {
      try {
        const db = await openCortexDb();
        execute(db, `DELETE FROM outbox_messages WHERE topic_key = $topicKey`, {
          $topicKey: topicKey,
        });
        execute(db, `DELETE FROM inbox_messages WHERE topic_key = $topicKey`, {
          $topicKey: topicKey,
        });
        execute(db, `DELETE FROM topics WHERE id = $id`, { $id: topicId });
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
