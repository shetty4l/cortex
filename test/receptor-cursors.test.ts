import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDatabase, initDatabase } from "../src/db";
import { ReceptorCursorState, StateLoader } from "../src/state";

let stateLoader: StateLoader;

beforeEach(() => {
  initDatabase(":memory:");
  stateLoader = new StateLoader(getDatabase());
});

afterEach(async () => {
  await stateLoader.flush();
  closeDatabase();
});

function getReceptorCursor(channel: string): {
  cursorValue: string | null;
  lastSyncedAt: number | null;
} | null {
  const state = stateLoader.load(ReceptorCursorState, channel);
  if (state.cursorValue === null && state.lastSyncedAt === null) {
    return null;
  }
  return {
    cursorValue: state.cursorValue,
    lastSyncedAt: state.lastSyncedAt?.getTime() ?? null,
  };
}

async function upsertReceptorCursor(
  channel: string,
  cursorValue: string,
): Promise<void> {
  const state = stateLoader.load(ReceptorCursorState, channel);
  state.cursorValue = cursorValue;
  state.lastSyncedAt = new Date();
  await stateLoader.flush();
}

describe("receptor cursors", () => {
  test("getReceptorCursor returns null when no cursor exists", () => {
    const cursor = getReceptorCursor("telegram");
    expect(cursor).toBeNull();
  });

  test("upsertReceptorCursor creates new cursor", async () => {
    await upsertReceptorCursor("telegram", "12345");

    const cursor = getReceptorCursor("telegram");
    expect(cursor).not.toBeNull();
    expect(cursor!.cursorValue).toBe("12345");
  });

  test("getReceptorCursor returns cursor with cursorValue and lastSyncedAt", async () => {
    const before = Date.now();
    await upsertReceptorCursor("calendar", "2026-02-22T00:00:00Z");
    const after = Date.now();

    const cursor = getReceptorCursor("calendar");
    expect(cursor).not.toBeNull();
    expect(cursor!.cursorValue).toBe("2026-02-22T00:00:00Z");
    expect(cursor!.lastSyncedAt).toBeGreaterThanOrEqual(before);
    expect(cursor!.lastSyncedAt).toBeLessThanOrEqual(after);
  });

  test("upsertReceptorCursor updates existing cursor (upsert behavior)", async () => {
    await upsertReceptorCursor("telegram", "100");
    const first = getReceptorCursor("telegram");
    expect(first!.cursorValue).toBe("100");

    await upsertReceptorCursor("telegram", "200");
    const second = getReceptorCursor("telegram");
    expect(second!.cursorValue).toBe("200");
    expect(second!.lastSyncedAt).toBeGreaterThanOrEqual(first!.lastSyncedAt!);
  });

  test("cursors for different channels are independent", async () => {
    await upsertReceptorCursor("telegram", "999");
    await upsertReceptorCursor("calendar", "abc");

    expect(getReceptorCursor("telegram")!.cursorValue).toBe("999");
    expect(getReceptorCursor("calendar")!.cursorValue).toBe("abc");
    expect(getReceptorCursor("email")).toBeNull();
  });
});
