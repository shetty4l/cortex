/**
 * Task helper functions for E2E tests.
 *
 * Provides direct database access to tasks and topics tables
 * for test setup and verification.
 */

import { openCortexDb, query, queryOne, execute } from "./db";
import type { Task } from "./types";

export interface InsertTaskInput {
  title: string;
  topicId: string;
  dueAt?: number;
  status?: string;
}

/**
 * Insert a task directly into the tasks table.
 * Returns the generated task ID.
 */
export async function insertTask(input: InsertTaskInput): Promise<string> {
  const db = await openCortexDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  execute(
    db,
    `INSERT INTO tasks (id, topic_id, title, description, status, due_at, completed_at, created_at, updated_at)
     VALUES ($id, $topicId, $title, NULL, $status, $dueAt, NULL, $createdAt, $updatedAt)`,
    {
      $id: id,
      $topicId: input.topicId,
      $title: input.title,
      $status: input.status ?? "pending",
      $dueAt: input.dueAt ?? null,
      $createdAt: now,
      $updatedAt: now,
    }
  );

  return id;
}

/**
 * Find a task by title using LIKE query.
 * Returns the first matching task or null.
 */
export async function findTaskByTitle(
  titlePattern: string
): Promise<Task | null> {
  const db = await openCortexDb();
  return queryOne<Task>(
    db,
    `SELECT id, topic_id, title, description, status, due_at, completed_at
     FROM tasks
     WHERE title LIKE $pattern
     ORDER BY created_at DESC
     LIMIT 1`,
    { $pattern: `%${titlePattern}%` }
  );
}

/**
 * Delete a task by ID.
 */
export async function deleteTask(id: string): Promise<void> {
  const db = await openCortexDb();
  execute(db, `DELETE FROM tasks WHERE id = $id`, { $id: id });
}

/**
 * Get the first topic ID from the topics table.
 * Useful for tests that need a valid topic ID but don't care which one.
 */
export async function getDefaultTopicId(): Promise<string | null> {
  const db = await openCortexDb();
  const result = queryOne<{ id: string }>(
    db,
    `SELECT id FROM topics ORDER BY created_at DESC LIMIT 1`
  );
  return result?.id ?? null;
}

/**
 * Get a topic ID by its key.
 */
export async function getTopicIdByKey(topicKey: string): Promise<string | null> {
  const db = await openCortexDb();
  const result = queryOne<{ id: string }>(
    db,
    `SELECT id FROM topics WHERE key = $key LIMIT 1`,
    { $key: topicKey }
  );
  return result?.id ?? null;
}

/**
 * Check if a topic exists by key.
 */
export async function topicExists(topicKey: string): Promise<boolean> {
  const id = await getTopicIdByKey(topicKey);
  return id !== null;
}

/**
 * Get topic details by key.
 */
export async function getTopicByKey(topicKey: string): Promise<{
  id: string;
  key: string;
  name: string;
  status: string;
} | null> {
  const db = await openCortexDb();
  return queryOne(
    db,
    `SELECT id, key, name, status FROM topics WHERE key = $key LIMIT 1`,
    { $key: topicKey }
  );
}
