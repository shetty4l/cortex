import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Memory } from "../src/engram";
import {
  buildPrompt,
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  loadAndRenderSystemPrompt,
} from "../src/prompt";
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

function defaultSystemPrompt(toolNames: string[] = []): string {
  return loadAndRenderSystemPrompt({ toolNames });
}

// --- Temp dir for file tests ---

const TEST_DIR = join(tmpdir(), `cortex-prompt-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// --- loadAndRenderSystemPrompt ---

describe("loadAndRenderSystemPrompt", () => {
  test("uses default template when no path is set", () => {
    const prompt = loadAndRenderSystemPrompt({ toolNames: [] });
    expect(prompt).toContain("personal life assistant");
    expect(prompt).toContain("only have conversations");
  });

  test("renders toolNames into default template", () => {
    const prompt = loadAndRenderSystemPrompt({
      toolNames: ["calendar.read", "schedule.create"],
    });
    expect(prompt).toContain("calendar.read, schedule.create");
    expect(prompt).not.toContain("only have conversations");
  });

  test("renders no-tools conditional when toolNames is empty", () => {
    const prompt = loadAndRenderSystemPrompt({ toolNames: [] });
    expect(prompt).toContain("only have conversations");
    expect(prompt).not.toContain("You have access to these tools");
  });

  test("reads template from file when it exists", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const filePath = join(TEST_DIR, "prompt.md");
    writeFileSync(filePath, "I am {{name}}.", "utf-8");

    // toolNames not used in this custom template, but still passed
    const prompt = loadAndRenderSystemPrompt({
      templatePath: filePath,
      toolNames: [],
    });
    // {{name}} is not in vars, so it becomes empty string
    expect(prompt).toBe("I am .");
  });

  test("writes default template when file does not exist", () => {
    const filePath = join(TEST_DIR, "subdir", "prompt.md");
    expect(existsSync(filePath)).toBe(false);

    const prompt = loadAndRenderSystemPrompt({
      templatePath: filePath,
      toolNames: [],
    });

    // File should now exist
    expect(existsSync(filePath)).toBe(true);
    // Prompt should be the rendered default
    expect(prompt).toContain("personal life assistant");
  });

  test("renders custom template with toolNames", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const filePath = join(TEST_DIR, "prompt.md");
    writeFileSync(
      filePath,
      "{{#if toolNames}}Tools: {{toolNames}}{{else}}Chat only{{/if}}",
      "utf-8",
    );

    const withTools = loadAndRenderSystemPrompt({
      templatePath: filePath,
      toolNames: ["echo.say"],
    });
    expect(withTools).toBe("Tools: echo.say");

    const noTools = loadAndRenderSystemPrompt({
      templatePath: filePath,
      toolNames: [],
    });
    expect(noTools).toBe("Chat only");
  });

  test("includes memory and formatting instructions in default", () => {
    const prompt = loadAndRenderSystemPrompt({ toolNames: [] });
    expect(prompt).toContain("do not guess");
    expect(prompt).toContain("Keep responses concise");
  });
});

// --- buildPrompt ---

describe("buildPrompt", () => {
  test("minimal prompt: system + user message only", () => {
    const messages = buildPrompt({
      systemPrompt: defaultSystemPrompt(),
      memories: [],
      turns: [],
      userText: "Hello",
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("personal life assistant");
    expect(messages[0].content).toContain("only have conversations");
    expect(messages[1]).toEqual({ role: "user", content: "Hello" });
  });

  test("includes memories in system message", () => {
    const messages = buildPrompt({
      systemPrompt: defaultSystemPrompt(),
      memories: [
        makeMemory("User lives in Seattle"),
        makeMemory("User prefers dark roast coffee"),
      ],
      turns: [],
      userText: "Where do I live?",
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("What you know about the user");
    expect(messages[0].content).toContain("- User lives in Seattle");
    expect(messages[0].content).toContain("- User prefers dark roast coffee");
  });

  test("includes turn history between system and user message", () => {
    const turns: ChatMessage[] = [
      { role: "user", content: "My name is Shetty." },
      { role: "assistant", content: "Nice to meet you, Shetty!" },
    ];

    const messages = buildPrompt({
      systemPrompt: defaultSystemPrompt(),
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
      systemPrompt: defaultSystemPrompt(),
      memories: [makeMemory("User lives in Seattle")],
      turns: [
        { role: "user", content: "Planning a trip to Japan." },
        { role: "assistant", content: "That sounds exciting!" },
      ],
      userText: "What is the time difference?",
    });

    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("- User lives in Seattle");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("Planning a trip to Japan.");
    expect(messages[2].role).toBe("assistant");
    expect(messages[3]).toEqual({
      role: "user",
      content: "What is the time difference?",
    });
  });

  test("does not add memory header when memories array is empty", () => {
    const messages = buildPrompt({
      systemPrompt: defaultSystemPrompt(),
      memories: [],
      turns: [],
      userText: "Hello",
    });

    expect(messages[0].content).not.toContain("What you know about the user");
  });

  test("preserves memory content exactly", () => {
    const messages = buildPrompt({
      systemPrompt: defaultSystemPrompt(),
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
      systemPrompt: defaultSystemPrompt(),
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

  test("includes topic summary in system message", () => {
    const messages = buildPrompt({
      systemPrompt: defaultSystemPrompt(),
      memories: [],
      topicSummary: "Planning a trip to Japan in March.",
      turns: [],
      userText: "What about hotels?",
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain("Current conversation context:");
    expect(messages[0].content).toContain("Planning a trip to Japan in March.");
  });

  test("topic summary appears after memories in system message", () => {
    const messages = buildPrompt({
      systemPrompt: defaultSystemPrompt(),
      memories: [makeMemory("User lives in Seattle")],
      topicSummary: "Discussing flight options to Tokyo.",
      turns: [],
      userText: "Any direct flights?",
    });

    const system = messages[0].content;
    const memoryPos = system.indexOf("User lives in Seattle");
    const summaryPos = system.indexOf("Discussing flight options");
    expect(memoryPos).toBeGreaterThan(-1);
    expect(summaryPos).toBeGreaterThan(memoryPos);
  });

  test("does not add summary header when topicSummary is null", () => {
    const messages = buildPrompt({
      systemPrompt: defaultSystemPrompt(),
      memories: [],
      topicSummary: null,
      turns: [],
      userText: "Hello",
    });

    expect(messages[0].content).not.toContain("Current conversation context");
  });

  test("does not add summary header when topicSummary is undefined", () => {
    const messages = buildPrompt({
      systemPrompt: defaultSystemPrompt(),
      memories: [],
      turns: [],
      userText: "Hello",
    });

    expect(messages[0].content).not.toContain("Current conversation context");
  });

  test("includes memories, summary, and turns in correct order", () => {
    const messages = buildPrompt({
      systemPrompt: defaultSystemPrompt(),
      memories: [makeMemory("User likes TypeScript")],
      topicSummary: "Refactoring a Node.js service.",
      turns: [
        { role: "user", content: "Should I use classes?" },
        { role: "assistant", content: "It depends on the use case." },
      ],
      userText: "What about interfaces?",
    });

    // system + 2 turns + current user = 4
    expect(messages).toHaveLength(4);

    const system = messages[0].content;
    expect(system).toContain("User likes TypeScript");
    expect(system).toContain("Refactoring a Node.js service.");

    expect(messages[1].content).toBe("Should I use classes?");
    expect(messages[2].content).toBe("It depends on the use case.");
    expect(messages[3].content).toBe("What about interfaces?");
  });

  test("preserves tool_calls, tool_call_id, and name on history turns", () => {
    const messages = buildPrompt({
      systemPrompt: defaultSystemPrompt(),
      memories: [],
      turns: [
        { role: "user", content: "Greet Watson" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "echo.say", arguments: '{"text":"hi"}' },
            },
          ],
        },
        {
          role: "tool",
          content: "hi",
          tool_call_id: "call_1",
          name: "echo.say",
        },
        { role: "assistant", content: "The echo says hi" },
      ],
      userText: "Do it again",
    });

    // system + 4 history turns + current user = 6
    expect(messages).toHaveLength(6);

    // Assistant with tool_calls
    const assistantWithTools = messages[2];
    expect(assistantWithTools.role).toBe("assistant");
    expect(assistantWithTools.tool_calls).toHaveLength(1);
    expect(assistantWithTools.tool_calls![0].id).toBe("call_1");

    // Tool result with tool_call_id and name
    const toolResult = messages[3];
    expect(toolResult.role).toBe("tool");
    expect(toolResult.tool_call_id).toBe("call_1");
    expect(toolResult.name).toBe("echo.say");
    expect(toolResult.content).toBe("hi");

    // Final assistant — no tool fields
    const finalAssistant = messages[4];
    expect(finalAssistant.role).toBe("assistant");
    expect(finalAssistant.tool_calls).toBeUndefined();
    expect(finalAssistant.tool_call_id).toBeUndefined();
  });

  test("uses provided systemPrompt string directly", () => {
    const messages = buildPrompt({
      systemPrompt: "Custom persona prompt.",
      memories: [],
      turns: [],
      userText: "Hello",
    });

    expect(messages[0].content).toBe("Custom persona prompt.");
  });
});
