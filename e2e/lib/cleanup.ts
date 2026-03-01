/**
 * Test data cleanup helpers for E2E tests.
 *
 * Provides functions to clean up test-created data from
 * Cortex DB and Engram to prevent test pollution.
 */

import { openCortexDb, execute, query } from "./db";
import { forget, recall } from "./engram";

export interface CleanupOptions {
  /** Pattern to match topic keys (LIKE pattern, e.g., 'test-%') */
  topicKeyPattern?: string;
  /** Pattern to match task titles (LIKE pattern, e.g., '%[TEST-%') */
  taskTitlePattern?: string;
  /** Scope ID pattern to match memories for deletion */
  memoryScopePattern?: string;
  /** Dry run - log what would be deleted without deleting */
  dryRun?: boolean;
}

export interface CleanupResult {
  tasksDeleted: number;
  topicsDeleted: number;
  memoriesDeleted: number;
}

/**
 * Clean up test data from Cortex DB and Engram.
 *
 * Deletes:
 * - Tasks matching taskTitlePattern
 * - Topics matching topicKeyPattern (and their related outbox/inbox/tasks)
 * - Memories matching memoryScopePattern
 *
 * @param opts - Cleanup options with patterns to match
 * @returns Summary of what was deleted
 */
export async function cleanupTestData(
  opts: CleanupOptions = {}
): Promise<CleanupResult> {
  const { topicKeyPattern, taskTitlePattern, memoryScopePattern, dryRun } = opts;
  const result: CleanupResult = {
    tasksDeleted: 0,
    topicsDeleted: 0,
    memoriesDeleted: 0,
  };

  const db = await openCortexDb();

  // Delete tasks matching title pattern
  if (taskTitlePattern) {
    const matchingTasks = query<{ id: string; title: string }>(
      db,
      `SELECT id, title FROM tasks WHERE title LIKE $pattern`,
      { $pattern: taskTitlePattern }
    );

    if (dryRun) {
      console.log(`[DRY RUN] Would delete ${matchingTasks.length} tasks:`);
      for (const task of matchingTasks) {
        console.log(`  - ${task.title} (${task.id})`);
      }
    } else {
      execute(db, `DELETE FROM tasks WHERE title LIKE $pattern`, {
        $pattern: taskTitlePattern,
      });
      result.tasksDeleted = matchingTasks.length;
    }
  }

  // Delete topics and related data matching topic_key pattern
  if (topicKeyPattern) {
    const matchingTopics = query<{ id: string; topic_key: string }>(
      db,
      `SELECT id, topic_key FROM topics WHERE topic_key LIKE $pattern`,
      { $pattern: topicKeyPattern }
    );

    if (dryRun) {
      console.log(`[DRY RUN] Would delete ${matchingTopics.length} topics:`);
      for (const topic of matchingTopics) {
        console.log(`  - ${topic.topic_key} (${topic.id})`);
      }
    } else {
      // Delete related records first (due to foreign keys)
      for (const topic of matchingTopics) {
        execute(db, `DELETE FROM outbox WHERE topic_id = $topicId`, {
          $topicId: topic.id,
        });
        execute(db, `DELETE FROM inbox WHERE topic_id = $topicId`, {
          $topicId: topic.id,
        });
        execute(db, `DELETE FROM tasks WHERE topic_id = $topicId`, {
          $topicId: topic.id,
        });
        execute(db, `DELETE FROM approvals WHERE topic_id = $topicId`, {
          $topicId: topic.id,
        });
        execute(db, `DELETE FROM topic_summaries WHERE topic_id = $topicId`, {
          $topicId: topic.id,
        });
      }
      // Delete the topics themselves
      execute(db, `DELETE FROM topics WHERE topic_key LIKE $pattern`, {
        $pattern: topicKeyPattern,
      });
      result.topicsDeleted = matchingTopics.length;
    }
  }

  // Delete memories matching scope pattern
  if (memoryScopePattern) {
    try {
      // Recall memories with scope pattern as query to find them
      // Note: This is a best-effort search - Engram doesn't support wildcard scope queries
      const recallResult = await recall({
        query: memoryScopePattern,
        limit: 100,
      });

      if (dryRun) {
        console.log(
          `[DRY RUN] Would delete ${recallResult.memories.length} memories`
        );
        for (const memory of recallResult.memories) {
          console.log(
            `  - ${memory.id}: ${memory.content.substring(0, 50)}...`
          );
        }
      } else {
        for (const memory of recallResult.memories) {
          await forget({ id: memory.id });
          result.memoriesDeleted++;
        }
      }
    } catch {
      // Engram may not be available in all test environments
      console.warn("Warning: Could not clean up memories (Engram unavailable)");
    }
  }

  return result;
}

/**
 * Delete all tasks for a specific topic.
 */
export async function deleteTasksForTopic(topicId: string): Promise<number> {
  const db = await openCortexDb();
  const tasks = query<{ id: string }>(
    db,
    `SELECT id FROM tasks WHERE topic_id = $topicId`,
    { $topicId: topicId }
  );
  execute(db, `DELETE FROM tasks WHERE topic_id = $topicId`, {
    $topicId: topicId,
  });
  return tasks.length;
}

/**
 * Delete a specific topic and all its related data.
 */
export async function deleteTopic(topicId: string): Promise<void> {
  const db = await openCortexDb();

  // Delete related records first
  execute(db, `DELETE FROM outbox WHERE topic_id = $topicId`, {
    $topicId: topicId,
  });
  execute(db, `DELETE FROM inbox WHERE topic_id = $topicId`, {
    $topicId: topicId,
  });
  execute(db, `DELETE FROM tasks WHERE topic_id = $topicId`, {
    $topicId: topicId,
  });
  execute(db, `DELETE FROM approvals WHERE topic_id = $topicId`, {
    $topicId: topicId,
  });
  execute(db, `DELETE FROM topic_summaries WHERE topic_id = $topicId`, {
    $topicId: topicId,
  });
  execute(db, `DELETE FROM topics WHERE id = $topicId`, {
    $topicId: topicId,
  });
}
