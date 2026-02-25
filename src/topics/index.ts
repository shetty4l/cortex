/**
 * Topic management using StateLoader collection persistence.
 *
 * Topics are conversation containers that group related messages together.
 * Each topic has an optional key for external references (e.g., Telegram thread ID).
 */

import {
  CollectionEntity,
  Id,
  Index,
  PersistedCollection,
  type StateLoader,
} from "@shetty4l/core/state";
// TODO: Replace with `import { CollectionField as Field } from "@shetty4l/core/state"`
// once core v0.1.37 is published (see core#54)
import { Field } from "../../node_modules/@shetty4l/core/src/state/collection/decorators";

/**
 * Topic entity persisted to SQLite via StateLoader.
 *
 * Uses @PersistedCollection for multi-row table storage with explicit save().
 */
@PersistedCollection("topics")
export class Topic extends CollectionEntity {
  @Id() id: string = "";
  @Field("string") @Index() key: string | null = null;
  @Field("string") name: string = "";
  @Field("string") description: string | null = null;
  @Field("string") @Index() status: string = "active";
  @Field("number") starts_at: number | null = null;
  @Field("number") ends_at: number | null = null;
  @Field("number") telegram_thread_id: number | null = null;

  async save(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }

  async delete(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }
}

export interface CreateTopicInput {
  key?: string;
  name: string;
  description?: string;
  starts_at?: number;
  ends_at?: number;
  telegram_thread_id?: number;
}

/**
 * Create a new topic.
 */
export function createTopic(
  stateLoader: StateLoader,
  input: CreateTopicInput,
): Topic {
  return stateLoader.create(Topic, {
    id: crypto.randomUUID(),
    key: input.key ?? null,
    name: input.name,
    description: input.description ?? null,
    starts_at: input.starts_at ?? null,
    ends_at: input.ends_at ?? null,
    telegram_thread_id: input.telegram_thread_id ?? null,
  });
}

/**
 * Get a topic by ID.
 */
export function getTopic(stateLoader: StateLoader, id: string): Topic | null {
  return stateLoader.get(Topic, id);
}

/**
 * Get a topic by its unique key.
 */
export function getTopicByKey(
  stateLoader: StateLoader,
  key: string,
): Topic | null {
  const topics = stateLoader.find(Topic, {
    where: { key },
    limit: 1,
  });
  return topics.length > 0 ? topics[0] : null;
}

/**
 * Get a topic by key, or create it if it doesn't exist.
 * When creating, uses the key as both the key and name.
 */
export function getOrCreateTopicByKey(
  stateLoader: StateLoader,
  key: string,
): Topic {
  const existing = getTopicByKey(stateLoader, key);
  if (existing) return existing;
  return createTopic(stateLoader, { key, name: key });
}

/**
 * List topics, optionally filtered by status.
 */
export function listTopics(stateLoader: StateLoader, status?: string): Topic[] {
  if (status) {
    return stateLoader.find(Topic, {
      where: { status },
      orderBy: { id: "desc" },
    });
  }
  return stateLoader.find(Topic, {
    orderBy: { id: "desc" },
  });
}

/**
 * Update a topic's fields.
 */
export async function updateTopic(
  stateLoader: StateLoader,
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
): Promise<void> {
  const topic = stateLoader.get(Topic, id);
  if (!topic) return;

  if (updates.name !== undefined) topic.name = updates.name;
  if (updates.description !== undefined)
    topic.description = updates.description;
  if (updates.status !== undefined) topic.status = updates.status;
  if (updates.starts_at !== undefined) topic.starts_at = updates.starts_at;
  if (updates.ends_at !== undefined) topic.ends_at = updates.ends_at;
  if (updates.telegram_thread_id !== undefined) {
    topic.telegram_thread_id = updates.telegram_thread_id;
  }

  await topic.save();
}
