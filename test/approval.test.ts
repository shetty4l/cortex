import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StateLoader } from "@shetty4l/core/state";
import {
  APPROVAL_TTL_MS,
  consumeApproval,
  getApprovalForTool,
  isExpired,
  listPendingApprovals,
  proposeApproval,
  resolveApproval,
} from "../src/approval/index";
import { closeDatabase, getDatabase, initDatabase } from "../src/db";

let stateLoader: StateLoader;

beforeEach(() => {
  initDatabase(":memory:");
  stateLoader = new StateLoader(getDatabase());
});

afterEach(async () => {
  await stateLoader.flush();
  closeDatabase();
});

describe("approval CRUD", () => {
  test("proposeApproval returns PendingApproval with status pending", () => {
    const before = Date.now();
    const approval = proposeApproval(stateLoader, {
      topicKey: "trip-japan",
      action: "book_hotel",
    });
    const after = Date.now();

    expect(approval.id).toBeTruthy();
    expect(approval.topicKey).toBe("trip-japan");
    expect(approval.action).toBe("book_hotel");
    expect(approval.toolName).toBeNull();
    expect(approval.toolArgsJson).toBeNull();
    expect(approval.status).toBe("pending");
    expect(approval.proposedAt).toBeGreaterThanOrEqual(before);
    expect(approval.proposedAt).toBeLessThanOrEqual(after);
    expect(approval.resolvedAt).toBeNull();
    expect(approval.agentStateJson).toBeNull();
    expect(approval.toolCallsJson).toBeNull();
    expect(approval.expiresAt).toBeGreaterThanOrEqual(before + APPROVAL_TTL_MS);
    expect(approval.expiresAt).toBeLessThanOrEqual(after + APPROVAL_TTL_MS);
  });

  test("proposeApproval with toolName and toolArgsJson", () => {
    const approval = proposeApproval(stateLoader, {
      topicKey: "trip",
      action: "send_email",
      toolName: "gmail.send",
      toolArgsJson: '{"to":"test@example.com"}',
    });

    expect(approval.toolName).toBe("gmail.send");
    expect(approval.toolArgsJson).toBe('{"to":"test@example.com"}');
  });

  test("proposeApproval with agentStateJson and toolCallsJson", () => {
    const agentState = JSON.stringify([{ role: "user", content: "test" }]);
    const toolCalls = JSON.stringify([
      { id: "tc1", function: { name: "test" } },
    ]);

    const approval = proposeApproval(stateLoader, {
      topicKey: "trip",
      action: "execute_tool",
      agentStateJson: agentState,
      toolCallsJson: toolCalls,
    });

    expect(approval.agentStateJson).toBe(agentState);
    expect(approval.toolCallsJson).toBe(toolCalls);
  });

  test("resolveApproval with approved sets status and resolved_at", async () => {
    const approval = proposeApproval(stateLoader, {
      topicKey: "trip",
      action: "book_flight",
    });

    await resolveApproval(stateLoader, approval.id, "approved");

    const pending = listPendingApprovals(stateLoader);
    expect(pending).toHaveLength(0);
  });

  test("resolveApproval with rejected sets status and resolved_at", async () => {
    const approval = proposeApproval(stateLoader, {
      topicKey: "trip",
      action: "delete_account",
    });

    await resolveApproval(stateLoader, approval.id, "rejected");

    const pending = listPendingApprovals(stateLoader);
    expect(pending).toHaveLength(0);
  });

  test("listPendingApprovals returns only pending status", async () => {
    const a1 = proposeApproval(stateLoader, { topicKey: "t1", action: "a1" });
    proposeApproval(stateLoader, { topicKey: "t2", action: "a2" });
    await resolveApproval(stateLoader, a1.id, "approved");

    const pending = listPendingApprovals(stateLoader);
    expect(pending).toHaveLength(1);
    expect(pending[0].action).toBe("a2");
  });

  test("listPendingApprovals filtered by topicKey", () => {
    proposeApproval(stateLoader, { topicKey: "trip-japan", action: "a1" });
    proposeApproval(stateLoader, { topicKey: "trip-paris", action: "a2" });
    proposeApproval(stateLoader, { topicKey: "trip-japan", action: "a3" });

    const japan = listPendingApprovals(stateLoader, "trip-japan");
    expect(japan).toHaveLength(2);
    for (const a of japan) {
      expect(a.topicKey).toBe("trip-japan");
    }

    const paris = listPendingApprovals(stateLoader, "trip-paris");
    expect(paris).toHaveLength(1);
    expect(paris[0].topicKey).toBe("trip-paris");
  });

  test("getApprovalForTool returns most recent approved approval", async () => {
    const a1 = proposeApproval(stateLoader, {
      topicKey: "trip",
      action: "call_tool",
      toolName: "gmail.send",
    });
    await resolveApproval(stateLoader, a1.id, "approved");

    const approval = getApprovalForTool(stateLoader, "trip", "gmail.send");
    expect(approval).not.toBeNull();
    expect(approval!.id).toBe(a1.id);
    expect(approval!.status).toBe("approved");
  });

  test("getApprovalForTool returns null when no approval exists", () => {
    const approval = getApprovalForTool(stateLoader, "trip", "gmail.send");
    expect(approval).toBeNull();
  });

  test("consumeApproval marks approved approval as consumed", async () => {
    const a1 = proposeApproval(stateLoader, {
      topicKey: "trip",
      action: "call_tool",
      toolName: "gmail.send",
    });
    await resolveApproval(stateLoader, a1.id, "approved");

    await consumeApproval(stateLoader, a1.id);

    // Should no longer appear in getApprovalForTool
    const approval = getApprovalForTool(stateLoader, "trip", "gmail.send");
    expect(approval).toBeNull();
  });

  test("consumeApproval logs warning for non-existent approval", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);

    await consumeApproval(stateLoader, "non-existent-id");

    console.warn = originalWarn;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not found");
  });

  test("consumeApproval logs warning for non-approved approval", async () => {
    const a1 = proposeApproval(stateLoader, {
      topicKey: "trip",
      action: "call_tool",
    });

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);

    await consumeApproval(stateLoader, a1.id);

    console.warn = originalWarn;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not in approved status");
  });
});

describe("isExpired", () => {
  test("returns false when expiresAt is 0", () => {
    const approval = proposeApproval(stateLoader, {
      topicKey: "trip",
      action: "test",
    });
    // Manually set expiresAt to 0 to test edge case
    approval.expiresAt = 0;

    expect(isExpired(approval)).toBe(false);
  });

  test("returns false when current time is before expiresAt", () => {
    const approval = proposeApproval(stateLoader, {
      topicKey: "trip",
      action: "test",
    });

    // Check with current time (should not be expired)
    expect(isExpired(approval)).toBe(false);
  });

  test("returns true when current time equals expiresAt", () => {
    const approval = proposeApproval(stateLoader, {
      topicKey: "trip",
      action: "test",
    });

    // Check at exact expiry time
    expect(isExpired(approval, approval.expiresAt)).toBe(true);
  });

  test("returns true when current time is after expiresAt", () => {
    const approval = proposeApproval(stateLoader, {
      topicKey: "trip",
      action: "test",
    });

    // Check after expiry
    expect(isExpired(approval, approval.expiresAt + 1000)).toBe(true);
  });

  test("APPROVAL_TTL_MS is 15 minutes", () => {
    expect(APPROVAL_TTL_MS).toBe(15 * 60 * 1000);
  });
});
