import { getDatabase } from "../db";

export interface Topic {
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  status: string;
  starts_at: number | null;
  ends_at: number | null;
  telegram_thread_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface CreateTopicInput {
  key?: string;
  name: string;
  description?: string;
  starts_at?: number;
  ends_at?: number;
  telegram_thread_id?: number;
}

export function createTopic(input: CreateTopicInput): Topic {
  const db = getDatabase();
  const now = Date.now();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO topics (id, key, name, description, starts_at, ends_at, telegram_thread_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.key ?? null,
    input.name,
    input.description ?? null,
    input.starts_at ?? null,
    input.ends_at ?? null,
    input.telegram_thread_id ?? null,
    now,
    now,
  );
  return db.prepare("SELECT * FROM topics WHERE id = ?").get(id) as Topic;
}

export function getTopic(id: string): Topic | null {
  const db = getDatabase();
  return (
    (db.prepare("SELECT * FROM topics WHERE id = ?").get(id) as Topic) ?? null
  );
}

export function listTopics(status?: string): Topic[] {
  const db = getDatabase();
  if (status) {
    return db
      .prepare("SELECT * FROM topics WHERE status = ? ORDER BY created_at DESC")
      .all(status) as Topic[];
  }
  return db
    .prepare("SELECT * FROM topics ORDER BY created_at DESC")
    .all() as Topic[];
}

export function updateTopic(
  id: string,
  updates: Partial<
    Pick<
      Topic,
      | "name"
      | "description"
      | "status"
      | "starts_at"
      | "ends_at"
      | "telegram_thread_id"
    >
  >,
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
  db.prepare(`UPDATE topics SET ${fields.join(", ")} WHERE id = ?`).run(
    ...values,
  );
}
