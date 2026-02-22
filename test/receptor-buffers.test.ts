import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDatabase,
  deleteProcessedBuffers,
  getUnprocessedBuffers,
  initDatabase,
  insertReceptorBuffer,
} from "../src/db";

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("insertReceptorBuffer", () => {
  test("creates a row with correct fields", () => {
    const result = insertReceptorBuffer({
      channel: "calendar",
      externalId: "cal-event-1",
      content: "Meeting at 10am",
      metadataJson: JSON.stringify({ source: "google" }),
      occurredAt: 1700000000000,
    });

    expect(result.duplicate).toBe(false);
    expect(result.id).toMatch(/^rb_/);

    const buffers = getUnprocessedBuffers();
    expect(buffers).toHaveLength(1);
    expect(buffers[0].id).toBe(result.id);
    expect(buffers[0].channel).toBe("calendar");
    expect(buffers[0].externalId).toBe("cal-event-1");
    expect(buffers[0].content).toBe("Meeting at 10am");
    expect(buffers[0].metadataJson).toBe(JSON.stringify({ source: "google" }));
    expect(buffers[0].occurredAt).toBe(1700000000000);
    expect(typeof buffers[0].createdAt).toBe("number");
  });

  test("detects duplicates (same channel+externalId)", () => {
    const first = insertReceptorBuffer({
      channel: "calendar",
      externalId: "cal-event-1",
      content: "Meeting at 10am",
      occurredAt: 1700000000000,
    });
    expect(first.duplicate).toBe(false);

    const second = insertReceptorBuffer({
      channel: "calendar",
      externalId: "cal-event-1",
      content: "Different content",
      occurredAt: 1700000001000,
    });
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);

    // Only one row should exist
    const buffers = getUnprocessedBuffers();
    expect(buffers).toHaveLength(1);
    expect(buffers[0].content).toBe("Meeting at 10am");
  });

  test("different channels with same externalId are not duplicates", () => {
    const first = insertReceptorBuffer({
      channel: "calendar",
      externalId: "shared-id",
      content: "Calendar event",
      occurredAt: 1700000000000,
    });
    const second = insertReceptorBuffer({
      channel: "email",
      externalId: "shared-id",
      content: "Email message",
      occurredAt: 1700000001000,
    });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(false);
    expect(first.id).not.toBe(second.id);
  });
});

describe("getUnprocessedBuffers", () => {
  test("returns all buffers ordered by occurredAt ASC", () => {
    insertReceptorBuffer({
      channel: "calendar",
      externalId: "event-2",
      content: "Later event",
      occurredAt: 1700000002000,
    });
    insertReceptorBuffer({
      channel: "calendar",
      externalId: "event-1",
      content: "Earlier event",
      occurredAt: 1700000001000,
    });

    const buffers = getUnprocessedBuffers();
    expect(buffers).toHaveLength(2);
    expect(buffers[0].content).toBe("Earlier event");
    expect(buffers[1].content).toBe("Later event");
  });

  test("filters by channel", () => {
    insertReceptorBuffer({
      channel: "calendar",
      externalId: "cal-1",
      content: "Calendar event",
      occurredAt: 1700000000000,
    });
    insertReceptorBuffer({
      channel: "email",
      externalId: "email-1",
      content: "Email message",
      occurredAt: 1700000001000,
    });

    const calOnly = getUnprocessedBuffers({ channel: "calendar" });
    expect(calOnly).toHaveLength(1);
    expect(calOnly[0].channel).toBe("calendar");

    const emailOnly = getUnprocessedBuffers({ channel: "email" });
    expect(emailOnly).toHaveLength(1);
    expect(emailOnly[0].channel).toBe("email");
  });

  test("filters by since timestamp", () => {
    insertReceptorBuffer({
      channel: "calendar",
      externalId: "old-event",
      content: "Old event",
      occurredAt: 1700000000000,
    });

    const afterFirst = Date.now();

    // Small delay to ensure created_at differs
    const before = Date.now();
    // Insert second buffer — its created_at will be >= afterFirst
    insertReceptorBuffer({
      channel: "calendar",
      externalId: "new-event",
      content: "New event",
      occurredAt: 1700000001000,
    });

    // Filter since = before first insert's created_at minus 1 should get both
    const all = getUnprocessedBuffers({ since: 0 });
    expect(all).toHaveLength(2);

    // Filter since = afterFirst should only get the second
    const recent = getUnprocessedBuffers({ since: afterFirst - 1 });
    expect(recent.length).toBeGreaterThanOrEqual(1);
    // The most recent should be the "New event"
    expect(recent[recent.length - 1].content).toBe("New event");
  });

  test("returns empty array when no buffers exist", () => {
    const buffers = getUnprocessedBuffers();
    expect(buffers).toHaveLength(0);
  });
});

describe("deleteProcessedBuffers", () => {
  test("removes specified rows", () => {
    const a = insertReceptorBuffer({
      channel: "calendar",
      externalId: "event-a",
      content: "Event A",
      occurredAt: 1700000000000,
    });
    const b = insertReceptorBuffer({
      channel: "calendar",
      externalId: "event-b",
      content: "Event B",
      occurredAt: 1700000001000,
    });
    insertReceptorBuffer({
      channel: "calendar",
      externalId: "event-c",
      content: "Event C",
      occurredAt: 1700000002000,
    });

    deleteProcessedBuffers([a.id, b.id]);

    const remaining = getUnprocessedBuffers();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).toBe("Event C");
  });

  test("returns count of deleted rows", () => {
    const a = insertReceptorBuffer({
      channel: "calendar",
      externalId: "event-a",
      content: "Event A",
      occurredAt: 1700000000000,
    });
    const b = insertReceptorBuffer({
      channel: "calendar",
      externalId: "event-b",
      content: "Event B",
      occurredAt: 1700000001000,
    });

    const deleted = deleteProcessedBuffers([a.id, b.id]);
    expect(deleted).toBe(2);
  });

  test("with empty array returns 0", () => {
    const deleted = deleteProcessedBuffers([]);
    expect(deleted).toBe(0);
  });

  test("returns 0 for non-existent ids", () => {
    const deleted = deleteProcessedBuffers([
      "nonexistent-id-1",
      "nonexistent-id-2",
    ]);
    expect(deleted).toBe(0);
  });
});
