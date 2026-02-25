/**
 * Inbox message management using StateLoader collection persistence.
 *
 * Inbox messages are inbound user messages queued for processing.
 * Supports atomic claim, retry with backoff, and duplicate detection.
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
 * InboxMessage entity persisted to SQLite via StateLoader.
 *
 * Uses @PersistedCollection for multi-row table storage with explicit save().
 * Deduplication is on (channel, external_message_id), not idempotency_key.
 */
@PersistedCollection("inbox_messages")
export class InboxMessage extends CollectionEntity {
  @Id() id: string = "";
  @Field("string") @Index() channel: string = "";
  @Field("string") external_message_id: string = "";
  @Field("string") @Index() topic_key: string = "";
  @Field("string") user_id: string = "";
  @Field("string") text: string = "";
  @Field("number") occurred_at: number = 0;
  @Field("string") idempotency_key: string = "";
  @Field("string") metadata_json: string | null = null;
  @Field("number") priority: number = 5;
  @Field("string") @Index() status: string = "pending";
  @Field("number") attempts: number = 0;
  @Field("number") @Index() next_attempt_at: number = 0;
  @Field("string") error: string | null = null;
  @Field("number") processing_ms: number | null = null;

  async save(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }

  async delete(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }
}

// --- Input/Output types ---

export interface EnqueueInboxInput {
  channel: string;
  externalMessageId: string;
  topicKey: string;
  userId: string;
  text: string;
  occurredAt: number;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  priority?: number;
}

export interface EnqueueResult {
  /** The event ID (same as 'id', provided for backward compatibility) */
  eventId: string;
  /** The message ID */
  id: string;
  /** True if this was a duplicate and no new message was created */
  duplicate: boolean;
}

// --- Backoff calculation ---

/**
 * Compute exponential backoff delay for inbox retries.
 * Formula: min(2^(attempts-1) * 5000ms, 15min) with +/-20% jitter.
 *
 * Pure function - exported for testing.
 */
export function computeBackoffDelay(attempts: number): number {
  const base = Math.min(2 ** (attempts - 1) * 5000, 900_000);
  const jitter = 0.8 + Math.random() * 0.4; // [0.8, 1.2]
  return Math.round(base * jitter);
}

// --- Inbox operations ---

/**
 * Check if an inbox message already exists for this (channel, externalMessageId).
 * Returns the existing message ID if found, null otherwise.
 */
export function findInboxDuplicate(
  stateLoader: StateLoader,
  channel: string,
  externalMessageId: string,
): string | null {
  const existing = stateLoader.find(InboxMessage, {
    where: { channel, external_message_id: externalMessageId },
    limit: 1,
  });
  return existing.length > 0 ? existing[0].id : null;
}

/**
 * Enqueue a new inbox message.
 *
 * Returns { id, duplicate: true } if a message with the same
 * (channel, externalMessageId) already exists.
 */
export function enqueueInboxMessage(
  stateLoader: StateLoader,
  input: EnqueueInboxInput,
): EnqueueResult {
  // Check for existing duplicate
  const existingId = findInboxDuplicate(
    stateLoader,
    input.channel,
    input.externalMessageId,
  );
  if (existingId) {
    return { id: existingId, eventId: existingId, duplicate: true };
  }

  const message = stateLoader.create(InboxMessage, {
    id: `evt_${crypto.randomUUID()}`,
    channel: input.channel,
    external_message_id: input.externalMessageId,
    topic_key: input.topicKey,
    user_id: input.userId,
    text: input.text,
    occurred_at: input.occurredAt,
    idempotency_key: input.idempotencyKey,
    metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
    priority: input.priority ?? 5,
    status: "pending",
    attempts: 0,
    next_attempt_at: 0,
    error: null,
    processing_ms: null,
  });

  return { id: message.id, eventId: message.id, duplicate: false };
}

/**
 * Get an inbox message by ID.
 */
export function getInboxMessage(
  stateLoader: StateLoader,
  id: string,
): InboxMessage | null {
  return stateLoader.get(InboxMessage, id);
}

/**
 * Atomically claim the next pending inbox message for processing.
 *
 * Claims the oldest message where:
 * - status = 'pending'
 * - next_attempt_at <= now
 *
 * Sets status to 'processing' and increments attempts.
 * Returns null if no eligible messages exist.
 */
export async function claimNextInboxMessage(
  stateLoader: StateLoader,
): Promise<InboxMessage | null> {
  const now = Date.now();

  return stateLoader.transaction(async () => {
    // Find oldest pending message ready for processing
    // Order by priority first, then occurred_at for FIFO within priority
    const candidates = stateLoader.find(InboxMessage, {
      where: {
        status: "pending",
        next_attempt_at: { op: "lte", value: now },
      },
      orderBy: { priority: "asc", occurred_at: "asc" },
      limit: 1,
    });

    if (candidates.length === 0) {
      return null;
    }

    const message = candidates[0];
    message.status = "processing";
    message.attempts = message.attempts + 1;
    await message.save();

    return message;
  });
}

/**
 * Mark an inbox message as complete (done or failed).
 *
 * @param processingMs Optional processing duration in milliseconds
 * @param error If provided, marks as 'failed' instead of 'done'
 */
export async function completeInboxMessage(
  stateLoader: StateLoader,
  id: string,
  processingMs?: number,
  error?: string,
): Promise<void> {
  const message = stateLoader.get(InboxMessage, id);
  if (!message) return;

  message.status = error ? "failed" : "done";
  message.error = error ?? null;
  message.processing_ms = processingMs ?? null;
  await message.save();
}

/**
 * Retry an inbox message with exponential backoff.
 *
 * If attempts >= maxAttempts, marks as permanently 'failed' instead.
 */
export async function retryInboxMessage(
  stateLoader: StateLoader,
  id: string,
  attempts: number,
  maxAttempts: number,
  error: string,
): Promise<void> {
  const message = stateLoader.get(InboxMessage, id);
  if (!message) return;

  if (attempts >= maxAttempts) {
    // Permanent failure - max retries exhausted
    message.status = "failed";
    message.error = error;
    await message.save();
    return;
  }

  // Schedule retry with exponential backoff
  const delay = computeBackoffDelay(attempts);
  const nextAttemptAt = Date.now() + delay;

  message.status = "pending";
  message.next_attempt_at = nextAttemptAt;
  message.error = error;
  await message.save();
}

/**
 * List recent inbox messages, most recent first.
 */
export function listInboxMessages(
  stateLoader: StateLoader,
  limit = 20,
): InboxMessage[] {
  return stateLoader.find(InboxMessage, {
    orderBy: { occurred_at: "desc" },
    limit,
  });
}
