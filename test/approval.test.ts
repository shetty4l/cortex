import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StateLoader } from "@shetty4l/core/state";
import {
  APPROVAL_TTL_MS,
  getApprovalById,
  isExpired,
  listPendingApprovals,
  proposeApproval,
  resolveApproval,
} from "../src/approval/index";
import { closeDatabase, getDatabase, initDatabase } from "../src/db";
import { enqueueInboxMessage } from "../src/inbox";

let stateLoader: StateLoader;

beforeEach(() => {
  initDatabase(":memory:");
  stateLoader = new StateLoader(getDatabase());
});

afterEach(async () => {
  await stateLoader.flush();
  closeDatabase();
});

// Helper to create an inbox message for approval tests
function createInboxMessage(): string {
  const id = crypto.randomUUID().slice(0, 8);
  const result = enqueueInboxMessage(stateLoader, {
    channel: "test",
    externalMessageId: `msg-${id}`,
    topicKey: "topic-1",
    userId: "user-1",
    text: "Test message",
    occurredAt: Date.now(),
    idempotencyKey: `key-${id}`,
  });
  return result.id;
}

describe("approval CRUD", () => {
  test("proposeApproval returns PendingApproval with status pending", () => {
    const inboxMessageId = createInboxMessage();
    const before = Date.now();
    const approval = proposeApproval(stateLoader, {
      topicKey: "trip-japan",
      action: "book_hotel",
      inboxMessageId,
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
    expect(approval.inboxMessageId).toBe(inboxMessageId);
    expect(approval.expiresAt).toBeGreaterThanOrEqual(before + APPROVAL_TTL_MS);
    expect(approval.expiresAt).toBeLessThanOrEqual(after + APPROVAL_TTL_MS);
  });

  test("proposeApproval with toolName and toolArgsJson", () => {
    const inboxMessageId = createInboxMessage();
    const approval = proposeApproval(stateLoader, {
      topicKey: "trip",
      action: "send_email",
      inboxMessageId,
      toolName: "gmail.send",
      toolArgsJson: '{"to":"test@example.com"}',
    });

    expect(approval.toolName).toBe("gmail.send");
    expect(approval.toolArgsJson).toBe('{"to":"test@example.com"}');
  });

  test("proposeApproval throws if message already has pending approval", () => {
    const inboxMessageId = createInboxMessage();

    // First approval should succeed
    proposeApproval(stateLoader, {
      topicKey: "trip",
      action: "first_action",
      inboxMessageId,
    });

    // Second approval for same message should throw
    expect(() =>
      proposeApproval(stateLoader, {
        topicKey: "trip",
        action: "second_action",
        inboxMessageId,
      }),
    ).toThrow(/already has a pending approval/);
  });

  test("resolveApproval with approved sets status and resolved_at", async () => {
    const inboxMessageId = createInboxMessage();
    const approval = proposeApproval(stateLoader, {
      topicKey: "trip",
      action: "book_flight",
      inboxMessageId,
    });

    await resolveApproval(stateLoader, approval.id, "approved");

    const pending = listPendingApprovals(stateLoader);
    expect(pending).toHaveLength(0);
  });

  test("resolveApproval with rejected sets status and resolved_at", async () => {
    const inboxMessageId = createInboxMessage();
    const approval = proposeApproval(stateLoader, {
      topicKey: "trip",
      action: "delete_account",
      inboxMessageId,
    });

    await resolveApproval(stateLoader, approval.id, "rejected");

    const pending = listPendingApprovals(stateLoader);
    expect(pending).toHaveLength(0);
  });

  test("listPendingApprovals returns only pending status", async () => {
    const inboxMessageId1 = createInboxMessage();
    const inboxMessageId2 = createInboxMessage();
    const a1 = proposeApproval(stateLoader, {
      topicKey: "t1",
      action: "a1",
      inboxMessageId: inboxMessageId1,
    });
    proposeApproval(stateLoader, {
      topicKey: "t2",
      action: "a2",
      inboxMessageId: inboxMessageId2,
    });
    await resolveApproval(stateLoader, a1.id, "approved");

    const pending = listPendingApprovals(stateLoader);
    expect(pending).toHaveLength(1);
    expect(pending[0].action).toBe("a2");
  });

  test("listPendingApprovals filtered by topicKey", () => {
    const inboxMessageId1 = createInboxMessage();
    const inboxMessageId2 = createInboxMessage();
    const inboxMessageId3 = createInboxMessage();
    proposeApproval(stateLoader, {
      topicKey: "trip-japan",
      action: "a1",
      inboxMessageId: inboxMessageId1,
    });
    proposeApproval(stateLoader, {
      topicKey: "trip-paris",
      action: "a2",
      inboxMessageId: inboxMessageId2,
    });
    proposeApproval(stateLoader, {
      topicKey: "trip-japan",
      action: "a3",
      inboxMessageId: inboxMessageId3,
    });

    const japan = listPendingApprovals(stateLoader, "trip-japan");
    expect(japan).toHaveLength(2);
    for (const a of japan) {
      expect(a.topicKey).toBe("trip-japan");
    }

    const paris = listPendingApprovals(stateLoader, "trip-paris");
    expect(paris).toHaveLength(1);
    expect(paris[0].topicKey).toBe("trip-paris");
  });

  test("getApprovalById returns approval by ID", async () => {
    const inboxMessageId = createInboxMessage();
    const created = proposeApproval(stateLoader, {
      topicKey: "trip",
      action: "call_tool",
      inboxMessageId,
      toolName: "gmail.send",
    });

    const approval = getApprovalById(stateLoader, created.id);
    expect(approval).not.toBeNull();
    expect(approval!.id).toBe(created.id);
    expect(approval!.status).toBe("pending");
  });

  test("getApprovalById returns null when no approval exists", () => {
    const approval = getApprovalById(stateLoader, "non-existent-id");
    expect(approval).toBeNull();
  });
});

describe("isExpired", () => {
  test("returns false when expiresAt is 0", () => {
    const inboxMessageId = createInboxMessage();
    const approval = proposeApproval(stateLoader, {
      topicKey: "trip",
      action: "test",
      inboxMessageId,
    });
    // Manually set expiresAt to 0 to test edge case
    approval.expiresAt = 0;

    expect(isExpired(approval)).toBe(false);
  });

  test("returns false when current time is before expiresAt", () => {
    const inboxMessageId = createInboxMessage();
    const approval = proposeApproval(stateLoader, {
      topicKey: "trip",
      action: "test",
      inboxMessageId,
    });

    // Check with current time (should not be expired)
    expect(isExpired(approval)).toBe(false);
  });

  test("returns true when current time equals expiresAt", () => {
    const inboxMessageId = createInboxMessage();
    const approval = proposeApproval(stateLoader, {
      topicKey: "trip",
      action: "test",
      inboxMessageId,
    });

    // Check at exact expiry time
    expect(isExpired(approval, approval.expiresAt)).toBe(true);
  });

  test("returns true when current time is after expiresAt", () => {
    const inboxMessageId = createInboxMessage();
    const approval = proposeApproval(stateLoader, {
      topicKey: "trip",
      action: "test",
      inboxMessageId,
    });

    // Check after expiry
    expect(isExpired(approval, approval.expiresAt + 1000)).toBe(true);
  });

  test("APPROVAL_TTL_MS is 15 minutes", () => {
    expect(APPROVAL_TTL_MS).toBe(15 * 60 * 1000);
  });
});
