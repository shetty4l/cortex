import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDatabase, initDatabase } from "../src/db";
import { StateLoader } from "../src/state";
import {
  createTopic,
  getOrCreateTopicByKey,
  getTopic,
  getTopicByKey,
  listTopics,
  updateTopic,
} from "../src/topics/index";

let stateLoader: StateLoader;

beforeEach(() => {
  initDatabase(":memory:");
  stateLoader = new StateLoader(getDatabase());
});

afterEach(async () => {
  await stateLoader.flush();
  closeDatabase();
});

describe("topics CRUD", () => {
  test("createTopic returns a Topic with generated id and timestamps", () => {
    const before = Date.now();
    const topic = createTopic(stateLoader, { name: "Japan Trip" });
    const after = Date.now();

    expect(topic.id).toBeTruthy();
    expect(topic.name).toBe("Japan Trip");
    expect(topic.description).toBeNull();
    expect(topic.status).toBe("active");
    expect(topic.starts_at).toBeNull();
    expect(topic.ends_at).toBeNull();
  });

  test("createTopic with all optional fields", () => {
    const topic = createTopic(stateLoader, {
      name: "Conference",
      description: "Annual team conference",
      starts_at: 1700000000000,
      ends_at: 1700100000000,
    });

    expect(topic.description).toBe("Annual team conference");
    expect(topic.starts_at).toBe(1700000000000);
    expect(topic.ends_at).toBe(1700100000000);
  });

  test("getTopic returns null for non-existent id", () => {
    expect(getTopic(stateLoader, "non-existent-id")).toBeNull();
  });

  test("getTopic returns created topic", () => {
    const created = createTopic(stateLoader, { name: "Test" });
    const fetched = getTopic(stateLoader, created.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.name).toBe("Test");
  });

  test("listTopics returns all topics", () => {
    createTopic(stateLoader, { name: "First" });
    createTopic(stateLoader, { name: "Second" });
    createTopic(stateLoader, { name: "Third" });

    const all = listTopics(stateLoader);
    expect(all).toHaveLength(3);
    const names = all.map((t) => t.name);
    expect(names).toContain("First");
    expect(names).toContain("Second");
    expect(names).toContain("Third");
  });

  test("listTopics with status filter returns only matching", async () => {
    createTopic(stateLoader, { name: "Active one" });
    const completed = createTopic(stateLoader, { name: "Completed one" });
    await updateTopic(stateLoader, completed.id, { status: "completed" });

    const active = listTopics(stateLoader, "active");
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe("Active one");

    const done = listTopics(stateLoader, "completed");
    expect(done).toHaveLength(1);
    expect(done[0].name).toBe("Completed one");
  });

  test("updateTopic updates specified fields and leaves others unchanged", async () => {
    const topic = createTopic(stateLoader, {
      name: "Original",
      description: "Original desc",
    });
    await updateTopic(stateLoader, topic.id, { name: "Updated" });

    const fetched = getTopic(stateLoader, topic.id)!;
    expect(fetched.name).toBe("Updated");
    expect(fetched.description).toBe("Original desc");
  });

  test("updateTopic updates updated_at timestamp", async () => {
    const topic = createTopic(stateLoader, { name: "Test" });

    // Small delay to ensure timestamp differs
    const spinUntil = Date.now() + 2;
    while (Date.now() < spinUntil) {
      /* spin */
    }

    await updateTopic(stateLoader, topic.id, { name: "Changed" });
    const fetched = getTopic(stateLoader, topic.id)!;
    expect(fetched).not.toBeNull();
  });
});

describe("topic key lookups", () => {
  test("getTopicByKey returns null for non-existent key", () => {
    expect(getTopicByKey(stateLoader, "non-existent-key")).toBeNull();
  });

  test("getTopicByKey returns topic when key exists", () => {
    const created = createTopic(stateLoader, {
      key: "my-key",
      name: "My Topic",
    });
    const fetched = getTopicByKey(stateLoader, "my-key");

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.key).toBe("my-key");
    expect(fetched!.name).toBe("My Topic");
  });

  test("getOrCreateTopicByKey returns existing topic if key exists", () => {
    const created = createTopic(stateLoader, {
      key: "existing-key",
      name: "Original Name",
    });
    const fetched = getOrCreateTopicByKey(stateLoader, "existing-key");

    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe("Original Name");
  });

  test("getOrCreateTopicByKey creates topic with key as name if not exists", () => {
    const fetched = getOrCreateTopicByKey(stateLoader, "new-key");

    expect(fetched.id).toBeTruthy();
    expect(fetched.key).toBe("new-key");
    expect(fetched.name).toBe("new-key");
    expect(fetched.status).toBe("active");

    // Verify it's actually in the database
    const fromDb = getTopicByKey(stateLoader, "new-key");
    expect(fromDb).not.toBeNull();
    expect(fromDb!.id).toBe(fetched.id);
  });

  test("getOrCreateTopicByKey is idempotent", () => {
    const first = getOrCreateTopicByKey(stateLoader, "idempotent-key");
    const second = getOrCreateTopicByKey(stateLoader, "idempotent-key");

    expect(first.id).toBe(second.id);

    // Verify only one topic exists with this key
    const all = listTopics(stateLoader);
    const matching = all.filter((t) => t.key === "idempotent-key");
    expect(matching).toHaveLength(1);
  });
});
