import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDatabase, initDatabase } from "../src/db";
import { StateLoader } from "../src/state";
import {
  completeTask,
  createTask,
  getTask,
  listTasks,
} from "../src/tasks/index";
import type { BuiltinToolContext } from "../src/tools";
import { createTaskTools } from "../src/tools/tasks";
import { createTopic, getTopicByKey } from "../src/topics/index";

let stateLoader: StateLoader;

/** Helper to get a tool by name from the task tools */
function getTool(name: string) {
  const tools = createTaskTools(stateLoader);
  const tool = tools.find((t) => t.definition.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

beforeEach(() => {
  initDatabase(":memory:");
  stateLoader = new StateLoader(getDatabase());
});

afterEach(async () => {
  await stateLoader.flush();
  closeDatabase();
});

// --- tasks_create ---

describe("tasks_create tool", () => {
  test("creates task with explicit topic_key", async () => {
    const tool = getTool("tasks_create");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(
      JSON.stringify({ title: "Buy groceries", topic_key: "shopping" }),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = JSON.parse(result.value.content);
      expect(data.title).toBe("Buy groceries");
      expect(data.topic_key).toBe("shopping");
      expect(data.status).toBe("pending");
      expect(data.id).toBeTruthy();
    }

    // Verify topic was auto-created
    const topic = getTopicByKey(stateLoader, "shopping");
    expect(topic).not.toBeNull();
    expect(topic!.name).toBe("shopping");
  });

  test("creates task using context topicKey when topic_key not provided", async () => {
    const tool = getTool("tasks_create");
    const ctx: BuiltinToolContext = { topicKey: "my-context-topic" };

    const result = await tool.execute(
      JSON.stringify({ title: "Do something" }),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = JSON.parse(result.value.content);
      expect(data.topic_key).toBe("my-context-topic");
    }

    // Verify topic was auto-created with context key
    const topic = getTopicByKey(stateLoader, "my-context-topic");
    expect(topic).not.toBeNull();
  });

  test("reuses existing topic when key exists", async () => {
    const existing = createTopic(stateLoader, {
      key: "existing",
      name: "Existing Topic",
    });
    const tool = getTool("tasks_create");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(
      JSON.stringify({
        title: "Task for existing topic",
        topic_key: "existing",
      }),
      ctx,
    );

    expect(result.ok).toBe(true);
    const task = listTasks(stateLoader)[0];
    expect(task.topic_id).toBe(existing.id);
  });

  test("fails when no topic_key and no context topicKey", async () => {
    const tool = getTool("tasks_create");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(
      JSON.stringify({ title: "Orphan task" }),
      ctx,
    );

    expect(result.ok).toBe(false);
  });

  test("fails when title is missing", async () => {
    const tool = getTool("tasks_create");
    const ctx: BuiltinToolContext = { topicKey: "test" };

    const result = await tool.execute(
      JSON.stringify({ topic_key: "test" }),
      ctx,
    );

    expect(result.ok).toBe(false);
  });

  test("creates task with due_at", async () => {
    const tool = getTool("tasks_create");
    const ctx: BuiltinToolContext = { topicKey: "test" };
    const dueDate = "2024-12-31T23:59:59Z";
    const expectedMs = new Date(dueDate).getTime();

    const result = await tool.execute(
      JSON.stringify({ title: "Year end task", due_at: dueDate }),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = JSON.parse(result.value.content);
      // Compare as timestamps since toISOString() may format differently
      expect(new Date(data.due_at).getTime()).toBe(expectedMs);
    }
  });
});

// --- tasks_list ---

describe("tasks_list tool", () => {
  test("lists all tasks when no filters", async () => {
    const topic = createTopic(stateLoader, {
      key: "list-test",
      name: "List Test",
    });
    const tool = getTool("tasks_list");
    const ctx: BuiltinToolContext = { topicKey: "" };

    // Create tasks via the underlying function
    createTask(stateLoader, { topic_id: topic.id, title: "Task 1" });
    createTask(stateLoader, { topic_id: topic.id, title: "Task 2" });

    const result = await tool.execute(JSON.stringify({}), ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const tasks = JSON.parse(result.value.content);
      expect(tasks).toHaveLength(2);
    }
  });

  test("filters by topic_key", async () => {
    const topic1 = createTopic(stateLoader, {
      key: "topic-a",
      name: "Topic A",
    });
    const topic2 = createTopic(stateLoader, {
      key: "topic-b",
      name: "Topic B",
    });
    createTask(stateLoader, { topic_id: topic1.id, title: "Task A" });
    createTask(stateLoader, { topic_id: topic2.id, title: "Task B" });

    const tool = getTool("tasks_list");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(
      JSON.stringify({ topic_key: "topic-a" }),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const tasks = JSON.parse(result.value.content);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe("Task A");
    }
  });

  test("filters by status", async () => {
    const topic = createTopic(stateLoader, {
      key: "status-test",
      name: "Status Test",
    });
    const t1 = createTask(stateLoader, {
      topic_id: topic.id,
      title: "Pending",
    });
    const t2 = createTask(stateLoader, { topic_id: topic.id, title: "Done" });
    await completeTask(stateLoader, t2.id);

    const tool = getTool("tasks_list");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const resultPending = await tool.execute(
      JSON.stringify({ status: "pending" }),
      ctx,
    );
    expect(resultPending.ok).toBe(true);
    if (resultPending.ok) {
      const tasks = JSON.parse(resultPending.value.content);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(t1.id);
    }

    const resultCompleted = await tool.execute(
      JSON.stringify({ status: "completed" }),
      ctx,
    );
    expect(resultCompleted.ok).toBe(true);
    if (resultCompleted.ok) {
      const tasks = JSON.parse(resultCompleted.value.content);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(t2.id);
    }
  });

  test("returns empty array for non-existent topic_key", async () => {
    const tool = getTool("tasks_list");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(
      JSON.stringify({ topic_key: "non-existent" }),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const tasks = JSON.parse(result.value.content);
      expect(tasks).toHaveLength(0);
    }
  });
});

// --- tasks_complete ---

describe("tasks_complete tool", () => {
  test("marks task as completed", async () => {
    const topic = createTopic(stateLoader, {
      key: "complete-test",
      name: "Complete Test",
    });
    const task = createTask(stateLoader, {
      topic_id: topic.id,
      title: "To complete",
    });

    const tool = getTool("tasks_complete");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(JSON.stringify({ id: task.id }), ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = JSON.parse(result.value.content);
      expect(data.id).toBe(task.id);
      expect(data.status).toBe("completed");
    }

    // Verify in database
    const fetched = getTask(stateLoader, task.id);
    expect(fetched!.status).toBe("completed");
    expect(fetched!.completed_at).not.toBeNull();
  });

  test("fails for non-existent task", async () => {
    const tool = getTool("tasks_complete");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(
      JSON.stringify({ id: "non-existent-id" }),
      ctx,
    );

    expect(result.ok).toBe(false);
  });

  test("fails when id is missing", async () => {
    const tool = getTool("tasks_complete");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(JSON.stringify({}), ctx);

    expect(result.ok).toBe(false);
  });
});

// --- tasks_update ---

describe("tasks_update tool", () => {
  test("updates task title", async () => {
    const topic = createTopic(stateLoader, {
      key: "update-test",
      name: "Update Test",
    });
    const task = createTask(stateLoader, {
      topic_id: topic.id,
      title: "Original",
    });

    const tool = getTool("tasks_update");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(
      JSON.stringify({ id: task.id, title: "Updated" }),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = JSON.parse(result.value.content);
      expect(data.title).toBe("Updated");
    }

    // Verify in database
    const fetched = getTask(stateLoader, task.id);
    expect(fetched!.title).toBe("Updated");
  });

  test("updates task status", async () => {
    const topic = createTopic(stateLoader, {
      key: "status-update",
      name: "Status Update",
    });
    const task = createTask(stateLoader, {
      topic_id: topic.id,
      title: "Status task",
    });

    const tool = getTool("tasks_update");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(
      JSON.stringify({ id: task.id, status: "in_progress" }),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = JSON.parse(result.value.content);
      expect(data.status).toBe("in_progress");
    }
  });

  test("updates task due_at", async () => {
    const topic = createTopic(stateLoader, {
      key: "due-update",
      name: "Due Update",
    });
    const task = createTask(stateLoader, {
      topic_id: topic.id,
      title: "Due task",
    });

    const tool = getTool("tasks_update");
    const ctx: BuiltinToolContext = { topicKey: "" };
    const newDue = "2025-06-15T12:00:00Z";
    const expectedMs = new Date(newDue).getTime();

    const result = await tool.execute(
      JSON.stringify({ id: task.id, due_at: newDue }),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = JSON.parse(result.value.content);
      // Compare as timestamps since toISOString() may format differently
      expect(new Date(data.due_at).getTime()).toBe(expectedMs);
    }
  });

  test("fails for non-existent task", async () => {
    const tool = getTool("tasks_update");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(
      JSON.stringify({ id: "non-existent", title: "New" }),
      ctx,
    );

    expect(result.ok).toBe(false);
  });

  test("fails when id is missing", async () => {
    const tool = getTool("tasks_update");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(JSON.stringify({ title: "New" }), ctx);

    expect(result.ok).toBe(false);
  });

  test("fails when no fields to update", async () => {
    const topic = createTopic(stateLoader, {
      key: "no-update",
      name: "No Update",
    });
    const task = createTask(stateLoader, {
      topic_id: topic.id,
      title: "No change",
    });

    const tool = getTool("tasks_update");
    const ctx: BuiltinToolContext = { topicKey: "" };

    const result = await tool.execute(JSON.stringify({ id: task.id }), ctx);

    expect(result.ok).toBe(false);
  });
});

// --- Tool registration ---

describe("task tools registration", () => {
  test("createTaskTools returns all 4 tools", () => {
    const tools = createTaskTools(stateLoader);

    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.definition.name);
    expect(names).toContain("tasks_create");
    expect(names).toContain("tasks_list");
    expect(names).toContain("tasks_complete");
    expect(names).toContain("tasks_update");
  });

  test("all task tools have correct mutatesState flag", () => {
    const tools = createTaskTools(stateLoader);
    const toolMap = Object.fromEntries(
      tools.map((t) => [t.definition.name, t.definition.mutatesState]),
    );

    expect(toolMap.tasks_create).toBe(true);
    expect(toolMap.tasks_list).toBe(false);
    expect(toolMap.tasks_complete).toBe(true);
    expect(toolMap.tasks_update).toBe(true);
  });
});
