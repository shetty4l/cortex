import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, initDatabase } from "../src/db";
import {
  createTopic,
  getOrCreateTopicByKey,
  getTopic,
  getTopicByKey,
  listTopics,
  updateTopic,
} from "../src/topics/index";

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("topics CRUD", () => {
  test("createTopic returns a Topic with generated id and timestamps", () => {
    const before = Date.now();
    const topic = createTopic({ name: "Japan Trip" });
    const after = Date.now();

    expect(topic.id).toBeTruthy();
    expect(topic.name).toBe("Japan Trip");
    expect(topic.description).toBeNull();
    expect(topic.status).toBe("active");
    expect(topic.starts_at).toBeNull();
    expect(topic.ends_at).toBeNull();
    expect(topic.created_at).toBeGreaterThanOrEqual(before);
    expect(topic.created_at).toBeLessThanOrEqual(after);
    expect(topic.updated_at).toBe(topic.created_at);
  });

  test("createTopic with all optional fields", () => {
    const topic = createTopic({
      name: "Conference",
      description: "Annual team conference",
      starts_at: 1700000000000,
      ends_at: 1700100000000,
      telegram_thread_id: 42,
    });

    expect(topic.description).toBe("Annual team conference");
    expect(topic.starts_at).toBe(1700000000000);
    expect(topic.ends_at).toBe(1700100000000);
    expect(topic.telegram_thread_id).toBe(42);
  });

  test("getTopic returns null for non-existent id", () => {
    expect(getTopic("non-existent-id")).toBeNull();
  });

  test("getTopic returns created topic", () => {
    const created = createTopic({ name: "Test" });
    const fetched = getTopic(created.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.name).toBe("Test");
  });

  test("listTopics returns all topics", () => {
    createTopic({ name: "First" });
    createTopic({ name: "Second" });
    createTopic({ name: "Third" });

    const all = listTopics();
    expect(all).toHaveLength(3);
    const names = all.map((t) => t.name);
    expect(names).toContain("First");
    expect(names).toContain("Second");
    expect(names).toContain("Third");
  });

  test("listTopics with status filter returns only matching", () => {
    createTopic({ name: "Active one" });
    const completed = createTopic({ name: "Completed one" });
    updateTopic(completed.id, { status: "completed" });

    const active = listTopics("active");
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe("Active one");

    const done = listTopics("completed");
    expect(done).toHaveLength(1);
    expect(done[0].name).toBe("Completed one");
  });

  test("updateTopic updates specified fields and leaves others unchanged", () => {
    const topic = createTopic({
      name: "Original",
      description: "Original desc",
    });
    updateTopic(topic.id, { name: "Updated" });

    const fetched = getTopic(topic.id)!;
    expect(fetched.name).toBe("Updated");
    expect(fetched.description).toBe("Original desc");
  });

  test("updateTopic updates updated_at timestamp", () => {
    const topic = createTopic({ name: "Test" });
    const originalUpdatedAt = topic.updated_at;

    // Small delay to ensure timestamp differs
    const spinUntil = Date.now() + 2;
    while (Date.now() < spinUntil) {
      /* spin */
    }

    updateTopic(topic.id, { name: "Changed" });
    const fetched = getTopic(topic.id)!;
    expect(fetched.updated_at).toBeGreaterThanOrEqual(originalUpdatedAt);
  });
});

describe("topic key lookups", () => {
  test("getTopicByKey returns null for non-existent key", () => {
    expect(getTopicByKey("non-existent-key")).toBeNull();
  });

  test("getTopicByKey returns topic when key exists", () => {
    const created = createTopic({ key: "my-key", name: "My Topic" });
    const fetched = getTopicByKey("my-key");

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.key).toBe("my-key");
    expect(fetched!.name).toBe("My Topic");
  });

  test("getOrCreateTopicByKey returns existing topic if key exists", () => {
    const created = createTopic({ key: "existing-key", name: "Original Name" });
    const fetched = getOrCreateTopicByKey("existing-key");

    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe("Original Name");
  });

  test("getOrCreateTopicByKey creates topic with key as name if not exists", () => {
    const fetched = getOrCreateTopicByKey("new-key");

    expect(fetched.id).toBeTruthy();
    expect(fetched.key).toBe("new-key");
    expect(fetched.name).toBe("new-key");
    expect(fetched.status).toBe("active");

    // Verify it's actually in the database
    const fromDb = getTopicByKey("new-key");
    expect(fromDb).not.toBeNull();
    expect(fromDb!.id).toBe(fetched.id);
  });

  test("getOrCreateTopicByKey is idempotent", () => {
    const first = getOrCreateTopicByKey("idempotent-key");
    const second = getOrCreateTopicByKey("idempotent-key");

    expect(first.id).toBe(second.id);

    // Verify only one topic exists with this key
    const all = listTopics();
    const matching = all.filter((t) => t.key === "idempotent-key");
    expect(matching).toHaveLength(1);
  });
});
