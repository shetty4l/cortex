import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StateLoader } from "@shetty4l/core/state";
import { closeDatabase, getDatabase, initDatabase } from "../src/db";
import {
  loadHistoryWithLoader,
  saveAgentHistoryWithLoader,
  saveTurnPairWithLoader,
} from "../src/history";
import { loadRecentTurns, saveAgentTurns, saveTurn } from "../src/turns";

// --- Setup ---

let stateLoader: StateLoader;

beforeEach(() => {
  initDatabase(":memory:");
  stateLoader = new StateLoader(getDatabase());
});

afterEach(() => {
  closeDatabase();
});

// --- DB-level turn operations ---

describe("saveTurn / loadRecentTurns", () => {
  test("saves and loads a single turn", async () => {
    await saveTurn(stateLoader, {
      topicKey: "topic-1",
      role: "user",
      content: "Hello",
    });

    const turns = loadRecentTurns(stateLoader, "topic-1");
    expect(turns).toHaveLength(1);
    expect(turns[0].topic_key).toBe("topic-1");
    expect(turns[0].role).toBe("user");
    expect(turns[0].content).toBe("Hello");
    expect(turns[0].id).toMatch(/^turn_/);
    expect(turns[0].seq).toBe(1);
  });

  test("returns turns ordered oldest-first", async () => {
    await saveTurn(stateLoader, {
      topicKey: "topic-1",
      role: "user",
      content: "First",
    });
    await saveTurn(stateLoader, {
      topicKey: "topic-1",
      role: "assistant",
      content: "Second",
    });
    await saveTurn(stateLoader, {
      topicKey: "topic-1",
      role: "user",
      content: "Third",
    });

    const turns = loadRecentTurns(stateLoader, "topic-1");
    expect(turns).toHaveLength(3);
    expect(turns[0].content).toBe("First");
    expect(turns[1].content).toBe("Second");
    expect(turns[2].content).toBe("Third");
  });

  test("limits to N most recent rows", async () => {
    // Insert 5 pairs (10 rows)
    for (let i = 1; i <= 5; i++) {
      await saveTurn(stateLoader, {
        topicKey: "topic-1",
        role: "user",
        content: `User ${i}`,
      });
      await saveTurn(stateLoader, {
        topicKey: "topic-1",
        role: "assistant",
        content: `Assistant ${i}`,
      });
    }

    // Limit to 6 rows, should get the 3 most recent pairs
    const turns = loadRecentTurns(stateLoader, "topic-1", 6);
    expect(turns).toHaveLength(6);
    expect(turns[0].content).toBe("User 3");
    expect(turns[1].content).toBe("Assistant 3");
    expect(turns[4].content).toBe("User 5");
    expect(turns[5].content).toBe("Assistant 5");
  });

  test("isolates turns by topic", async () => {
    await saveTurn(stateLoader, {
      topicKey: "topic-a",
      role: "user",
      content: "Topic A message",
    });
    await saveTurn(stateLoader, {
      topicKey: "topic-b",
      role: "user",
      content: "Topic B message",
    });

    const turnsA = loadRecentTurns(stateLoader, "topic-a");
    const turnsB = loadRecentTurns(stateLoader, "topic-b");

    expect(turnsA).toHaveLength(1);
    expect(turnsA[0].content).toBe("Topic A message");

    expect(turnsB).toHaveLength(1);
    expect(turnsB[0].content).toBe("Topic B message");
  });

  test("returns empty array for unknown topic", () => {
    const turns = loadRecentTurns(stateLoader, "nonexistent");
    expect(turns).toHaveLength(0);
  });
});

// --- History module (ChatMessage conversion) ---

describe("saveTurnPairWithLoader / loadHistoryWithLoader", () => {
  test("saves a turn pair and loads as ChatMessage[]", async () => {
    await saveTurnPairWithLoader(stateLoader, "topic-1", "What is 2+2?", "4");

    const messages = loadHistoryWithLoader(stateLoader, "topic-1");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", content: "What is 2+2?" });
    expect(messages[1]).toEqual({ role: "assistant", content: "4" });
  });

  test("loads multiple turn pairs in order", async () => {
    await saveTurnPairWithLoader(stateLoader, "topic-1", "Hello", "Hi there!");
    await saveTurnPairWithLoader(
      stateLoader,
      "topic-1",
      "How are you?",
      "I'm good.",
    );

    const messages = loadHistoryWithLoader(stateLoader, "topic-1");
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ role: "user", content: "Hello" });
    expect(messages[1]).toEqual({ role: "assistant", content: "Hi there!" });
    expect(messages[2]).toEqual({ role: "user", content: "How are you?" });
    expect(messages[3]).toEqual({ role: "assistant", content: "I'm good." });
  });

  test("respects turn pair limit", async () => {
    for (let i = 1; i <= 10; i++) {
      await saveTurnPairWithLoader(stateLoader, "topic-1", `Q${i}`, `A${i}`);
    }

    const messages = loadHistoryWithLoader(stateLoader, "topic-1", 2);
    expect(messages).toHaveLength(4);
    // Should be the 2 most recent pairs
    expect(messages[0]).toEqual({ role: "user", content: "Q9" });
    expect(messages[1]).toEqual({ role: "assistant", content: "A9" });
    expect(messages[2]).toEqual({ role: "user", content: "Q10" });
    expect(messages[3]).toEqual({ role: "assistant", content: "A10" });
  });

  test("returns empty array for topic with no history", () => {
    const messages = loadHistoryWithLoader(stateLoader, "empty-topic");
    expect(messages).toEqual([]);
  });
});

// --- Agent history (tool calling) ---

describe("saveAgentHistoryWithLoader / loadHistoryWithLoader with tool messages", () => {
  test("saves and loads agent turns with tool_calls and tool results", async () => {
    await saveAgentHistoryWithLoader(stateLoader, "topic-1", [
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

    const messages = loadHistoryWithLoader(stateLoader, "topic-1");
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

  test("loadHistoryWithLoader limit counts user messages, not total messages", async () => {
    // Group 1: user + tool_call + tool_result + final (4 messages)
    await saveAgentHistoryWithLoader(stateLoader, "topic-1", [
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
    await saveAgentHistoryWithLoader(stateLoader, "topic-1", [
      { role: "user", content: "Q2" },
      { role: "assistant", content: "A2" },
    ]);

    // Group 3: simple pair (2 messages)
    await saveAgentHistoryWithLoader(stateLoader, "topic-1", [
      { role: "user", content: "Q3" },
      { role: "assistant", content: "A3" },
    ]);

    // Limit=2 should return last 2 user groups: Q2+A2 and Q3+A3
    const messages = loadHistoryWithLoader(stateLoader, "topic-1", 2);
    expect(messages).toHaveLength(4);
    expect(messages[0].content).toBe("Q2");
    expect(messages[1].content).toBe("A2");
    expect(messages[2].content).toBe("Q3");
    expect(messages[3].content).toBe("A3");
  });

  test("saveAgentTurns stores in atomic transaction", async () => {
    await saveAgentTurns(stateLoader, "topic-1", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "Bye" },
      { role: "assistant", content: "Goodbye" },
    ]);

    const turns = loadRecentTurns(stateLoader, "topic-1");
    expect(turns).toHaveLength(4);
    expect(turns[0].content).toBe("Hello");
    expect(turns[3].content).toBe("Goodbye");
  });
});
