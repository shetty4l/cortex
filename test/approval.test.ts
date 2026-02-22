import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  listPendingApprovals,
  proposeApproval,
  resolveApproval,
} from "../src/approval/index";
import { closeDatabase, initDatabase } from "../src/db";

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("approval CRUD", () => {
  test("proposeApproval returns PendingApproval with status pending", () => {
    const before = Date.now();
    const approval = proposeApproval({
      topic_key: "trip-japan",
      action: "book_hotel",
    });
    const after = Date.now();

    expect(approval.id).toBeTruthy();
    expect(approval.topic_key).toBe("trip-japan");
    expect(approval.action).toBe("book_hotel");
    expect(approval.tool_name).toBeNull();
    expect(approval.tool_args_json).toBeNull();
    expect(approval.status).toBe("pending");
    expect(approval.proposed_at).toBeGreaterThanOrEqual(before);
    expect(approval.proposed_at).toBeLessThanOrEqual(after);
    expect(approval.resolved_at).toBeNull();
    expect(approval.created_at).toBeGreaterThanOrEqual(before);
  });

  test("proposeApproval with tool_name and tool_args_json", () => {
    const approval = proposeApproval({
      topic_key: "trip",
      action: "send_email",
      tool_name: "gmail.send",
      tool_args_json: '{"to":"test@example.com"}',
    });

    expect(approval.tool_name).toBe("gmail.send");
    expect(approval.tool_args_json).toBe('{"to":"test@example.com"}');
  });

  test("resolveApproval with approved sets status and resolved_at", () => {
    const approval = proposeApproval({
      topic_key: "trip",
      action: "book_flight",
    });

    const before = Date.now();
    resolveApproval(approval.id, "approved");

    const pending = listPendingApprovals();
    expect(pending).toHaveLength(0);
  });

  test("resolveApproval with rejected sets status and resolved_at", () => {
    const approval = proposeApproval({
      topic_key: "trip",
      action: "delete_account",
    });

    resolveApproval(approval.id, "rejected");

    const pending = listPendingApprovals();
    expect(pending).toHaveLength(0);
  });

  test("listPendingApprovals returns only pending status", () => {
    const a1 = proposeApproval({ topic_key: "t1", action: "a1" });
    proposeApproval({ topic_key: "t2", action: "a2" });
    resolveApproval(a1.id, "approved");

    const pending = listPendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0].action).toBe("a2");
  });

  test("listPendingApprovals filtered by topicKey", () => {
    proposeApproval({ topic_key: "trip-japan", action: "a1" });
    proposeApproval({ topic_key: "trip-paris", action: "a2" });
    proposeApproval({ topic_key: "trip-japan", action: "a3" });

    const japan = listPendingApprovals("trip-japan");
    expect(japan).toHaveLength(2);
    for (const a of japan) {
      expect(a.topic_key).toBe("trip-japan");
    }

    const paris = listPendingApprovals("trip-paris");
    expect(paris).toHaveLength(1);
    expect(paris[0].topic_key).toBe("trip-paris");
  });
});
