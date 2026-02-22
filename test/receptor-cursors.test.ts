import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDatabase,
  getReceptorCursor,
  initDatabase,
  upsertReceptorCursor,
} from "../src/db";

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("receptor cursors", () => {
  test("getReceptorCursor returns null when no cursor exists", () => {
    const cursor = getReceptorCursor("telegram");
    expect(cursor).toBeNull();
  });

  test("upsertReceptorCursor creates new cursor", () => {
    upsertReceptorCursor("telegram", "12345");

    const cursor = getReceptorCursor("telegram");
    expect(cursor).not.toBeNull();
    expect(cursor!.cursorValue).toBe("12345");
  });

  test("getReceptorCursor returns cursor with cursorValue and lastSyncedAt", () => {
    const before = Date.now();
    upsertReceptorCursor("calendar", "2026-02-22T00:00:00Z");
    const after = Date.now();

    const cursor = getReceptorCursor("calendar");
    expect(cursor).not.toBeNull();
    expect(cursor!.cursorValue).toBe("2026-02-22T00:00:00Z");
    expect(cursor!.lastSyncedAt).toBeGreaterThanOrEqual(before);
    expect(cursor!.lastSyncedAt).toBeLessThanOrEqual(after);
  });

  test("upsertReceptorCursor updates existing cursor (upsert behavior)", () => {
    upsertReceptorCursor("telegram", "100");
    const first = getReceptorCursor("telegram");
    expect(first!.cursorValue).toBe("100");

    upsertReceptorCursor("telegram", "200");
    const second = getReceptorCursor("telegram");
    expect(second!.cursorValue).toBe("200");
    expect(second!.lastSyncedAt).toBeGreaterThanOrEqual(first!.lastSyncedAt);
  });

  test("cursors for different channels are independent", () => {
    upsertReceptorCursor("telegram", "999");
    upsertReceptorCursor("calendar", "abc");

    expect(getReceptorCursor("telegram")!.cursorValue).toBe("999");
    expect(getReceptorCursor("calendar")!.cursorValue).toBe("abc");
    expect(getReceptorCursor("email")).toBeNull();
  });
});
