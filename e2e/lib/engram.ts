/**
 * Engram API helpers for E2E tests.
 *
 * Provides functions to interact with the Engram memory service
 * for storing, recalling, and deleting memories.
 */

import { getConfig } from "./config";
import type { RecallMemory } from "./types";

// --- Remember (store memory) ---

export interface RememberOptions {
  content: string;
  category?: "decision" | "pattern" | "fact" | "preference" | "insight";
  scopeId?: string;
  idempotencyKey?: string;
  upsert?: boolean;
}

export interface RememberResult {
  id: string;
  created: boolean;
}

export async function remember(opts: RememberOptions): Promise<RememberResult> {
  const config = await getConfig();

  const response = await fetch(`${config.engramUrl}/remember`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: opts.content,
      category: opts.category,
      scope_id: opts.scopeId,
      idempotency_key: opts.idempotencyKey,
      upsert: opts.upsert,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to remember: ${response.status} ${text}`);
  }

  return (await response.json()) as RememberResult;
}

// --- Recall (retrieve memories) ---

export interface RecallOptions {
  query: string;
  scopeId?: string;
  limit?: number;
  category?: "decision" | "pattern" | "fact" | "preference" | "insight";
}

export interface RecallResult {
  memories: RecallMemory[];
}

export async function recall(opts: RecallOptions): Promise<RecallResult> {
  const config = await getConfig();

  const response = await fetch(`${config.engramUrl}/recall`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: opts.query,
      scope_id: opts.scopeId,
      limit: opts.limit,
      category: opts.category,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to recall: ${response.status} ${text}`);
  }

  return (await response.json()) as RecallResult;
}

// --- Forget (delete memory) ---

export interface ForgetOptions {
  id: string;
}

export async function forget(opts: ForgetOptions): Promise<void> {
  const config = await getConfig();

  const response = await fetch(`${config.engramUrl}/forget`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: opts.id,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to forget: ${response.status} ${text}`);
  }
}
