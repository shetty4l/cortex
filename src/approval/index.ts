/**
 * Approval functions using StateLoader for persistence.
 *
 * All functions are async and take StateLoader as the first parameter.
 * Uses PendingApproval entity from ./entity.ts for persistence.
 */

import type { StateLoader } from "@shetty4l/core/state";
import { PendingApproval } from "./entity";
import type { ApprovalStatus } from "./types";

export { PendingApproval } from "./entity";
export type { ApprovalStatus } from "./types";

/** Approval time-to-live: 15 minutes */
export const APPROVAL_TTL_MS = 15 * 60 * 1000;

export interface ProposeApprovalInput {
  topicKey: string;
  action: string;
  toolName?: string;
  toolArgsJson?: string;
  /** Serialized agent state (messages array) for resumption */
  agentStateJson?: string;
  /** Serialized tool calls blocked pending approval */
  toolCallsJson?: string;
}

/**
 * Check if an approval has expired based on its expiresAt timestamp.
 */
export function isExpired(
  approval: PendingApproval,
  now = Date.now(),
): boolean {
  return approval.expiresAt > 0 && now >= approval.expiresAt;
}

/**
 * Create a new pending approval request.
 */
export function proposeApproval(
  loader: StateLoader,
  input: ProposeApprovalInput,
): PendingApproval {
  const now = Date.now();
  return loader.create(PendingApproval, {
    id: crypto.randomUUID(),
    topicKey: input.topicKey,
    action: input.action,
    toolName: input.toolName ?? null,
    toolArgsJson: input.toolArgsJson ?? null,
    status: "pending" as ApprovalStatus,
    proposedAt: now,
    resolvedAt: null,
    agentStateJson: input.agentStateJson ?? null,
    toolCallsJson: input.toolCallsJson ?? null,
    expiresAt: now + APPROVAL_TTL_MS,
  });
}

/**
 * Resolve an approval (approve, reject, or expire).
 * Does NOT accept "consumed" - use consumeApproval() for that.
 */
export async function resolveApproval(
  loader: StateLoader,
  id: string,
  resolution: Exclude<ApprovalStatus, "pending" | "consumed">,
): Promise<void> {
  const approval = loader.get(PendingApproval, id);
  if (!approval) return;

  approval.status = resolution;
  approval.resolvedAt = Date.now();
  await approval.save();
}

/**
 * List pending approvals, optionally filtered by topicKey.
 * Returns approvals ordered by proposedAt descending (newest first).
 */
export function listPendingApprovals(
  loader: StateLoader,
  topicKey?: string,
): PendingApproval[] {
  if (topicKey) {
    return loader.find(PendingApproval, {
      where: { status: "pending", topicKey },
      orderBy: { proposedAt: "desc" },
    });
  }
  return loader.find(PendingApproval, {
    where: { status: "pending" },
    orderBy: { proposedAt: "desc" },
  });
}

/**
 * Get the most recent approved approval for a specific tool.
 * Returns null if no approved approval exists.
 */
export function getApprovalForTool(
  loader: StateLoader,
  topicKey: string,
  toolName: string,
): PendingApproval | null {
  const approvals = loader.find(PendingApproval, {
    where: { status: "approved", topicKey, toolName },
    orderBy: { proposedAt: "desc" },
    limit: 1,
  });
  return approvals.length > 0 ? approvals[0] : null;
}

/**
 * Mark an approved approval as consumed.
 * Logs a warning if the approval is not found or not in approved status.
 */
export async function consumeApproval(
  loader: StateLoader,
  id: string,
): Promise<void> {
  const approval = loader.get(PendingApproval, id);
  if (!approval) {
    console.warn(`consumeApproval: approval not found: ${id}`);
    return;
  }

  if (approval.status !== "approved") {
    console.warn(
      `consumeApproval: approval not in approved status: ${id} (status: ${approval.status})`,
    );
    return;
  }

  approval.status = "consumed";
  await approval.save();
}
