/**
 * Pending approval management using StateLoader collection persistence.
 *
 * Pending approvals track tool invocations that require user approval
 * before execution. Each approval has a status lifecycle:
 * pending -> approved | rejected | expired
 */

import {
  CollectionEntity,
  CollectionField as Field,
  Id,
  Index,
  PersistedCollection,
  type StateLoader,
} from "@shetty4l/core/state";

/** Valid status values for pending approvals. */
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

/**
 * PendingApproval entity persisted to SQLite via StateLoader.
 *
 * Uses @PersistedCollection for multi-row table storage with explicit save().
 */
@PersistedCollection("pending_approvals")
export class PendingApproval extends CollectionEntity {
  @Id() id: string = "";
  @Field("string") @Index() topic_key: string = "";
  @Field("string") action: string = "";
  @Field("string") tool_name: string | null = null;
  @Field("string") tool_args_json: string | null = null;
  @Field("string") @Index() status: ApprovalStatus = "pending";
  @Field("number") proposed_at: number = 0;
  @Field("number") resolved_at: number | null = null;

  async save(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }

  async delete(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }
}

// --- Input types ---

export interface ProposeApprovalInput {
  topicKey: string;
  action: string;
  toolName?: string;
  toolArgsJson?: string;
}

// --- Approval operations ---

/**
 * Create a new pending approval.
 */
export function proposeApproval(
  stateLoader: StateLoader,
  input: ProposeApprovalInput,
): PendingApproval {
  return stateLoader.create(PendingApproval, {
    id: crypto.randomUUID(),
    topic_key: input.topicKey,
    action: input.action,
    tool_name: input.toolName ?? null,
    tool_args_json: input.toolArgsJson ?? null,
    status: "pending",
    proposed_at: Date.now(),
    resolved_at: null,
  });
}

/**
 * Get a pending approval by ID.
 */
export function getApproval(
  stateLoader: StateLoader,
  id: string,
): PendingApproval | null {
  return stateLoader.get(PendingApproval, id);
}

/**
 * Resolve a pending approval by setting its status.
 *
 * Updates status and sets resolved_at timestamp.
 */
export async function resolveApproval(
  stateLoader: StateLoader,
  id: string,
  resolution: "approved" | "rejected" | "expired",
): Promise<void> {
  const approval = stateLoader.get(PendingApproval, id);
  if (!approval) return;

  approval.status = resolution;
  approval.resolved_at = Date.now();
  await approval.save();
}

/**
 * List pending approvals (status = 'pending').
 *
 * Optionally filter by topic key. Results ordered by proposed_at DESC.
 */
export function listPendingApprovals(
  stateLoader: StateLoader,
  topicKey?: string,
): PendingApproval[] {
  const where: Record<string, unknown> = { status: "pending" };
  if (topicKey) {
    where.topic_key = topicKey;
  }

  return stateLoader.find(PendingApproval, {
    where,
    orderBy: { proposed_at: "desc" },
  });
}

/**
 * List all approvals, optionally filtered by topic key and/or status.
 */
export function listApprovals(
  stateLoader: StateLoader,
  opts?: {
    topicKey?: string;
    status?: ApprovalStatus;
  },
): PendingApproval[] {
  const where: Record<string, unknown> = {};
  if (opts?.topicKey) {
    where.topic_key = opts.topicKey;
  }
  if (opts?.status) {
    where.status = opts.status;
  }

  return stateLoader.find(PendingApproval, {
    where: Object.keys(where).length > 0 ? where : undefined,
    orderBy: { proposed_at: "desc" },
  });
}
