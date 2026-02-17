import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDatabase,
  initDatabase,
  loadRecentTurns,
  saveTurn,
} from "../src/db";
import { loadHistory, saveTurnPair } from "../src/history";

// --- Setup ---

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

// --- DB-level turn operations ---

describe("saveTurn / loadRecentTurns", () => {
  test("saves and loads a single turn", () => {
    saveTurn("topic-1", "user", "Hello");

    const turns = loadRecentTurns("topic-1");
    expect(turns).toHaveLength(1);
    expect(turns[0].topic_key).toBe("topic-1");
    expect(turns[0].role).toBe("user");
    expect(turns[0].content).toBe("Hello");
    expect(turns[0].id).toMatch(/^turn_/);
    expect(turns[0].created_at).toBeGreaterThan(0);
  });

  test("returns turns ordered oldest-first", () => {
    saveTurn("topic-1", "user", "First");
    saveTurn("topic-1", "assistant", "Second");
    saveTurn("topic-1", "user", "Third");

    const turns = loadRecentTurns("topic-1");
    expect(turns).toHaveLength(3);
    expect(turns[0].content).toBe("First");
    expect(turns[1].content).toBe("Second");
    expect(turns[2].content).toBe("Third");
  });

  test("limits to N turn pairs (N*2 rows)", () => {
    // Insert 5 pairs (10 rows)
    for (let i = 1; i <= 5; i++) {
      saveTurn("topic-1", "user", `User ${i}`);
      saveTurn("topic-1", "assistant", `Assistant ${i}`);
    }

    // Limit to 3 pairs = 6 rows, should get the 3 most recent pairs
    const turns = loadRecentTurns("topic-1", 3);
    expect(turns).toHaveLength(6);
    expect(turns[0].content).toBe("User 3");
    expect(turns[1].content).toBe("Assistant 3");
    expect(turns[4].content).toBe("User 5");
    expect(turns[5].content).toBe("Assistant 5");
  });

  test("isolates turns by topic", () => {
    saveTurn("topic-a", "user", "Topic A message");
    saveTurn("topic-b", "user", "Topic B message");

    const turnsA = loadRecentTurns("topic-a");
    const turnsB = loadRecentTurns("topic-b");

    expect(turnsA).toHaveLength(1);
    expect(turnsA[0].content).toBe("Topic A message");

    expect(turnsB).toHaveLength(1);
    expect(turnsB[0].content).toBe("Topic B message");
  });

  test("returns empty array for unknown topic", () => {
    const turns = loadRecentTurns("nonexistent");
    expect(turns).toHaveLength(0);
  });
});

// --- History module (ChatMessage conversion) ---

describe("saveTurnPair / loadHistory", () => {
  test("saves a turn pair and loads as ChatMessage[]", () => {
    saveTurnPair("topic-1", "What is 2+2?", "4");

    const messages = loadHistory("topic-1");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", content: "What is 2+2?" });
    expect(messages[1]).toEqual({ role: "assistant", content: "4" });
  });

  test("loads multiple turn pairs in order", () => {
    saveTurnPair("topic-1", "Hello", "Hi there!");
    saveTurnPair("topic-1", "How are you?", "I'm good.");

    const messages = loadHistory("topic-1");
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ role: "user", content: "Hello" });
    expect(messages[1]).toEqual({ role: "assistant", content: "Hi there!" });
    expect(messages[2]).toEqual({ role: "user", content: "How are you?" });
    expect(messages[3]).toEqual({ role: "assistant", content: "I'm good." });
  });

  test("respects turn pair limit", () => {
    for (let i = 1; i <= 10; i++) {
      saveTurnPair("topic-1", `Q${i}`, `A${i}`);
    }

    const messages = loadHistory("topic-1", 2);
    expect(messages).toHaveLength(4);
    // Should be the 2 most recent pairs
    expect(messages[0]).toEqual({ role: "user", content: "Q9" });
    expect(messages[1]).toEqual({ role: "assistant", content: "A9" });
    expect(messages[2]).toEqual({ role: "user", content: "Q10" });
    expect(messages[3]).toEqual({ role: "assistant", content: "A10" });
  });

  test("returns empty array for topic with no history", () => {
    const messages = loadHistory("empty-topic");
    expect(messages).toEqual([]);
  });
});
