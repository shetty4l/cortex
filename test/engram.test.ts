import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Memory } from "../src/engram";
import { recall, recallDual, remember } from "../src/engram";

// --- Mock Engram server ---

let mockServer: ReturnType<typeof Bun.serve>;
let mockUrl: string;
let mockHandler: (req: Request) => Response | Promise<Response>;

beforeAll(() => {
  mockHandler = () =>
    Response.json({ error: "no mock configured" }, { status: 500 });

  mockServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      return mockHandler(req);
    },
  });

  mockUrl = `http://127.0.0.1:${mockServer.port}`;
});

afterAll(() => {
  mockServer.stop(true);
});

// --- Helpers ---

function makeMemory(id: string, content: string): Memory {
  return {
    id,
    content,
    category: "fact",
    strength: 1.0,
    relevance: 0.8,
  };
}

function recallResponse(memories: Memory[]): object {
  return { memories, fallback_mode: false };
}

// --- recall() tests ---

describe("recall", () => {
  test("parses a successful recall response", async () => {
    const mem = makeMemory("m1", "User likes dark roast coffee");
    mockHandler = () => Response.json(recallResponse([mem]));

    const result = await recall("coffee preference", mockUrl);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0].id).toBe("m1");
    expect(result.value[0].content).toBe("User likes dark roast coffee");
  });

  test("sends correct request shape", async () => {
    let capturedBody: Record<string, unknown> = {};
    let capturedPath: string | undefined;

    mockHandler = async (req) => {
      capturedPath = new URL(req.url).pathname;
      capturedBody = (await req.json()) as Record<string, unknown>;
      return Response.json(recallResponse([]));
    };

    await recall("test query", mockUrl, { limit: 5, scopeId: "topic:123" });

    expect(capturedPath).toBe("/recall");
    expect(capturedBody.query).toBe("test query");
    expect(capturedBody.limit).toBe(5);
    expect(capturedBody.scope_id).toBe("topic:123");
  });

  test("omits optional fields when not provided", async () => {
    let capturedBody: Record<string, unknown> = {};

    mockHandler = async (req) => {
      capturedBody = (await req.json()) as Record<string, unknown>;
      return Response.json(recallResponse([]));
    };

    await recall("test query", mockUrl);

    expect(capturedBody.query).toBe("test query");
    expect(capturedBody).not.toHaveProperty("limit");
    expect(capturedBody).not.toHaveProperty("scope_id");
  });

  test("returns empty array on connection failure (graceful)", async () => {
    const result = await recall("test", "http://127.0.0.1:1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  test("returns empty array on non-200 response (graceful)", async () => {
    mockHandler = () =>
      Response.json({ error: "internal error" }, { status: 500 });

    const result = await recall("test", mockUrl);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  test("returns error on invalid JSON response", async () => {
    mockHandler = () => new Response("not json", { status: 200 });

    const result = await recall("test", mockUrl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("invalid JSON");
  });

  test("returns error on missing memories array", async () => {
    mockHandler = () => Response.json({ something: "else" });

    const result = await recall("test", mockUrl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("missing memories");
  });

  test("returns empty array on timeout (graceful)", async () => {
    mockHandler = async () => {
      await Bun.sleep(5_000);
      return Response.json(recallResponse([]));
    };

    const result = await recall("test", mockUrl);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  }, 10_000);

  test("handles empty memories array", async () => {
    mockHandler = () => Response.json(recallResponse([]));

    const result = await recall("obscure query", mockUrl);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});

// --- recallDual() tests ---

describe("recallDual", () => {
  test("merges topic and global memories", async () => {
    const topicMem = makeMemory("t1", "Topic memory");
    const globalMem = makeMemory("g1", "Global memory");

    mockHandler = async (req) => {
      const body = (await req.json()) as { scope_id?: string };
      if (body.scope_id) {
        return Response.json(recallResponse([topicMem]));
      }
      return Response.json(recallResponse([globalMem]));
    };

    const result = await recallDual("test", "my-topic", mockUrl);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("t1");
    expect(result[1].id).toBe("g1");
  });

  test("deduplicates by memory ID (topic takes precedence)", async () => {
    const shared = makeMemory("shared-1", "Appears in both");

    mockHandler = () => Response.json(recallResponse([shared]));

    const result = await recallDual("test", "my-topic", mockUrl);

    // Same memory returned by both calls, should appear only once
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("shared-1");
  });

  test("backfills from global when topic returns fewer than 4", async () => {
    const topicMems = [makeMemory("t1", "Topic 1")];
    const globalMems = [
      makeMemory("g1", "Global 1"),
      makeMemory("g2", "Global 2"),
      makeMemory("g3", "Global 3"),
      makeMemory("g4", "Global 4"),
    ];

    mockHandler = async (req) => {
      const body = (await req.json()) as { scope_id?: string };
      if (body.scope_id) {
        return Response.json(recallResponse(topicMems));
      }
      return Response.json(recallResponse(globalMems));
    };

    const result = await recallDual("test", "my-topic", mockUrl);

    // 1 topic + 4 global = 5 (under 8 max)
    expect(result).toHaveLength(5);
    expect(result[0].id).toBe("t1");
    expect(result[1].id).toBe("g1");
  });

  test("caps total at 8 memories", async () => {
    const topicMems = Array.from({ length: 4 }, (_, i) =>
      makeMemory(`t${i + 1}`, `Topic ${i + 1}`),
    );
    const globalMems = Array.from({ length: 4 }, (_, i) =>
      makeMemory(`g${i + 1}`, `Global ${i + 1}`),
    );

    mockHandler = async (req) => {
      const body = (await req.json()) as { scope_id?: string };
      if (body.scope_id) {
        return Response.json(recallResponse(topicMems));
      }
      return Response.json(recallResponse(globalMems));
    };

    const result = await recallDual("test", "my-topic", mockUrl);

    expect(result).toHaveLength(8);
    // First 4 are topic, next 4 are global
    expect(result.slice(0, 4).map((m) => m.id)).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
    ]);
    expect(result.slice(4).map((m) => m.id)).toEqual(["g1", "g2", "g3", "g4"]);
  });

  test("sends correct scope_id for topic call and none for global", async () => {
    const calls: Array<{ scope_id?: string; limit?: number }> = [];

    mockHandler = async (req) => {
      const body = (await req.json()) as {
        scope_id?: string;
        limit?: number;
      };
      calls.push({ scope_id: body.scope_id, limit: body.limit });
      return Response.json(recallResponse([]));
    };

    await recallDual("test query", "topic:abc", mockUrl);

    expect(calls).toHaveLength(2);

    // One call has scope_id, one doesn't
    const scoped = calls.find((c) => c.scope_id !== undefined);
    const global = calls.find((c) => c.scope_id === undefined);

    expect(scoped).toBeDefined();
    expect(scoped!.scope_id).toBe("topic:abc");
    expect(scoped!.limit).toBe(4);

    expect(global).toBeDefined();
    expect(global!.limit).toBe(4);
  });

  test("returns topic memories when global fails", async () => {
    let callCount = 0;

    mockHandler = async (req) => {
      callCount++;
      const body = (await req.json()) as { scope_id?: string };
      if (body.scope_id) {
        return Response.json(
          recallResponse([makeMemory("t1", "Topic memory")]),
        );
      }
      // Global call fails
      return Response.json({ error: "boom" }, { status: 500 });
    };

    const result = await recallDual("test", "my-topic", mockUrl);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t1");
  });

  test("returns global memories when topic fails", async () => {
    mockHandler = async (req) => {
      const body = (await req.json()) as { scope_id?: string };
      if (body.scope_id) {
        return Response.json({ error: "boom" }, { status: 500 });
      }
      return Response.json(recallResponse([makeMemory("g1", "Global memory")]));
    };

    const result = await recallDual("test", "my-topic", mockUrl);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("g1");
  });

  test("returns empty when both calls fail", async () => {
    mockHandler = () => Response.json({ error: "boom" }, { status: 500 });

    const result = await recallDual("test", "my-topic", mockUrl);

    expect(result).toEqual([]);
  });
});

// --- remember() tests ---

describe("remember", () => {
  test("sends correct request shape with upsert", async () => {
    let capturedBody: Record<string, unknown> = {};
    let capturedPath: string | undefined;

    mockHandler = async (req) => {
      capturedPath = new URL(req.url).pathname;
      capturedBody = (await req.json()) as Record<string, unknown>;
      return Response.json({ id: "mem-1", status: "created" });
    };

    await remember(
      {
        content: "User prefers dark roast coffee",
        category: "preference",
        scopeId: "topic:abc",
        idempotencyKey: "cortex:extract:abc123",
        upsert: true,
      },
      mockUrl,
    );

    expect(capturedPath).toBe("/remember");
    expect(capturedBody.content).toBe("User prefers dark roast coffee");
    expect(capturedBody.category).toBe("preference");
    expect(capturedBody.scope_id).toBe("topic:abc");
    expect(capturedBody.idempotency_key).toBe("cortex:extract:abc123");
    expect(capturedBody.upsert).toBe(true);
  });

  test("returns ok with output on success", async () => {
    mockHandler = () => Response.json({ id: "mem-42", status: "created" });

    const result = await remember({ content: "A fact" }, mockUrl);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
    expect(result.value!.id).toBe("mem-42");
    expect(result.value!.status).toBe("created");
  });

  test("returns ok(null) on connection failure (graceful)", async () => {
    const result = await remember({ content: "A fact" }, "http://127.0.0.1:1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  test("returns ok(null) on 400 error (graceful)", async () => {
    mockHandler = () =>
      Response.json({ error: "content is required" }, { status: 400 });

    const result = await remember({ content: "A fact" }, mockUrl);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  test("returns ok(null) on timeout (graceful)", async () => {
    mockHandler = async () => {
      await Bun.sleep(5_000);
      return Response.json({ id: "mem-1", status: "created" });
    };

    const result = await remember({ content: "A fact" }, mockUrl);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  }, 10_000);

  test("omits optional fields when not provided", async () => {
    let capturedBody: Record<string, unknown> = {};

    mockHandler = async (req) => {
      capturedBody = (await req.json()) as Record<string, unknown>;
      return Response.json({ id: "mem-1", status: "created" });
    };

    await remember({ content: "Just a fact" }, mockUrl);

    expect(capturedBody.content).toBe("Just a fact");
    expect(capturedBody).not.toHaveProperty("category");
    expect(capturedBody).not.toHaveProperty("scope_id");
    expect(capturedBody).not.toHaveProperty("idempotency_key");
    expect(capturedBody).not.toHaveProperty("upsert");
  });
});
