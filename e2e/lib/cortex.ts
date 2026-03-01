/**
 * Cortex API helpers for E2E tests.
 */

import { getConfig } from "./config";
import { openCortexDb, query, queryOne } from "./db";

// --- Buffer insertion ---

export interface InsertBufferOptions {
  channel: string;
  externalId: string;
  content: string;
  metadata?: Record<string, unknown>;
  occurredAt?: string;
}

export async function insertBuffer(opts: InsertBufferOptions): Promise<string> {
  const config = await getConfig();
  const occurredAt = opts.occurredAt ?? new Date().toISOString();

  const response = await fetch(`${config.cortex.url}/receive`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.cortex.apiKey}`,
    },
    body: JSON.stringify({
      channel: opts.channel,
      externalId: opts.externalId,
      data: opts.content,
      occurredAt,
      metadata: opts.metadata,
      mode: "buffered",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to insert buffer: ${response.status} ${text}`);
  }

  const result = (await response.json()) as { eventId: string };
  return result.eventId;
}

// --- Trigger sync ---

export interface SyncResult {
  ok: boolean;
  processed?: number;
  error?: string;
}

export async function triggerSync(channel?: string): Promise<SyncResult> {
  const config = await getConfig();
  const url = channel
    ? `${config.cortex.url}/thalamus/sync?channel=${channel}`
    : `${config.cortex.url}/thalamus/sync`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.cortex.apiKey}`,
    },
  });

  return (await response.json()) as SyncResult;
}

// --- Send message (realtime) ---

export interface SendMessageOptions {
  text: string;
  topicKey?: string;
  channel?: string;
  metadata?: Record<string, unknown>;
}

export async function sendMessage(opts: SendMessageOptions): Promise<string> {
  const config = await getConfig();
  const channel = opts.channel ?? "cli";
  const topicKey = opts.topicKey ?? `test-${Date.now()}`;

  const response = await fetch(`${config.cortex.url}/receive`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.cortex.apiKey}`,
    },
    body: JSON.stringify({
      channel,
      externalId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      data: { text: opts.text, topicKey: topicKey },
      occurredAt: new Date().toISOString(),
      metadata: opts.metadata,
      mode: "realtime",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to send message: ${response.status} ${text}`);
  }

  const result = (await response.json()) as { eventId: string };
  return result.eventId;
}

// --- Approval handling ---

export interface Approval {
  id: string;
  topic_key: string;
  action: string;
  status: string;
}

export async function getPendingApproval(topicKey: string): Promise<Approval | null> {
  const db = await openCortexDb();
  return queryOne<Approval>(
    db,
    `SELECT id, topic_key, action, status FROM pending_approvals 
     WHERE topic_key = $topicKey AND status = 'pending' 
     ORDER BY proposed_at DESC LIMIT 1`,
    { $topicKey: topicKey }
  );
}

export async function respondToApproval(
  approvalId: string,
  action: "approve" | "reject",
  topicKey: string
): Promise<string> {
  const config = await getConfig();

  const response = await fetch(`${config.cortex.url}/receive`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.cortex.apiKey}`,
    },
    body: JSON.stringify({
      channel: "cli",
      externalId: `approval-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      data: { text: action, topicKey: topicKey },
      occurredAt: new Date().toISOString(),
      metadata: {
        type: "approval_response",
        approvalId,
        action,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to respond to approval: ${response.status} ${text}`);
  }

  const result = (await response.json()) as { eventId: string };
  return result.eventId;
}


