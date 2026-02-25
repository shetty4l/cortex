/**
 * Statistics module for Cortex.
 *
 * Provides aggregated stats for the /stats API endpoint using StateLoader
 * for all queries. No raw SQL.
 */

import type { StateLoader } from "@shetty4l/core/state";
import { InboxMessage } from "../inbox";
import { OutboxMessage } from "../outbox";
import { ReceptorBuffer } from "../receptor-buffers";

// --- Types ---

export interface CortexStats {
  inbox: {
    pending: number;
    processing: number;
    done_24h: number;
    failed_24h: number;
  };
  outbox: {
    pending: number;
    delivered_24h: number;
    dead_total: number;
  };
  receptors: {
    thalamus_last_run_at: number | null;
    buffer_pending_total: number;
  };
  processing: {
    p50_ms: number | null;
    p95_ms: number | null;
    p99_ms: number | null;
  };
}

/** Minimal interface for thalamus dependency in getStats(). */
export interface ThalamusSyncInfo {
  getLastSyncAt(): number | null;
}

// --- Helpers ---

/**
 * Compute percentile from a sorted array.
 * Returns 0 for empty arrays.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// --- Stats operations ---

/**
 * Get aggregated stats for the /stats API endpoint.
 *
 * Returns inbox/outbox counts, receptor sync timestamps, and processing latency percentiles.
 * Time-based metrics use a 24-hour sliding window based on message timestamps.
 *
 * Uses StateLoader.count() for counts and StateLoader.find() + JS for percentiles.
 */
export function getStats(
  stateLoader: StateLoader,
  thalamus?: ThalamusSyncInfo,
): CortexStats {
  const oneDayAgoMs = Date.now() - 86_400_000;

  // --- Inbox stats ---
  // Pending/processing: all time
  const inboxPending = stateLoader.count(InboxMessage, { status: "pending" });
  const inboxProcessing = stateLoader.count(InboxMessage, {
    status: "processing",
  });

  // Done/failed: last 24h using occurred_at filter
  const inboxDone24h = stateLoader
    .find(InboxMessage, {
      where: { status: "done" },
    })
    .filter((m) => m.occurred_at >= oneDayAgoMs).length;

  const inboxFailed24h = stateLoader
    .find(InboxMessage, {
      where: { status: "failed" },
    })
    .filter((m) => m.occurred_at >= oneDayAgoMs).length;

  // --- Outbox stats ---
  const outboxPending = stateLoader.count(OutboxMessage, { status: "pending" });
  const outboxDeadTotal = stateLoader.count(OutboxMessage, { status: "dead" });

  const outboxDelivered24h = stateLoader
    .find(OutboxMessage, {
      where: { status: "delivered" },
    })
    .filter((m) => m.created_at_ms >= oneDayAgoMs).length;

  // --- Receptor buffer stats ---
  const bufferPendingTotal = stateLoader.count(ReceptorBuffer, {});

  // --- Processing latency percentiles ---
  // Fetch done messages with processing_ms from last 24h, compute percentiles in JS
  const doneWithLatency = stateLoader
    .find(InboxMessage, {
      where: { status: "done" },
    })
    .filter((m) => m.occurred_at >= oneDayAgoMs && m.processing_ms !== null);

  const latencies = doneWithLatency
    .map((m) => m.processing_ms as number)
    .sort((a, b) => a - b);

  const hasLatency = latencies.length > 0;

  return {
    inbox: {
      pending: inboxPending,
      processing: inboxProcessing,
      done_24h: inboxDone24h,
      failed_24h: inboxFailed24h,
    },
    outbox: {
      pending: outboxPending,
      delivered_24h: outboxDelivered24h,
      dead_total: outboxDeadTotal,
    },
    receptors: {
      thalamus_last_run_at: thalamus?.getLastSyncAt() ?? null,
      buffer_pending_total: bufferPendingTotal,
    },
    processing: {
      p50_ms: hasLatency ? percentile(latencies, 50) : null,
      p95_ms: hasLatency ? percentile(latencies, 95) : null,
      p99_ms: hasLatency ? percentile(latencies, 99) : null,
    },
  };
}
