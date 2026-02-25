/**
 * Pending approval management using StateLoader collection persistence.
 *
 * Approvals gate execution of mutating tool calls. Each approval tracks:
 * - The topic context
 * - The action description
 * - Tool name and arguments (for matching on re-requests)
 * - Lifecycle status: pending → approved/rejected/expired → consumed
 */

import {
  CollectionEntity,
  CollectionField as Field,
  Id,
  Index,
  PersistedCollection,
  StateLoader,
} from "@shetty4l/core/state";
import { getDatabase } from "../db";

/**
 * PendingApproval entity persisted to SQLite via StateLoader.
 *
 * Uses @PersistedCollection for multi-row table storage with explicit save().
 * Note: created_at and updated_at are auto-managed by StateLoader.
 */
@PersistedCollection("pending_approvals")
export class PendingApproval extends CollectionEntity {
  @Id() id: string = "";
  @Field("string") @Index() topic_key: string = "";
  @Field("string") action: string = "";
  @Field("string") @Index() tool_name: string | null = null;
  @Field("string") tool_args_json: string | null = null;
  @Field("string") @Index() status: string = "pending";
  @Field("number") proposed_at: number = 0;
  @Field("number") resolved_at: number | null = null;

  async save(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }

  async delete(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }
}

export interface ProposeApprovalInput {
  topic_key: string;
  action: string;
  tool_name?: string;
  tool_args_json?: string;
}

/**
 * Get a StateLoader instance.
 * Uses provided loader or creates one from the database.
 */
function getLoader(stateLoader?: StateLoader): StateLoader {
  return stateLoader ?? new StateLoader(getDatabase());
}

/**
 * Create a new pending approval.
 */
export function proposeApproval(
  input: ProposeApprovalInput,
  stateLoader?: StateLoader,
): PendingApproval {
  const loader = getLoader(stateLoader);
  const now = Date.now();
  return loader.create(PendingApproval, {
    id: crypto.randomUUID(),
    topic_key: input.topic_key,
    action: input.action,
    tool_name: input.tool_name ?? null,
    tool_args_json: input.tool_args_json ?? null,
    status: "pending",
    proposed_at: now,
    resolved_at: null,
  });
}

/**
 * Resolve an approval (approve, reject, or expire).
 */
export async function resolveApproval(
  id: string,
  resolution: "approved" | "rejected" | "expired",
  stateLoader?: StateLoader,
): Promise<void> {
  const loader = getLoader(stateLoader);
  const approval = loader.get(PendingApproval, id);
  if (!approval) return;

  const now = Date.now();
  approval.status = resolution;
  approval.resolved_at = now;
  await approval.save();
}

/**
 * List pending approvals, optionally filtered by topic key.
 */
export function listPendingApprovals(
  topicKey?: string,
  stateLoader?: StateLoader,
): PendingApproval[] {
  const loader = getLoader(stateLoader);
  if (topicKey) {
    return loader.find(PendingApproval, {
      where: { status: "pending", topic_key: topicKey },
      orderBy: { id: "desc" },
    });
  }
  return loader.find(PendingApproval, {
    where: { status: "pending" },
    orderBy: { id: "desc" },
  });
}

/**
 * Find an approval for the given topic, tool, and arguments.
 * Returns the most recent approval matching the criteria, regardless of status.
 */
export function getApprovalForTool(
  topicKey: string,
  toolName: string,
  argsJson: string,
  stateLoader?: StateLoader,
): PendingApproval | null {
  const loader = getLoader(stateLoader);
  const approvals = loader.find(PendingApproval, {
    where: {
      topic_key: topicKey,
      tool_name: toolName,
      tool_args_json: argsJson,
    },
    orderBy: { id: "desc" },
    limit: 1,
  });
  return approvals.length > 0 ? approvals[0] : null;
}

/**
 * Mark an approval as consumed (executed). Sets status to 'consumed'.
 */
export async function consumeApproval(
  id: string,
  stateLoader?: StateLoader,
): Promise<void> {
  const loader = getLoader(stateLoader);
  const approval = loader.get(PendingApproval, id);
  if (!approval) return;

  approval.status = "consumed";
  await approval.save();
}
