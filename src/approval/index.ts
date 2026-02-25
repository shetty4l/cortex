import { getDatabase } from "../db";
import type { ApprovalStatus } from "./types";

export type { ApprovalStatus } from "./types";

export interface PendingApproval {
  id: string;
  topic_key: string;
  action: string;
  tool_name: string | null;
  tool_args_json: string | null;
  status: ApprovalStatus;
  proposed_at: number;
  resolved_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ProposeApprovalInput {
  topic_key: string;
  action: string;
  tool_name?: string;
  tool_args_json?: string;
}

export function proposeApproval(input: ProposeApprovalInput): PendingApproval {
  const db = getDatabase();
  const now = Date.now();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO pending_approvals (id, topic_key, action, tool_name, tool_args_json, proposed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.topic_key,
    input.action,
    input.tool_name ?? null,
    input.tool_args_json ?? null,
    now,
    now,
    now,
  );
  return db
    .prepare("SELECT * FROM pending_approvals WHERE id = ?")
    .get(id) as PendingApproval;
}

export function resolveApproval(
  id: string,
  resolution: Exclude<ApprovalStatus, "pending">,
): void {
  const db = getDatabase();
  const now = Date.now();
  db.prepare(
    "UPDATE pending_approvals SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ?",
  ).run(resolution, now, now, id);
}

export function listPendingApprovals(topicKey?: string): PendingApproval[] {
  const db = getDatabase();
  if (topicKey) {
    return db
      .prepare(
        "SELECT * FROM pending_approvals WHERE status = 'pending' AND topic_key = ? ORDER BY proposed_at DESC",
      )
      .all(topicKey) as PendingApproval[];
  }
  return db
    .prepare(
      "SELECT * FROM pending_approvals WHERE status = 'pending' ORDER BY proposed_at DESC",
    )
    .all() as PendingApproval[];
}

export function getApprovalForTool(
  topicKey: string,
  toolName: string,
): PendingApproval | null {
  const db = getDatabase();
  const approval = db
    .prepare(
      `SELECT * FROM pending_approvals 
       WHERE status = 'approved' AND topic_key = ? AND tool_name = ? 
       ORDER BY proposed_at DESC 
       LIMIT 1`,
    )
    .get(topicKey, toolName) as PendingApproval | undefined;
  return approval ?? null;
}

export function consumeApproval(id: string): void {
  const db = getDatabase();
  const result = db
    .prepare(
      "UPDATE pending_approvals SET status = 'consumed', updated_at = ? WHERE id = ? AND status = 'approved'",
    )
    .run(Date.now(), id);

  if (result.changes === 0) {
    console.warn(`consumeApproval: approval not found or not approved: ${id}`);
  }
}
