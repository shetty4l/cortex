/**
 * Thin Engram client for Cortex.
 *
 * Recalls memories via Engram's POST /recall endpoint.
 * Stores memories via Engram's POST /remember endpoint.
 * Supports dual recall: topic-scoped + global, deduplicated, with backfill.
 *
 * Design:
 * - 3s timeout per request (memory ops should not block message processing)
 * - On failure: returns empty/null and logs a warning (graceful degradation)
 * - No auth required (Engram runs on localhost)
 */

import type { Result } from "@shetty4l/core/result";
import { err, ok } from "@shetty4l/core/result";

// --- Types ---

export interface Memory {
  id: string;
  content: string;
  category: string | null;
  strength: number;
  relevance: number;
}

interface RecallResponse {
  memories: Memory[];
  fallback_mode: boolean;
}

export interface RecallOptions {
  limit?: number;
  scopeId?: string;
}

// --- Constants ---

const RECALL_TIMEOUT_MS = 3_000;

/** Timeout for remember requests. */
const REMEMBER_TIMEOUT_MS = 3_000;

/** Maximum total memories from dual recall. */
const DUAL_RECALL_MAX = 8;

/** Per-call limit for dual recall (topic + global). */
const DUAL_RECALL_PER_CALL = 4;

// --- Remember ---

export interface RememberInput {
  content: string;
  category?: string;
  scopeId?: string;
  idempotencyKey?: string;
  upsert?: boolean;
}

export interface RememberOutput {
  id: string;
  status: "created" | "updated";
}

/**
 * Store a memory in Engram via POST /remember.
 *
 * Returns Ok(output) on success, Ok(null) on timeout/connection/HTTP failure.
 * Returns Err only on unexpected parse failures.
 *
 * Graceful: never throws, never blocks the caller on infrastructure failure.
 */
export async function remember(
  input: RememberInput,
  engramUrl: string,
): Promise<Result<RememberOutput | null>> {
  const body: Record<string, unknown> = { content: input.content };
  if (input.category !== undefined) body.category = input.category;
  if (input.scopeId !== undefined) body.scope_id = input.scopeId;
  if (input.idempotencyKey !== undefined)
    body.idempotency_key = input.idempotencyKey;
  if (input.upsert !== undefined) body.upsert = input.upsert;

  let response: Response;
  try {
    response = await fetch(`${engramUrl}/remember`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REMEMBER_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      console.error(
        `cortex: Engram remember timed out after ${REMEMBER_TIMEOUT_MS}ms`,
      );
      return ok(null);
    }
    console.error(
      `cortex: Engram connection failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return ok(null);
  }

  if (!response.ok) {
    let text: string;
    try {
      text = await response.text();
    } catch {
      text = "(unreadable)";
    }
    console.error(
      `cortex: Engram remember returned ${response.status}: ${text.slice(0, 500)}`,
    );
    return ok(null);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return err("Engram remember returned invalid JSON");
  }

  const output = data as { id?: string; status?: string };
  if (!output.id || !output.status) {
    return err("Engram remember response missing id or status");
  }

  return ok({ id: output.id, status: output.status as "created" | "updated" });
}

// --- Recall ---

/**
 * Recall memories from Engram via POST /recall.
 *
 * Returns Ok([]) on timeout or connection failure (logs warning).
 * Returns Err only on unexpected parse failures.
 */
export async function recall(
  query: string,
  engramUrl: string,
  options?: RecallOptions,
): Promise<Result<Memory[]>> {
  const body: Record<string, unknown> = { query };
  if (options?.limit !== undefined) body.limit = options.limit;
  if (options?.scopeId !== undefined) body.scope_id = options.scopeId;

  let response: Response;
  try {
    response = await fetch(`${engramUrl}/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RECALL_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      console.error(
        `cortex: Engram recall timed out after ${RECALL_TIMEOUT_MS}ms`,
      );
      return ok([]);
    }
    console.error(
      `cortex: Engram connection failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return ok([]);
  }

  if (!response.ok) {
    let body: string;
    try {
      body = await response.text();
    } catch {
      body = "(unreadable)";
    }
    console.error(
      `cortex: Engram recall returned ${response.status}: ${body.slice(0, 500)}`,
    );
    return ok([]);
  }

  let data: RecallResponse;
  try {
    data = (await response.json()) as RecallResponse;
  } catch {
    return err("Engram recall returned invalid JSON");
  }

  if (!Array.isArray(data.memories)) {
    return err("Engram recall response missing memories array");
  }

  return ok(data.memories);
}

// --- Dual recall ---

/**
 * Recall memories from both topic scope and global scope, deduplicated.
 *
 * Makes two parallel calls:
 * 1. Topic-scoped: scope_id = topicKey, limit = 4
 * 2. Global: no scope_id, limit = 4
 *
 * Deduplicates by memory ID (topic takes precedence).
 * Backfills from global if topic returned fewer than 4, up to 8 total.
 *
 * On any failure, returns whatever memories were successfully recalled.
 */
export async function recallDual(
  query: string,
  topicKey: string,
  engramUrl: string,
): Promise<Memory[]> {
  const [topicResult, globalResult] = await Promise.all([
    recall(query, engramUrl, {
      limit: DUAL_RECALL_PER_CALL,
      scopeId: topicKey,
    }),
    recall(query, engramUrl, { limit: DUAL_RECALL_PER_CALL }),
  ]);

  const topicMemories = topicResult.ok ? topicResult.value : [];
  const globalMemories = globalResult.ok ? globalResult.value : [];

  // Start with all topic memories
  const seen = new Set(topicMemories.map((m) => m.id));
  const merged: Memory[] = [...topicMemories];

  // Backfill from global (skip duplicates) up to max
  for (const mem of globalMemories) {
    if (merged.length >= DUAL_RECALL_MAX) break;
    if (seen.has(mem.id)) continue;
    seen.add(mem.id);
    merged.push(mem);
  }

  return merged;
}
