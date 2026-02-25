/**
 * PendingApproval entity for persistence via StateLoader.
 *
 * Tracks approval requests for agent actions that require user confirmation.
 * Uses @PersistedCollection for multi-row table storage with explicit save().
 */

import {
  CollectionEntity,
  CollectionField as Field,
  Id,
  Index,
  PersistedCollection,
} from "@shetty4l/core/state";
import type { ApprovalStatus } from "./types";

/**
 * PendingApproval entity persisted to SQLite via StateLoader.
 *
 * Uses @PersistedCollection for multi-row table storage with explicit save().
 */
@PersistedCollection("pending_approvals")
export class PendingApproval extends CollectionEntity {
  @Id() id: string = "";
  @Field("string") @Index() topicKey: string = "";
  @Field("string") action: string = "";
  @Field("string") toolName: string | null = null;
  @Field("string") toolArgsJson: string | null = null;
  @Field("string") @Index() status: ApprovalStatus = "pending";
  @Field("number") @Index() proposedAt: number = 0;
  @Field("number") resolvedAt: number | null = null;
  @Field("number") createdAt: number = 0;
  @Field("number") updatedAt: number = 0;

  async save(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }

  async delete(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }
}
