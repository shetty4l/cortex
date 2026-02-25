/**
 * Task management using StateLoader collection persistence.
 *
 * Tasks are tracked items linked to topics with status and due dates.
 */

import {
  CollectionEntity,
  CollectionField as Field,
  Id,
  Index,
  PersistedCollection,
  type StateLoader,
} from "@shetty4l/core/state";

/**
 * Task entity persisted to SQLite via StateLoader.
 *
 * Uses @PersistedCollection for multi-row table storage with explicit save().
 */
@PersistedCollection("tasks")
export class Task extends CollectionEntity {
  @Id() id: string = "";
  @Field("string") @Index() topic_id: string = "";
  @Field("string") title: string = "";
  @Field("string") description: string | null = null;
  @Field("string") @Index() status: string = "pending";
  @Field("number") @Index() due_at: number | null = null;
  @Field("number") completed_at: number | null = null;

  async save(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }

  async delete(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }
}

export interface CreateTaskInput {
  topic_id: string;
  title: string;
  description?: string;
  due_at?: number;
}

/**
 * Create a new task.
 */
export function createTask(
  stateLoader: StateLoader,
  input: CreateTaskInput,
): Task {
  return stateLoader.create(Task, {
    id: crypto.randomUUID(),
    topic_id: input.topic_id,
    title: input.title,
    description: input.description ?? null,
    status: "pending",
    due_at: input.due_at ?? null,
    completed_at: null,
  });
}

/**
 * Get a task by ID.
 */
export function getTask(stateLoader: StateLoader, id: string): Task | null {
  return stateLoader.get(Task, id);
}

/**
 * List tasks, optionally filtered by topic ID and/or status.
 */
export function listTasks(
  stateLoader: StateLoader,
  opts?: {
    topicId?: string;
    status?: string;
  },
): Task[] {
  const where: Record<string, unknown> = {};
  if (opts?.topicId) {
    where.topic_id = opts.topicId;
  }
  if (opts?.status) {
    where.status = opts.status;
  }

  return stateLoader.find(Task, {
    where,
    orderBy: { id: "desc" },
  });
}

/**
 * Update a task's fields.
 */
export async function updateTask(
  stateLoader: StateLoader,
  id: string,
  updates: Partial<Pick<Task, "title" | "description" | "status" | "due_at">>,
): Promise<void> {
  const task = stateLoader.get(Task, id);
  if (!task) return;

  if (updates.title !== undefined) task.title = updates.title;
  if (updates.description !== undefined) task.description = updates.description;
  if (updates.status !== undefined) task.status = updates.status;
  if (updates.due_at !== undefined) task.due_at = updates.due_at;

  await task.save();
}

/**
 * Mark a task as completed.
 */
export async function completeTask(
  stateLoader: StateLoader,
  id: string,
): Promise<void> {
  const task = stateLoader.get(Task, id);
  if (!task) return;

  task.status = "completed";
  task.completed_at = Date.now();
  await task.save();
}

/**
 * Get tasks that are past their due date.
 * Returns tasks with status 'pending' or 'in_progress' where due_at < now.
 *
 * Boundary: Tasks with due_at exactly equal to now are considered "due soon"
 * (handled by getTasksDueSoon), not overdue.
 */
export function getOverdueTasks(stateLoader: StateLoader): Task[] {
  const now = Date.now();
  // Query for tasks with active statuses and overdue (strictly less than now)
  const pendingTasks = stateLoader.find(Task, {
    where: {
      status: { op: "in", value: ["pending", "in_progress"] } as unknown as {
        op: "in";
        value: string;
      },
      due_at: { op: "lt", value: now },
    },
    orderBy: { due_at: "asc" },
  });

  // Filter out null due_at (isNotNull isn't combinable with lt in single where)
  return pendingTasks.filter((t) => t.due_at !== null);
}

/**
 * Get tasks due within a specified time window (but not yet overdue).
 * Returns tasks with status 'pending' or 'in_progress' where due_at is between now and now + withinMs (inclusive).
 *
 * Boundary: Tasks with due_at exactly equal to now ARE included here (not in getOverdueTasks).
 *
 * @param withinMs Time window in milliseconds (e.g., 86400000 for 24 hours)
 */
export function getTasksDueSoon(
  stateLoader: StateLoader,
  withinMs: number,
): Task[] {
  const now = Date.now();
  const deadline = now + withinMs;

  // StateLoader find() doesn't support compound range queries (>= now AND <= deadline)
  // So we filter in memory after fetching tasks due before deadline
  const tasksDueBeforeDeadline = stateLoader.find(Task, {
    where: {
      status: { op: "in", value: ["pending", "in_progress"] } as unknown as {
        op: "in";
        value: string;
      },
      due_at: { op: "lte", value: deadline },
    },
    orderBy: { due_at: "asc" },
  });

  // Filter to only tasks due at or after now (not yet overdue)
  return tasksDueBeforeDeadline.filter(
    (t) => t.due_at !== null && t.due_at >= now,
  );
}
