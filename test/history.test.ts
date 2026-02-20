import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDatabase,
  initDatabase,
  loadRecentTurns,
  saveAgentTurns,
  saveTurn,
} from "../src/db";
import { loadHistory, saveAgentHistory, saveTurnPair } from "../src/history";

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

  test("limits to N most recent rows", () => {
    // Insert 5 pairs (10 rows)
    for (let i = 1; i <= 5; i++) {
      saveTurn("topic-1", "user", `User ${i}`);
      saveTurn("topic-1", "assistant", `Assistant ${i}`);
    }

    // Limit to 6 rows, should get the 3 most recent pairs
    const turns = loadRecentTurns("topic-1", 6);
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

// --- Agent history (tool calling) ---

describe("saveAgentHistory / loadHistory with tool messages", () => {
  test("saves and loads agent turns with tool_calls and tool results", () => {
    saveAgentHistory("topic-1", [
      { role: "user", content: "What is 2+2?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function" as const,
            function: { name: "math.add", arguments: '{"a":2,"b":2}' },
          },
        ],
      },
      {
        role: "tool",
        content: "4",
        tool_call_id: "call_1",
        name: "math.add",
      },
      { role: "assistant", content: "2+2 equals 4." },
    ]);

    const messages = loadHistory("topic-1");
    expect(messages).toHaveLength(4);

    // User message
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("What is 2+2?");

    // Assistant with tool_calls
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("");
    expect(messages[1].tool_calls).toHaveLength(1);
    expect(messages[1].tool_calls![0].id).toBe("call_1");
    expect(messages[1].tool_calls![0].function.name).toBe("math.add");

    // Tool result
    expect(messages[2].role).toBe("tool");
    expect(messages[2].content).toBe("4");
    expect(messages[2].tool_call_id).toBe("call_1");
    expect(messages[2].name).toBe("math.add");

    // Final assistant
    expect(messages[3].role).toBe("assistant");
    expect(messages[3].content).toBe("2+2 equals 4.");
  });

  test("loadHistory limit counts user messages, not total messages", () => {
    // Group 1: user + tool_call + tool_result + final (4 messages)
    saveAgentHistory("topic-1", [
      { role: "user", content: "Q1" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "c1",
            type: "function" as const,
            function: { name: "echo.say", arguments: '{"text":"1"}' },
          },
        ],
      },
      {
        role: "tool",
        content: "1",
        tool_call_id: "c1",
        name: "echo.say",
      },
      { role: "assistant", content: "A1" },
    ]);

    // Group 2: simple pair (2 messages)
    saveAgentHistory("topic-1", [
      { role: "user", content: "Q2" },
      { role: "assistant", content: "A2" },
    ]);

    // Group 3: simple pair (2 messages)
    saveAgentHistory("topic-1", [
      { role: "user", content: "Q3" },
      { role: "assistant", content: "A3" },
    ]);

    // Limit=2 should return last 2 user groups: Q2+A2 and Q3+A3
    const messages = loadHistory("topic-1", 2);
    expect(messages).toHaveLength(4);
    expect(messages[0].content).toBe("Q2");
    expect(messages[1].content).toBe("A2");
    expect(messages[2].content).toBe("Q3");
    expect(messages[3].content).toBe("A3");
  });

  test("saveAgentTurns stores in atomic transaction", () => {
    saveAgentTurns("topic-1", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "Bye" },
      { role: "assistant", content: "Goodbye" },
    ]);

    const turns = loadRecentTurns("topic-1");
    expect(turns).toHaveLength(4);
    expect(turns[0].content).toBe("Hello");
    expect(turns[3].content).toBe("Goodbye");
  });
});
