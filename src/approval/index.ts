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
  /** The inbox message ID that triggered this approval */
  inboxMessageId: string;
  toolName?: string;
  toolArgsJson?: string;
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
 *
 * Throws if the inbox message already has a pending approval (uniqueness constraint).
 */
export function proposeApproval(
  loader: StateLoader,
  input: ProposeApprovalInput,
): PendingApproval {
  // Uniqueness check: fail if message already has pending approval
  const existing = loader.find(PendingApproval, {
    where: { inboxMessageId: input.inboxMessageId, status: "pending" },
    limit: 1,
  });
  if (existing.length > 0) {
    throw new Error(
      `Message ${input.inboxMessageId} already has a pending approval: ${existing[0].id}`,
    );
  }

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
    inboxMessageId: input.inboxMessageId,
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
 * Get an approval by ID.
 * Returns null if not found.
 */
export function getApprovalById(
  loader: StateLoader,
  id: string,
): PendingApproval | null {
  return loader.get(PendingApproval, id);
}
