/**
 * Scheduled event management using StateLoader collection persistence.
 *
 * Scheduled events are time-based triggers that fire at specified timestamps,
 * generating inbox messages when due.
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
 * ScheduledEvent entity persisted to SQLite via StateLoader.
 *
 * Uses @PersistedCollection for multi-row table storage with explicit save().
 * Note: created_at and updated_at are auto-managed by StateLoader at the DB level
 * but not exposed on the entity class.
 */
@PersistedCollection("scheduled_events")
export class ScheduledEvent extends CollectionEntity {
  @Id() id: string = "";
  @Field("string") @Index() event_type: string = "";
  @Field("string") reference_id: string | null = null;
  @Field("number") @Index() fires_at: number = 0;
  @Field("number") fired_at: number | null = null;
  @Field("string") @Index() status: "pending" | "fired" | "cancelled" =
    "pending";

  async save(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }

  async delete(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }
}

export interface CreateScheduledEventInput {
  eventType: string;
  referenceId?: string | null;
  firesAt: number;
}

/**
 * Create a new scheduled event.
 * Returns the created event with generated id.
 */
export function createScheduledEvent(
  stateLoader: StateLoader,
  input: CreateScheduledEventInput,
): ScheduledEvent {
  return stateLoader.create(ScheduledEvent, {
    id: `sched_${crypto.randomUUID()}`,
    event_type: input.eventType,
    reference_id: input.referenceId ?? null,
    fires_at: input.firesAt,
    fired_at: null,
    status: "pending",
  });
}

/**
 * Get pending scheduled events that are due before the given timestamp.
 * Returns array of events ordered by fires_at ASC.
 */
export function getPendingScheduledEvents(
  stateLoader: StateLoader,
  beforeTimestamp: number,
): ScheduledEvent[] {
  return stateLoader.find(ScheduledEvent, {
    where: {
      status: "pending",
      fires_at: { op: "lte", value: beforeTimestamp },
    },
    orderBy: { fires_at: "asc" },
  });
}

/**
 * Mark a scheduled event as fired.
 * Sets status='fired' and fired_at=now atomically.
 */
export async function markScheduledEventFired(
  stateLoader: StateLoader,
  id: string,
): Promise<void> {
  const event = stateLoader.get(ScheduledEvent, id);
  if (!event) return;

  event.status = "fired";
  event.fired_at = Date.now();
  await event.save();
}
