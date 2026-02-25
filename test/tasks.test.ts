import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDatabase, initDatabase } from "../src/db";
import { StateLoader } from "../src/state";
import {
  completeTask,
  createTask,
  getTask,
  listTasks,
  updateTask,
} from "../src/tasks/index";
import { createTopic } from "../src/topics/index";

let stateLoader: StateLoader;
let topicId: string;

beforeEach(() => {
  initDatabase(":memory:");
  stateLoader = new StateLoader(getDatabase());
  const topic = createTopic(stateLoader, { name: "Test Topic" });
  topicId = topic.id;
});

afterEach(async () => {
  await stateLoader.flush();
  closeDatabase();
});

describe("tasks CRUD", () => {
  test("createTask returns Task with generated id and timestamps", () => {
    const task = createTask(stateLoader, {
      topic_id: topicId,
      title: "Book flights",
    });

    expect(task.id).toBeTruthy();
    expect(task.topic_id).toBe(topicId);
    expect(task.title).toBe("Book flights");
    expect(task.description).toBeNull();
    expect(task.status).toBe("pending");
    expect(task.due_at).toBeNull();
    expect(task.completed_at).toBeNull();
  });

  test("getTask returns null for non-existent id", () => {
    expect(getTask(stateLoader, "non-existent")).toBeNull();
  });

  test("getTask returns created task", () => {
    const created = createTask(stateLoader, {
      topic_id: topicId,
      title: "Test task",
    });
    const fetched = getTask(stateLoader, created.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.title).toBe("Test task");
  });

  test("listTasks returns all tasks", () => {
    createTask(stateLoader, { topic_id: topicId, title: "Task 1" });
    createTask(stateLoader, { topic_id: topicId, title: "Task 2" });
    createTask(stateLoader, { topic_id: topicId, title: "Task 3" });

    const all = listTasks(stateLoader);
    expect(all).toHaveLength(3);
  });

  test("listTasks filtered by topicId", () => {
    const topic2 = createTopic(stateLoader, { name: "Other Topic" });
    createTask(stateLoader, { topic_id: topicId, title: "Task A" });
    createTask(stateLoader, { topic_id: topic2.id, title: "Task B" });

    const filtered = listTasks(stateLoader, { topicId });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe("Task A");
  });

  test("listTasks filtered by status", async () => {
    const t1 = createTask(stateLoader, {
      topic_id: topicId,
      title: "Pending",
    });
    const t2 = createTask(stateLoader, {
      topic_id: topicId,
      title: "To complete",
    });
    await completeTask(stateLoader, t2.id);

    const pending = listTasks(stateLoader, { status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(t1.id);

    const completed = listTasks(stateLoader, { status: "completed" });
    expect(completed).toHaveLength(1);
    expect(completed[0].id).toBe(t2.id);
  });

  test("updateTask updates specified fields", async () => {
    const task = createTask(stateLoader, {
      topic_id: topicId,
      title: "Original",
      description: "Desc",
    });
    await updateTask(stateLoader, task.id, { title: "Updated" });

    const fetched = getTask(stateLoader, task.id)!;
    expect(fetched.title).toBe("Updated");
    expect(fetched.description).toBe("Desc");
  });

  test("completeTask sets status to completed and sets completed_at", async () => {
    const task = createTask(stateLoader, {
      topic_id: topicId,
      title: "Finish me",
    });
    expect(task.status).toBe("pending");
    expect(task.completed_at).toBeNull();

    const before = Date.now();
    await completeTask(stateLoader, task.id);
    const after = Date.now();

    const fetched = getTask(stateLoader, task.id)!;
    expect(fetched.status).toBe("completed");
    expect(fetched.completed_at).toBeGreaterThanOrEqual(before);
    expect(fetched.completed_at).toBeLessThanOrEqual(after);
  });
});
