import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, initDatabase } from "../src/db";
import type { BuiltinToolContext } from "../src/tools";
import { createTopicTools } from "../src/tools/topics";
import { createTopic, getTopicByKey, listTopics } from "../src/topics/index";

/** Helper to get a tool by name from the topic tools */
function getTool(name: string) {
  const tools = createTopicTools();
  const tool = tools.find((t) => t.definition.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

// --- topics_create ---

describe("topics_create tool", () => {
  test("creates topic and returns JSON", async () => {
    const tool = getTool("topics_create");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(
      JSON.stringify({
        key: "my-topic",
        name: "My Topic",
        description: "A test topic",
      }),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = JSON.parse(result.value.content);
      expect(data.key).toBe("my-topic");
      expect(data.name).toBe("My Topic");
      expect(data.description).toBe("A test topic");
      expect(data.status).toBe("active");
      expect(data.id).toBeTruthy();
    }

    // Verify in database
    const topic = getTopicByKey("my-topic");
    expect(topic).not.toBeNull();
    expect(topic!.name).toBe("My Topic");
  });

  test("creates topic with telegram_thread_id", async () => {
    const tool = getTool("topics_create");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(
      JSON.stringify({
        key: "telegram-topic",
        telegram_thread_id: 12345,
      }),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = JSON.parse(result.value.content);
      expect(data.telegram_thread_id).toBe(12345);
    }
  });

  test("uses key as name when name not provided", async () => {
    const tool = getTool("topics_create");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(
      JSON.stringify({ key: "key-as-name" }),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = JSON.parse(result.value.content);
      expect(data.name).toBe("key-as-name");
    }
  });

  test("fails when key is missing", async () => {
    const tool = getTool("topics_create");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(
      JSON.stringify({ name: "No Key Topic" }),
      ctx,
    );

    expect(result.ok).toBe(false);
  });

  test("fails when key is empty string", async () => {
    const tool = getTool("topics_create");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(JSON.stringify({ key: "" }), ctx);

    expect(result.ok).toBe(false);
  });
});

// --- topics_list ---

describe("topics_list tool", () => {
  test("returns all topics when no filter", async () => {
    createTopic({ key: "topic-1", name: "Topic 1" });
    createTopic({ key: "topic-2", name: "Topic 2" });

    const tool = getTool("topics_list");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(JSON.stringify({}), ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const topics = JSON.parse(result.value.content);
      expect(topics).toHaveLength(2);
    }
  });

  test("returns filtered results by status", async () => {
    const topic1 = createTopic({ key: "active-topic", name: "Active" });
    const topic2 = createTopic({ key: "completed-topic", name: "Completed" });

    // Update one to completed status
    const { updateTopic } = await import("../src/topics/index");
    updateTopic(topic2.id, { status: "completed" });

    const tool = getTool("topics_list");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const activeResult = await tool.execute(
      JSON.stringify({ status: "active" }),
      ctx,
    );
    expect(activeResult.ok).toBe(true);
    if (activeResult.ok) {
      const topics = JSON.parse(activeResult.value.content);
      expect(topics).toHaveLength(1);
      expect(topics[0].key).toBe("active-topic");
    }

    const completedResult = await tool.execute(
      JSON.stringify({ status: "completed" }),
      ctx,
    );
    expect(completedResult.ok).toBe(true);
    if (completedResult.ok) {
      const topics = JSON.parse(completedResult.value.content);
      expect(topics).toHaveLength(1);
      expect(topics[0].key).toBe("completed-topic");
    }
  });

  test("returns empty array when no topics match filter", async () => {
    createTopic({ key: "active-only", name: "Active Only" });

    const tool = getTool("topics_list");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(
      JSON.stringify({ status: "completed" }),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const topics = JSON.parse(result.value.content);
      expect(topics).toHaveLength(0);
    }
  });

  test("returns topics with created_at as ISO string", async () => {
    createTopic({ key: "iso-test", name: "ISO Test" });

    const tool = getTool("topics_list");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(JSON.stringify({}), ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const topics = JSON.parse(result.value.content);
      expect(topics[0].created_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      );
    }
  });
});

// --- topics_update ---

describe("topics_update tool", () => {
  test("modifies topic name", async () => {
    createTopic({ key: "update-test", name: "Original" });

    const tool = getTool("topics_update");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(
      JSON.stringify({ key: "update-test", name: "Updated Name" }),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = JSON.parse(result.value.content);
      expect(data.name).toBe("Updated Name");
      expect(data.message).toBe("Topic updated");
    }

    // Verify in database
    const topic = getTopicByKey("update-test");
    expect(topic!.name).toBe("Updated Name");
  });

  test("modifies topic description", async () => {
    createTopic({ key: "desc-test", name: "Desc Test" });

    const tool = getTool("topics_update");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(
      JSON.stringify({ key: "desc-test", description: "New description" }),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = JSON.parse(result.value.content);
      expect(data.description).toBe("New description");
    }
  });

  test("modifies topic status", async () => {
    createTopic({ key: "status-test", name: "Status Test" });

    const tool = getTool("topics_update");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(
      JSON.stringify({ key: "status-test", status: "archived" }),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = JSON.parse(result.value.content);
      expect(data.status).toBe("archived");
    }

    // Verify in database
    const topic = getTopicByKey("status-test");
    expect(topic!.status).toBe("archived");
  });

  test("fails when key is missing", async () => {
    const tool = getTool("topics_update");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(JSON.stringify({ name: "No Key" }), ctx);

    expect(result.ok).toBe(false);
  });

  test("fails when topic not found", async () => {
    const tool = getTool("topics_update");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(
      JSON.stringify({ key: "non-existent", name: "New Name" }),
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("topic not found");
    }
  });

  test("fails when no fields to update", async () => {
    createTopic({ key: "no-update", name: "No Update" });

    const tool = getTool("topics_update");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(
      JSON.stringify({ key: "no-update" }),
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("no fields to update");
    }
  });
});

// --- topics_close ---

describe("topics_close tool", () => {
  test("sets status to completed", async () => {
    createTopic({ key: "close-test", name: "Close Test" });

    const tool = getTool("topics_close");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(
      JSON.stringify({ key: "close-test" }),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = JSON.parse(result.value.content);
      expect(data.status).toBe("completed");
      expect(data.message).toBe("Topic closed");
    }

    // Verify in database
    const topic = getTopicByKey("close-test");
    expect(topic!.status).toBe("completed");
  });

  test("fails when key is missing", async () => {
    const tool = getTool("topics_close");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(JSON.stringify({}), ctx);

    expect(result.ok).toBe(false);
  });

  test("fails when topic not found", async () => {
    const tool = getTool("topics_close");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(
      JSON.stringify({ key: "non-existent" }),
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("topic not found");
    }
  });
});

// --- Tool registration ---

describe("topic tools registration", () => {
  test("createTopicTools returns all 4 tools", () => {
    const tools = createTopicTools();

    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.definition.name);
    expect(names).toContain("topics_create");
    expect(names).toContain("topics_list");
    expect(names).toContain("topics_update");
    expect(names).toContain("topics_close");
  });

  test("all topic tools have correct mutatesState flag", () => {
    const tools = createTopicTools();
    const toolMap = Object.fromEntries(
      tools.map((t) => [t.definition.name, t.definition.mutatesState]),
    );

    expect(toolMap.topics_create).toBe(true);
    expect(toolMap.topics_list).toBe(false);
    expect(toolMap.topics_update).toBe(true);
    expect(toolMap.topics_close).toBe(true);
  });
});
