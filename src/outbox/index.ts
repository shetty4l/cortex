/**
 * Outbox message management using StateLoader collection persistence.
 *
 * Outbox messages are outbound messages queued for delivery to channels.
 * Supports lease-based polling, acknowledgment, and dead-letter handling.
 */

import {
  CollectionEntity,
  CollectionField as Field,
  Id,
  Index,
  PersistedCollection,
  type StateLoader,
} from "@shetty4l/core/state";
import type { MessageType } from "../cerebellum/types";

/**
 * OutboxMessage entity persisted to SQLite via StateLoader.
 *
 * Uses @PersistedCollection for multi-row table storage with explicit save().
 */
@PersistedCollection("outbox_messages")
export class OutboxMessage extends CollectionEntity {
  @Id() id: string = "";
  @Field("string") @Index() channel: string = "";
  @Field("string") @Index() topic_key: string = "";
  @Field("string") text: string = "";
  @Field("string") payload_json: string | null = null;
  @Field("string") @Index() status: string = "pending";
  @Field("number") attempts: number = 0;
  @Field("number") @Index() next_attempt_at: number = 0;
  @Field("string") lease_token: string | null = null;
  @Field("number") lease_expires_at: number | null = null;
  @Field("string") last_error: string | null = null;
  @Field("number") @Index() created_at_ms: number = 0;

  // Routing fields for Cerebellum
  @Field("string") @Index() message_type: MessageType = "conversational";
  @Field("string") urgency: string = "normal";
  @Field("number") scheduled_for: number | null = null;
  @Field("string") response_to: string | null = null;

  async save(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }

  async delete(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }
}

// --- Input/Output types ---

export interface EnqueueOutboxInput {
  channel?: string;
  topicKey: string;
  text: string;
  payload?: Record<string, unknown>;
  /** Message type for Cerebellum routing. Default: "conversational" */
  messageType?: MessageType;
  /** Urgency level for routing. Default: "normal" */
  urgency?: string;
  /** Scheduled delivery time (epoch ms). Default: null (immediate) */
  scheduledFor?: number | null;
  /** ID of message this is a response to. Default: null */
  responseTo?: string | null;
}

export interface OutboxPollResult {
  messageId: string;
  leaseToken: string;
  topicKey: string;
  text: string;
  payload: Record<string, unknown> | null;
}

export type AckResult =
  | "delivered"
  | "already_delivered"
  | "lease_conflict"
  | "not_found";

// --- Backoff calculation ---

/**
 * Compute exponential backoff delay for outbox retries.
 * Formula: min(2^(attempts-1) * 5000ms, 15min) with +/-20% jitter.
 *
 * Pure function - exported for testing.
 */
export function computeBackoffDelay(attempts: number): number {
  const base = Math.min(2 ** (attempts - 1) * 5000, 900_000);
  const jitter = 0.8 + Math.random() * 0.4; // [0.8, 1.2]
  return Math.round(base * jitter);
}

// --- Outbox operations ---

/**
 * Enqueue a new outbox message for delivery.
 *
 * @returns The message ID
 */
export function enqueueOutboxMessage(
  stateLoader: StateLoader,
  input: EnqueueOutboxInput,
): string {
  const now = Date.now();
  const channel = input.channel ?? "silent";

  const message = stateLoader.create(OutboxMessage, {
    id: `out_${crypto.randomUUID()}`,
    channel,
    topic_key: input.topicKey,
    text: input.text,
    payload_json: input.payload ? JSON.stringify(input.payload) : null,
    status: "pending",
    attempts: 0,
    next_attempt_at: now,
    lease_token: null,
    lease_expires_at: null,
    last_error: null,
    created_at_ms: now,
    // Routing fields
    message_type: input.messageType ?? "conversational",
    urgency: input.urgency ?? "normal",
    scheduled_for: input.scheduledFor ?? null,
    response_to: input.responseTo ?? null,
  });

  return message.id;
}

/**
 * Get an outbox message by ID.
 */
export function getOutboxMessage(
  stateLoader: StateLoader,
  id: string,
): OutboxMessage | null {
  return stateLoader.get(OutboxMessage, id);
}

/**
 * List all outbox messages for a given topic key, ordered by creation time.
 */
export function listOutboxMessagesByTopic(
  stateLoader: StateLoader,
  topicKey: string,
): OutboxMessage[] {
  return stateLoader.find(OutboxMessage, {
    where: { topic_key: topicKey },
    orderBy: { id: "asc" },
  });
}

/**
 * Poll outbox messages for a connector channel.
 *
 * Atomically claims eligible messages by setting a lease.
 * Eligible messages: matching channel, next_attempt_at <= now, and either
 * status='pending' OR (status='leased' AND lease_expires_at <= now).
 *
 * Messages exceeding maxAttempts are moved to 'dead' status (DLQ).
 *
 * @param channel Channel to poll
 * @param max Maximum messages to claim
 * @param leaseSeconds Lease duration in seconds
 * @param maxAttempts Max attempts before dead-lettering
 * @param topicKey Optional topic filter
 * @returns Array of leased messages (excludes dead-lettered ones)
 */
export async function pollOutboxMessages(
  stateLoader: StateLoader,
  channel: string,
  max: number,
  leaseSeconds: number,
  maxAttempts: number,
  topicKey?: string,
): Promise<OutboxPollResult[]> {
  const now = Date.now();

  return stateLoader.transaction(async () => {
    const results: OutboxPollResult[] = [];

    // Find eligible messages: pending OR expired leases
    // First get pending messages
    const pendingWhere: Record<string, unknown> = {
      channel,
      status: "pending",
      next_attempt_at: { op: "lte", value: now },
    };
    if (topicKey) {
      pendingWhere.topic_key = topicKey;
    }

    const pending = stateLoader.find(OutboxMessage, {
      where: pendingWhere,
      orderBy: { next_attempt_at: "asc" },
      limit: max,
    });

    // Get expired leased messages
    const leasedWhere: Record<string, unknown> = {
      channel,
      status: "leased",
      lease_expires_at: { op: "lte", value: now },
    };
    if (topicKey) {
      leasedWhere.topic_key = topicKey;
    }

    const expiredLeased = stateLoader.find(OutboxMessage, {
      where: leasedWhere,
      orderBy: { next_attempt_at: "asc" },
      limit: max,
    });

    // Combine and sort by next_attempt_at, then id
    const eligible = [...pending, ...expiredLeased];
    eligible.sort((a, b) => {
      if (a.next_attempt_at !== b.next_attempt_at) {
        return a.next_attempt_at - b.next_attempt_at;
      }
      return a.id.localeCompare(b.id);
    });

    // Process up to max messages
    const toProcess = eligible.slice(0, max);

    for (const message of toProcess) {
      const newAttempts = message.attempts + 1;

      if (newAttempts > maxAttempts) {
        // Dead-letter the message
        message.status = "dead";
        message.attempts = newAttempts;
        message.last_error = "max attempts exceeded";
        await message.save();
        continue;
      }

      // Lease the message
      const leaseToken = `lease_${crypto.randomUUID()}`;
      const leaseExpiresAt = now + leaseSeconds * 1000;
      const nextAttemptAt = now + computeBackoffDelay(newAttempts);

      message.status = "leased";
      message.attempts = newAttempts;
      message.lease_token = leaseToken;
      message.lease_expires_at = leaseExpiresAt;
      message.next_attempt_at = nextAttemptAt;
      await message.save();

      results.push({
        messageId: message.id,
        leaseToken,
        topicKey: message.topic_key,
        text: message.text,
        payload: message.payload_json
          ? (JSON.parse(message.payload_json) as Record<string, unknown>)
          : null,
      });
    }

    return results;
  });
}

/**
 * Acknowledge successful delivery of an outbox message.
 *
 * Requires matching messageId + leaseToken with an active (non-expired) lease.
 * Idempotent: re-acking an already-delivered message with the same token returns
 * "already_delivered".
 */
export async function ackOutboxMessage(
  stateLoader: StateLoader,
  messageId: string,
  leaseToken: string,
): Promise<AckResult> {
  const now = Date.now();

  return stateLoader.transaction(async () => {
    const message = stateLoader.get(OutboxMessage, messageId);
    if (!message) {
      return "not_found" as const;
    }

    // Idempotent: already delivered with same token
    if (message.status === "delivered" && message.lease_token === leaseToken) {
      return "already_delivered" as const;
    }

    // Must be leased with matching token and active lease
    if (
      message.status !== "leased" ||
      message.lease_token !== leaseToken ||
      !message.lease_expires_at ||
      message.lease_expires_at <= now
    ) {
      return "lease_conflict" as const;
    }

    message.status = "delivered";
    await message.save();
    return "delivered" as const;
  });
}

/**
 * List recent outbox messages, most recent first.
 */
export function listOutboxMessages(
  stateLoader: StateLoader,
  limit = 20,
): OutboxMessage[] {
  return stateLoader.find(OutboxMessage, {
    orderBy: { created_at_ms: "desc" },
    limit,
  });
}
