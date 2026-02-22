import { getDatabase } from "../db";

export interface Task {
  id: string;
  topic_id: string;
  title: string;
  description: string | null;
  status: string;
  due_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CreateTaskInput {
  topic_id: string;
  title: string;
  description?: string;
  due_at?: number;
}

export function createTask(input: CreateTaskInput): Task {
  const db = getDatabase();
  const now = Date.now();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO tasks (id, topic_id, title, description, due_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.topic_id,
    input.title,
    input.description ?? null,
    input.due_at ?? null,
    now,
    now,
  );
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task;
}

export function getTask(id: string): Task | null {
  const db = getDatabase();
  return (
    (db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task) ?? null
  );
}

export function listTasks(opts?: {
  topicId?: string;
  status?: string;
}): Task[] {
  const db = getDatabase();
  const conditions: string[] = [];
  const values: (string | number | null)[] = [];
  if (opts?.topicId) {
    conditions.push("topic_id = ?");
    values.push(opts.topicId);
  }
  if (opts?.status) {
    conditions.push("status = ?");
    values.push(opts.status);
  }
  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC`)
    .all(...values) as Task[];
}

export function updateTask(
  id: string,
  updates: Partial<Pick<Task, "title" | "description" | "status" | "due_at">>,
): void {
  const db = getDatabase();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(value as string | number | null);
  }
  if (fields.length === 0) return;
  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(
    ...values,
  );
}

export function completeTask(id: string): void {
  const db = getDatabase();
  const now = Date.now();
  db.prepare(
    "UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?",
  ).run(now, now, id);
}
