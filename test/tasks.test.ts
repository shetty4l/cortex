import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, initDatabase } from "../src/db";
import {
  completeTask,
  createTask,
  getTask,
  listTasks,
  updateTask,
} from "../src/tasks/index";
import { createTopic } from "../src/topics/index";

let topicId: string;

beforeEach(() => {
  initDatabase(":memory:");
  const topic = createTopic({ name: "Test Topic" });
  topicId = topic.id;
});

afterEach(() => {
  closeDatabase();
});

describe("tasks CRUD", () => {
  test("createTask returns Task with generated id and timestamps", () => {
    const before = Date.now();
    const task = createTask({ topic_id: topicId, title: "Book flights" });
    const after = Date.now();

    expect(task.id).toBeTruthy();
    expect(task.topic_id).toBe(topicId);
    expect(task.title).toBe("Book flights");
    expect(task.description).toBeNull();
    expect(task.status).toBe("pending");
    expect(task.due_at).toBeNull();
    expect(task.completed_at).toBeNull();
    expect(task.created_at).toBeGreaterThanOrEqual(before);
    expect(task.created_at).toBeLessThanOrEqual(after);
    expect(task.updated_at).toBe(task.created_at);
  });

  test("getTask returns null for non-existent id", () => {
    expect(getTask("non-existent")).toBeNull();
  });

  test("getTask returns created task", () => {
    const created = createTask({ topic_id: topicId, title: "Test task" });
    const fetched = getTask(created.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.title).toBe("Test task");
  });

  test("listTasks returns all tasks", () => {
    createTask({ topic_id: topicId, title: "Task 1" });
    createTask({ topic_id: topicId, title: "Task 2" });
    createTask({ topic_id: topicId, title: "Task 3" });

    const all = listTasks();
    expect(all).toHaveLength(3);
  });

  test("listTasks filtered by topicId", () => {
    const topic2 = createTopic({ name: "Other Topic" });
    createTask({ topic_id: topicId, title: "Task A" });
    createTask({ topic_id: topic2.id, title: "Task B" });

    const filtered = listTasks({ topicId });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe("Task A");
  });

  test("listTasks filtered by status", () => {
    const t1 = createTask({ topic_id: topicId, title: "Pending" });
    const t2 = createTask({ topic_id: topicId, title: "To complete" });
    completeTask(t2.id);

    const pending = listTasks({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(t1.id);

    const completed = listTasks({ status: "completed" });
    expect(completed).toHaveLength(1);
    expect(completed[0].id).toBe(t2.id);
  });

  test("updateTask updates specified fields", () => {
    const task = createTask({
      topic_id: topicId,
      title: "Original",
      description: "Desc",
    });
    updateTask(task.id, { title: "Updated" });

    const fetched = getTask(task.id)!;
    expect(fetched.title).toBe("Updated");
    expect(fetched.description).toBe("Desc");
  });

  test("completeTask sets status to completed and sets completed_at", () => {
    const task = createTask({ topic_id: topicId, title: "Finish me" });
    expect(task.status).toBe("pending");
    expect(task.completed_at).toBeNull();

    const before = Date.now();
    completeTask(task.id);
    const after = Date.now();

    const fetched = getTask(task.id)!;
    expect(fetched.status).toBe("completed");
    expect(fetched.completed_at).toBeGreaterThanOrEqual(before);
    expect(fetched.completed_at).toBeLessThanOrEqual(after);
  });
});
