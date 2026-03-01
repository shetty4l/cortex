/**
 * Cerebellum - Message routing and scheduling subsystem.
 *
 * Sits between the inbox/processing pipeline and the outbox, controlling
 * when and how messages are delivered based on their type, urgency, and
 * scheduling constraints.
 *
 * Current implementation: Fast path only (pending -> ready pass-through).
 * Future: Quiet hours, LLM slow path, scheduled delivery.
 */

import { createLogger } from "@shetty4l/core/log";
import type { StateLoader } from "@shetty4l/core/state";
import { OutboxMessage } from "../outbox";
import type { CerebellumConfig } from "./types";

const log = createLogger("cortex");

// --- Stats ---

export interface CerebellumStats {
  /** Total messages routed since start */
  messagesRouted: number;
  /** Messages routed in the last polling cycle */
  lastCycleRouted: number;
  /** Timestamp of last routing cycle (epoch ms) */
  lastRoutedAt: number | null;
  /** Whether the polling loop is currently running */
  isRunning: boolean;
}

// --- Cerebellum ---

export class Cerebellum {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stats: CerebellumStats = {
    messagesRouted: 0,
    lastCycleRouted: 0,
    lastRoutedAt: null,
    isRunning: false,
  };

  constructor(
    private config: CerebellumConfig,
    private stateLoader: StateLoader,
  ) {}

  /**
   * Start the Cerebellum polling loop.
   * Polls for pending messages and routes them at the configured interval.
   */
  start(): void {
    if (this.pollTimer) {
      log("cerebellum already running");
      return;
    }

    this.stats.isRunning = true;
    log(`cerebellum started (poll interval: ${this.config.pollIntervalMs}ms)`);

    // Immediate routing on startup
    void this.routePending();

    this.pollTimer = setInterval(
      () => void this.routePending(),
      this.config.pollIntervalMs,
    );
  }

  /**
   * Stop the Cerebellum polling loop.
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.stats.isRunning = false;
    log("cerebellum stopped");
  }

  /**
   * Route pending messages to ready status.
   *
   * Fast path implementation: immediately sets status=ready for all pending messages.
   * Future: Apply quiet hours, scheduling, and LLM slow path routing.
   *
   * @returns Number of messages routed in this cycle
   */
  async routePending(): Promise<number> {
    try {
      // Find all pending messages
      const pendingMessages = this.stateLoader.find(OutboxMessage, {
        where: { status: "pending" },
        orderBy: { created_at_ms: "asc" },
      });

      if (pendingMessages.length === 0) {
        this.stats.lastCycleRouted = 0;
        return 0;
      }

      // Fast path: mark all pending as ready
      let routed = 0;
      for (const message of pendingMessages) {
        message.status = "ready";
        await message.save();
        routed++;

        log(
          `cerebellum routed message ${message.id} (type=${message.message_type}, urgency=${message.urgency})`,
        );
      }

      // Update stats
      this.stats.messagesRouted += routed;
      this.stats.lastCycleRouted = routed;
      this.stats.lastRoutedAt = Date.now();

      if (routed > 0) {
        log(`cerebellum routed ${routed} message(s) to ready`);
      }

      return routed;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log(`cerebellum routePending error: ${error}`);
      return 0;
    }
  }

  /**
   * Get current Cerebellum statistics.
   */
  getStats(): CerebellumStats {
    return { ...this.stats };
  }
}

// Re-export types for convenience
export type { CerebellumConfig } from "./types";
export { CEREBELLUM_DEFAULTS, type MessageType } from "./types";
