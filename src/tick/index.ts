import { createLogger } from "@shetty4l/core/log";
import type { StateLoader } from "@shetty4l/core/state";
import type { CortexConfig } from "../config";
import { type EnqueueInboxInput, type EnqueueResult } from "../inbox";
import {
  getPendingScheduledEvents,
  markScheduledEventFired,
  type ScheduledEvent,
} from "../scheduled-events";
import { getOverdueTasks, getTasksDueSoon, type Task } from "../tasks";
import { getTopic } from "../topics";

const log = createLogger("cortex");

/** 24 hours in milliseconds */
const TWENTY_FOUR_HOURS_MS = 86_400_000;

export interface TickDeps {
  config: Pick<CortexConfig, "schedulerTickSeconds">;
  enqueueInboxMessage: (input: EnqueueInboxInput) => EnqueueResult;
  stateLoader: StateLoader;
}

export interface FireResult {
  scheduledEventsFired: number;
  overdueWarningsCreated: number;
  dueSoonWarningsCreated: number;
}

/**
 * Generate a date key for idempotency (YYYY-MM-DD format in UTC).
 * Used to prevent duplicate inbox messages per task per day.
 *
 * Note: Uses UTC to ensure consistent behavior across timezones.
 * This means "one warning per UTC day" not "one warning per local day".
 */
function getDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toISOString().split("T")[0];
}

/**
 * Generate an idempotency key for tick-generated inbox messages.
 * Format: tick:{eventType}:{referenceId}:{dateKey}
 */
function makeIdempotencyKey(
  eventType: string,
  referenceId: string,
  dateKey: string,
): string {
  return `tick:${eventType}:${referenceId}:${dateKey}`;
}

export class Tick {
  private deps: TickDeps | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private firing = false;
  private stopping = false;

  /**
   * Initialize Tick with dependencies.
   * Must be called before fire() can be used.
   */
  init(deps: TickDeps): void {
    this.deps = deps;
  }

  /**
   * Start the tick scheduler.
   * Fires at the configured interval (schedulerTickSeconds).
   */
  async start(): Promise<void> {
    if (!this.deps) {
      log("tick start skipped — not initialized");
      return;
    }

    if (this.intervalId !== null) {
      log("tick already running");
      return;
    }

    const intervalMs = this.deps.config.schedulerTickSeconds * 1000;
    this.stopping = false;

    // Fire immediately on start, then at intervals
    this.fire().catch((e) => log(`tick fire error: ${e}`));

    this.intervalId = setInterval(() => {
      if (this.stopping) return;
      this.fire().catch((e) => log(`tick fire error: ${e}`));
    }, intervalMs);

    log(`tick started (interval: ${this.deps.config.schedulerTickSeconds}s)`);
  }

  /**
   * Stop the tick scheduler.
   * Waits for any in-progress fire() to complete before returning.
   */
  async stop(): Promise<void> {
    if (this.intervalId === null) {
      log("tick not running");
      return;
    }

    this.stopping = true;
    clearInterval(this.intervalId);
    this.intervalId = null;

    // Wait for any in-progress fire() to complete
    while (this.firing) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    log("tick stopped");
  }

  /**
   * Fire the tick scheduler.
   *
   * Processes:
   * 1. Pending scheduled events that are due
   * 2. Overdue tasks (past due date)
   * 3. Tasks due soon (within 24 hours)
   *
   * Creates high-priority inbox messages for each, with idempotency keys
   * to prevent duplicates across multiple fire() cycles.
   */
  async fire(): Promise<FireResult> {
    if (!this.deps) {
      log("tick fire skipped — not initialized");
      return {
        scheduledEventsFired: 0,
        overdueWarningsCreated: 0,
        dueSoonWarningsCreated: 0,
      };
    }

    // Don't start a new fire if we're stopping
    if (this.stopping) {
      return {
        scheduledEventsFired: 0,
        overdueWarningsCreated: 0,
        dueSoonWarningsCreated: 0,
      };
    }

    this.firing = true;
    try {
      return await this.doFire();
    } finally {
      this.firing = false;
    }
  }

  /**
   * Internal implementation of fire() logic.
   */
  private async doFire(): Promise<FireResult> {
    const now = Date.now();
    const dateKey = getDateKey(now);
    const result: FireResult = {
      scheduledEventsFired: 0,
      overdueWarningsCreated: 0,
      dueSoonWarningsCreated: 0,
    };

    // 1. Process pending scheduled events
    const pendingEvents = getPendingScheduledEvents(
      this.deps!.stateLoader,
      now,
    );
    for (const event of pendingEvents) {
      await this.processScheduledEvent(event, dateKey);
      result.scheduledEventsFired++;
    }

    // 2. Process overdue tasks
    const overdueTasks = getOverdueTasks(this.deps!.stateLoader);
    for (const task of overdueTasks) {
      const created = this.createTaskWarning(task, "overdue", dateKey);
      if (created) {
        result.overdueWarningsCreated++;
      }
    }

    // 3. Process tasks due soon (within 24 hours)
    const dueSoonTasks = getTasksDueSoon(
      this.deps!.stateLoader,
      TWENTY_FOUR_HOURS_MS,
    );
    for (const task of dueSoonTasks) {
      const created = this.createTaskWarning(task, "due_soon", dateKey);
      if (created) {
        result.dueSoonWarningsCreated++;
      }
    }

    if (
      result.scheduledEventsFired > 0 ||
      result.overdueWarningsCreated > 0 ||
      result.dueSoonWarningsCreated > 0
    ) {
      log(
        `tick fired: ${result.scheduledEventsFired} events, ${result.overdueWarningsCreated} overdue, ${result.dueSoonWarningsCreated} due soon`,
      );
    }

    return result;
  }

  /**
   * Process a scheduled event: create inbox message and mark as fired.
   */
  private async processScheduledEvent(
    event: ScheduledEvent,
    dateKey: string,
  ): Promise<void> {
    if (!this.deps) return;

    const idempotencyKey = makeIdempotencyKey(
      event.event_type,
      event.reference_id ?? event.id,
      dateKey,
    );

    // Create inbox message for the scheduled event
    this.deps.enqueueInboxMessage({
      channel: "tick",
      externalMessageId: `sched_${event.id}_${dateKey}`,
      topicKey: event.reference_id ?? "system",
      userId: "system",
      text: `Scheduled event fired: ${event.event_type}`,
      occurredAt: Date.now(),
      idempotencyKey,
      metadata: {
        eventType: event.event_type,
        referenceId: event.reference_id,
        scheduledEventId: event.id,
      },
      priority: 0, // High priority
    });

    // Mark the event as fired
    await markScheduledEventFired(this.deps!.stateLoader, event.id);
  }

  /**
   * Create a task deadline warning inbox message.
   * Returns true if a new message was created, false if it was a duplicate.
   */
  private createTaskWarning(
    task: Task,
    warningType: "overdue" | "due_soon",
    dateKey: string,
  ): boolean {
    if (!this.deps) return false;

    const idempotencyKey = makeIdempotencyKey(warningType, task.id, dateKey);

    const warningText =
      warningType === "overdue"
        ? `Task overdue: ${task.title}`
        : `Task due soon: ${task.title}`;

    // Look up topic to get its key (fallback to topic_id if not found or no key)
    const topic = getTopic(this.deps.stateLoader, task.topic_id);
    const topicKey = topic?.key ?? task.topic_id;

    const result = this.deps.enqueueInboxMessage({
      channel: "tick",
      externalMessageId: `${warningType}_${task.id}_${dateKey}`,
      topicKey,
      userId: "system",
      text: warningText,
      occurredAt: Date.now(),
      idempotencyKey,
      metadata: {
        warningType,
        taskId: task.id,
        taskTitle: task.title,
        dueAt: task.due_at,
      },
      priority: 0, // High priority
    });

    return !result.duplicate;
  }
}
