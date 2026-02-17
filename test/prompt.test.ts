import { describe, expect, test } from "bun:test";
import type { Memory } from "../src/engram";
import { buildPrompt, SYSTEM_PROMPT } from "../src/prompt";
import type { ChatMessage } from "../src/synapse";

// --- Helpers ---

function makeMemory(content: string): Memory {
  return {
    id: `m-${content.slice(0, 8)}`,
    content,
    category: "fact",
    strength: 1.0,
    relevance: 0.8,
  };
}

// --- Tests ---

describe("buildPrompt", () => {
  test("minimal prompt: system + user message only", () => {
    const messages = buildPrompt({
      memories: [],
      turns: [],
      userText: "Hello",
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe(SYSTEM_PROMPT);
    expect(messages[1]).toEqual({ role: "user", content: "Hello" });
  });

  test("includes memories in system message", () => {
    const messages = buildPrompt({
      memories: [
        makeMemory("User lives in Seattle"),
        makeMemory("User prefers dark roast coffee"),
      ],
      turns: [],
      userText: "Where do I live?",
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain(SYSTEM_PROMPT);
    expect(messages[0].content).toContain(
      "These are facts and preferences you've learned",
    );
    expect(messages[0].content).toContain("- User lives in Seattle");
    expect(messages[0].content).toContain("- User prefers dark roast coffee");
  });

  test("includes turn history between system and user message", () => {
    const turns: ChatMessage[] = [
      { role: "user", content: "My name is Shetty." },
      { role: "assistant", content: "Nice to meet you, Shetty!" },
    ];

    const messages = buildPrompt({
      memories: [],
      turns,
      userText: "What is my name?",
    });

    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe("system");
    expect(messages[1]).toEqual({
      role: "user",
      content: "My name is Shetty.",
    });
    expect(messages[2]).toEqual({
      role: "assistant",
      content: "Nice to meet you, Shetty!",
    });
    expect(messages[3]).toEqual({
      role: "user",
      content: "What is my name?",
    });
  });

  test("includes both memories and turn history", () => {
    const messages = buildPrompt({
      memories: [makeMemory("User lives in Seattle")],
      turns: [
        { role: "user", content: "Planning a trip to Japan." },
        { role: "assistant", content: "That sounds exciting!" },
      ],
      userText: "What is the time difference?",
    });

    expect(messages).toHaveLength(4);

    // System message has memory block
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("- User lives in Seattle");

    // Turn history follows
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("Planning a trip to Japan.");
    expect(messages[2].role).toBe("assistant");

    // Current message is last
    expect(messages[3]).toEqual({
      role: "user",
      content: "What is the time difference?",
    });
  });

  test("does not add memory header when memories array is empty", () => {
    const messages = buildPrompt({
      memories: [],
      turns: [],
      userText: "Hello",
    });

    expect(messages[0].content).toBe(SYSTEM_PROMPT);
    expect(messages[0].content).not.toContain("facts and preferences");
  });

  test("preserves memory content exactly", () => {
    const messages = buildPrompt({
      memories: [makeMemory("User's dog is named Koda (golden retriever)")],
      turns: [],
      userText: "Tell me about my pets.",
    });

    expect(messages[0].content).toContain(
      "- User's dog is named Koda (golden retriever)",
    );
  });

  test("handles multiple turn pairs", () => {
    const turns: ChatMessage[] = [];
    for (let i = 1; i <= 3; i++) {
      turns.push({ role: "user", content: `Q${i}` });
      turns.push({ role: "assistant", content: `A${i}` });
    }

    const messages = buildPrompt({
      memories: [],
      turns,
      userText: "Q4",
    });

    // system + 6 turns + current user = 8
    expect(messages).toHaveLength(8);
    expect(messages[1].content).toBe("Q1");
    expect(messages[6].content).toBe("A3");
    expect(messages[7].content).toBe("Q4");
  });
});
