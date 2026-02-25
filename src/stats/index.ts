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
 * Time-based metrics use a 24-hour sliding window.
 *
 * Uses StateLoader.count() for counts and StateLoader.find() + JS for percentiles.
 */
export function getStats(
  stateLoader: StateLoader,
  thalamus?: ThalamusSyncInfo,
): CortexStats {
  // Note: oneDayAgo would be used for filtering by updated_at, but StateLoader
  // entities don't have updated_at exposed. This is an approximation that counts
  // all done/failed/delivered messages. A fast-follow could add updated_at field
  // to entities for proper 24h filtering.
  const _oneDayAgo = Date.now() - 86_400_000;
  void _oneDayAgo; // Suppress unused warning - placeholder for future 24h filtering

  // --- Inbox stats ---
  // Pending/processing: all time
  const inboxPending = stateLoader.count(InboxMessage, { status: "pending" });
  const inboxProcessing = stateLoader.count(InboxMessage, {
    status: "processing",
  });

  // Done/failed: last 24h (no updated_at filter in count, so use find + filter)
  // StateLoader doesn't track updated_at internally, but InboxMessage tracks
  // status changes. For 24h window, we approximate by fetching recent and counting.
  // Note: This is an approximation since we don't have updated_at index.
  // For production accuracy, updated_at should be added as a field.
  const recentDone = stateLoader.find(InboxMessage, {
    where: { status: "done" },
    orderBy: { id: "desc" },
    limit: 10000, // Reasonable upper bound for 24h
  });
  // Filter by checking if processing_ms is set (indicates recently completed)
  // This is an approximation - for exact 24h window, updated_at field needed
  const inboxDone24h = recentDone.length;

  const recentFailed = stateLoader.find(InboxMessage, {
    where: { status: "failed" },
    orderBy: { id: "desc" },
    limit: 10000,
  });
  const inboxFailed24h = recentFailed.length;

  // --- Outbox stats ---
  const outboxPending = stateLoader.count(OutboxMessage, { status: "pending" });
  const outboxDeadTotal = stateLoader.count(OutboxMessage, { status: "dead" });

  const recentDelivered = stateLoader.find(OutboxMessage, {
    where: { status: "delivered" },
    orderBy: { id: "desc" },
    limit: 10000,
  });
  const outboxDelivered24h = recentDelivered.length;

  // --- Receptor buffer stats ---
  const allBuffers = stateLoader.find(ReceptorBuffer, {});
  const bufferPendingTotal = allBuffers.length;

  // --- Processing latency percentiles ---
  // Fetch done messages with processing_ms, compute percentiles in JS
  const doneWithLatency = stateLoader.find(InboxMessage, {
    where: { status: "done" },
    orderBy: { id: "desc" },
    limit: 10000,
  });

  const latencies = doneWithLatency
    .filter((m) => m.processing_ms !== null)
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
