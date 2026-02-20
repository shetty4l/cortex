import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDatabase,
  getDatabase,
  getTelegramOffset,
  initDatabase,
  setTelegramOffset,
} from "../src/db";

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("telegram_state offset", () => {
  test("returns null when offset is missing", () => {
    expect(getTelegramOffset()).toBeNull();
  });

  test("stores and reads offset", () => {
    setTelegramOffset(1234);
    expect(getTelegramOffset()).toBe(1234);
  });

  test("upsert overwrites existing offset", () => {
    setTelegramOffset(10);
    setTelegramOffset(42);
    expect(getTelegramOffset()).toBe(42);
  });

  test("stores offsets independently per bot token", () => {
    setTelegramOffset(100, "token-a");
    setTelegramOffset(200, "token-b");

    expect(getTelegramOffset("token-a")).toBe(100);
    expect(getTelegramOffset("token-b")).toBe(200);
    expect(getTelegramOffset()).toBeNull();
  });

  test("returns null for invalid stored value", () => {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO telegram_state (key, value) VALUES ('offset', 'nope')",
    ).run();
    expect(getTelegramOffset()).toBeNull();
  });
});
