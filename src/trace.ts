/**
 * Trace context for pipeline debugging.
 *
 * Uses AsyncLocalStorage to propagate a trace ID through async operations.
 * Each message processed gets an 8-char UUID prefix for correlation.
 *
 * Usage:
 *   runWithTraceId(id, async () => { ... })
 *   getTraceId() // returns current trace ID or undefined
 */

import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";

// --- Storage ---

interface TraceContext {
  traceId: string;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

// --- API ---

/**
 * Generate a new trace ID (8-char UUID prefix).
 */
export function generateTraceId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Run a function within a trace context.
 *
 * The trace ID is available via getTraceId() throughout the async execution.
 */
export function runWithTraceId<T>(traceId: string, fn: () => T): T {
  return traceStorage.run({ traceId }, fn);
}

/**
 * Get the current trace ID, if in a trace context.
 */
export function getTraceId(): string | undefined {
  return traceStorage.getStore()?.traceId;
}
