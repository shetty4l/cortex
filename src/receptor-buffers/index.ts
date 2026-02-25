/**
 * Receptor buffer management using StateLoader collection persistence.
 *
 * Receptor buffers temporarily store incoming messages from external channels
 * before they are processed and converted into inbox messages.
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
 * ReceptorBuffer entity persisted to SQLite via StateLoader.
 *
 * Uses @PersistedCollection for multi-row table storage with explicit save().
 * Deduplication is on (channel, external_id).
 */
@PersistedCollection("receptor_buffers")
export class ReceptorBuffer extends CollectionEntity {
  @Id() id: string = "";
  @Field("string") @Index() channel: string = "";
  @Field("string") external_id: string = "";
  @Field("string") content: string = "";
  @Field("string") metadata_json: string | null = null;
  @Field("number") @Index() occurred_at: number = 0;

  async save(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }

  async delete(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }
}

// --- Input types ---

export interface InsertReceptorBufferInput {
  channel: string;
  externalId: string;
  content: string;
  metadataJson?: string | null;
  occurredAt: number;
}

export interface InsertResult {
  id: string;
  duplicate: boolean;
}

// --- ReceptorBuffer operations ---

/**
 * Check if a receptor buffer already exists for this (channel, externalId).
 * Returns the existing buffer ID if found, null otherwise.
 */
function findDuplicate(
  stateLoader: StateLoader,
  channel: string,
  externalId: string,
): string | null {
  const existing = stateLoader.find(ReceptorBuffer, {
    where: { channel, external_id: externalId },
    limit: 1,
  });
  return existing.length > 0 ? existing[0].id : null;
}

/**
 * Insert a receptor buffer row.
 *
 * Uses upsert semantics: returns the existing ID if a duplicate exists,
 * otherwise creates a new buffer.
 *
 * Returns { id, duplicate: true } if a buffer with the same
 * (channel, externalId) already exists.
 */
export function insertReceptorBuffer(
  stateLoader: StateLoader,
  input: InsertReceptorBufferInput,
): InsertResult {
  // Check for existing duplicate
  const existingId = findDuplicate(
    stateLoader,
    input.channel,
    input.externalId,
  );
  if (existingId) {
    return { id: existingId, duplicate: true };
  }

  const buffer = stateLoader.create(ReceptorBuffer, {
    id: `rb_${crypto.randomUUID()}`,
    channel: input.channel,
    external_id: input.externalId,
    content: input.content,
    metadata_json: input.metadataJson ?? null,
    occurred_at: input.occurredAt,
  });

  return { id: buffer.id, duplicate: false };
}

/**
 * Get unprocessed receptor buffers, ordered by occurred_at ASC.
 *
 * Optionally filter by:
 * - channel: Only buffers from this channel
 * - since: Only buffers created after this timestamp
 */
export function getUnprocessedBuffers(
  stateLoader: StateLoader,
  opts?: {
    channel?: string;
    since?: number;
  },
): ReceptorBuffer[] {
  const where: Record<string, unknown> = {};

  if (opts?.channel) {
    where.channel = opts.channel;
  }

  // StateLoader uses created_at internally for the since filter
  // But our schema tracks occurred_at for ordering
  // For "since", we filter by occurred_at > since
  if (opts?.since !== undefined) {
    where.occurred_at = { op: "gt", value: opts.since };
  }

  return stateLoader.find(ReceptorBuffer, {
    where: Object.keys(where).length > 0 ? where : undefined,
    orderBy: { occurred_at: "asc" },
  });
}

/**
 * Delete processed receptor buffer rows by their IDs.
 *
 * Returns the number of rows deleted.
 * Handles empty ids array gracefully (returns 0).
 */
export function deleteProcessedBuffers(
  stateLoader: StateLoader,
  ids: string[],
): number {
  if (ids.length === 0) {
    return 0;
  }

  // Cast needed because WhereCondition<T> expects value: T, but 'in' uses T[]
  return stateLoader.deleteWhere(ReceptorBuffer, {
    id: { op: "in", value: ids } as unknown as { op: "in"; value: string },
  });
}

/**
 * Get a receptor buffer by ID.
 */
export function getReceptorBuffer(
  stateLoader: StateLoader,
  id: string,
): ReceptorBuffer | null {
  return stateLoader.get(ReceptorBuffer, id);
}
