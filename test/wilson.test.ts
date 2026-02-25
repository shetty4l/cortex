import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BuiltinToolContext } from "../src/tools";
import { createWilsonProxyTool } from "../src/tools/wilson-proxy";
import type { WilsonClient, WilsonTool } from "../src/wilson";
import { createWilsonClient } from "../src/wilson";

// --- Mock Wilson server ---

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

// --- WilsonClient.listTools() tests ---

describe("WilsonClient.listTools()", () => {
  test("returns array of tools on success", async () => {
    const mockTools = [
      {
        channel: "calendar",
        name: "get_events",
        description: "Get calendar events",
        parameters: { type: "object", properties: {} },
        mutatesState: false,
      },
      {
        channel: "calendar",
        name: "create_event",
        description: "Create a calendar event",
        parameters: {
          type: "object",
          properties: { title: { type: "string" } },
        },
        mutatesState: true,
      },
    ];

    mockHandler = () => Response.json(mockTools);

    const client = createWilsonClient(mockUrl);
    const result = await client.listTools();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(result.value[0].channel).toBe("calendar");
    expect(result.value[0].name).toBe("get_events");
    expect(result.value[0].mutatesState).toBe(false);
    expect(result.value[1].name).toBe("create_event");
    expect(result.value[1].mutatesState).toBe(true);
  });

  test("returns error on HTTP failure", async () => {
    mockHandler = () =>
      Response.json({ error: "Internal error" }, { status: 500 });

    const client = createWilsonClient(mockUrl);
    const result = await client.listTools();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("500");
  });

  test("returns error on invalid JSON response", async () => {
    mockHandler = () => new Response("not json", { status: 200 });

    const client = createWilsonClient(mockUrl);
    const result = await client.listTools();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("invalid JSON");
  });

  test("returns error when response is not an array", async () => {
    mockHandler = () => Response.json({ tools: [] });

    const client = createWilsonClient(mockUrl);
    const result = await client.listTools();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("must be an array");
  });

  test("validates tool shape - missing channel", async () => {
    mockHandler = () =>
      Response.json([
        {
          name: "test",
          description: "desc",
          parameters: {},
          mutatesState: false,
        },
      ]);

    const client = createWilsonClient(mockUrl);
    const result = await client.listTools();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("channel");
  });

  test("validates tool shape - missing name", async () => {
    mockHandler = () =>
      Response.json([
        {
          channel: "test",
          description: "desc",
          parameters: {},
          mutatesState: false,
        },
      ]);

    const client = createWilsonClient(mockUrl);
    const result = await client.listTools();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("name");
  });

  test("validates tool shape - invalid mutatesState", async () => {
    mockHandler = () =>
      Response.json([
        {
          channel: "test",
          name: "tool",
          description: "desc",
          parameters: {},
          mutatesState: "false",
        },
      ]);

    const client = createWilsonClient(mockUrl);
    const result = await client.listTools();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("mutatesState");
  });

  test("sends Authorization header when apiKey provided", async () => {
    let receivedAuth = "";
    mockHandler = (req) => {
      receivedAuth = req.headers.get("Authorization") ?? "";
      return Response.json([]);
    };

    const client = createWilsonClient(mockUrl, "secret-key");
    await client.listTools();

    expect(receivedAuth).toBe("Bearer secret-key");
  });

  test("handles connection failure gracefully", async () => {
    const client = createWilsonClient("http://localhost:99999");
    const result = await client.listTools();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("connection failed");
  });
});

// --- WilsonClient.executeTool() tests ---

describe("WilsonClient.executeTool()", () => {
  test("executes tool and returns result", async () => {
    mockHandler = async (req) => {
      const body = await req.json();
      expect(body.channel).toBe("calendar");
      expect(body.tool).toBe("get_events");
      expect(body.params).toEqual({ date: "2025-01-01" });
      return Response.json({
        content: "Found 3 events",
        metadata: { count: 3 },
      });
    };

    const client = createWilsonClient(mockUrl);
    const result = await client.executeTool("calendar", "get_events", {
      date: "2025-01-01",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe("Found 3 events");
    expect(result.value.metadata).toEqual({ count: 3 });
  });

  test("returns result without metadata when not provided", async () => {
    mockHandler = () => Response.json({ content: "Success" });

    const client = createWilsonClient(mockUrl);
    const result = await client.executeTool("test", "tool", {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe("Success");
    expect(result.value.metadata).toBeUndefined();
  });

  test("returns error on HTTP failure", async () => {
    mockHandler = () =>
      Response.json({ error: "Tool not found" }, { status: 404 });

    const client = createWilsonClient(mockUrl);
    const result = await client.executeTool("missing", "tool", {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("404");
  });

  test("returns error on invalid response - missing content", async () => {
    mockHandler = () => Response.json({ result: "ok" });

    const client = createWilsonClient(mockUrl);
    const result = await client.executeTool("test", "tool", {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("content must be a string");
  });

  test("returns error on invalid metadata type", async () => {
    mockHandler = () =>
      Response.json({ content: "ok", metadata: "not an object" });

    const client = createWilsonClient(mockUrl);
    const result = await client.executeTool("test", "tool", {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("metadata must be an object");
  });

  test("sends Authorization header when apiKey provided", async () => {
    let receivedAuth = "";
    mockHandler = (req) => {
      receivedAuth = req.headers.get("Authorization") ?? "";
      return Response.json({ content: "ok" });
    };

    const client = createWilsonClient(mockUrl, "my-api-key");
    await client.executeTool("test", "tool", {});

    expect(receivedAuth).toBe("Bearer my-api-key");
  });

  test("handles connection failure gracefully", async () => {
    const client = createWilsonClient("http://localhost:99999");
    const result = await client.executeTool("test", "tool", {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("connection failed");
  });
});

// --- Wilson proxy tool tests ---

describe("createWilsonProxyTool", () => {
  test("creates tool with qualified name (channel.tool)", () => {
    const mockClient: WilsonClient = {
      async listTools() {
        return { ok: true, value: [] };
      },
      async executeTool() {
        return { ok: true, value: { content: "ok" } };
      },
    };

    const wilsonTool: WilsonTool = {
      channel: "calendar",
      name: "get_events",
      description: "Get calendar events",
      parameters: { type: "object" },
      mutatesState: false,
    };

    const proxyTool = createWilsonProxyTool(mockClient, wilsonTool);

    expect(proxyTool.definition.name).toBe("calendar.get_events");
    expect(proxyTool.definition.description).toBe("Get calendar events");
    expect(proxyTool.definition.mutatesState).toBe(false);
  });

  test("preserves mutatesState from Wilson tool", () => {
    const mockClient: WilsonClient = {
      async listTools() {
        return { ok: true, value: [] };
      },
      async executeTool() {
        return { ok: true, value: { content: "ok" } };
      },
    };

    const mutatingTool: WilsonTool = {
      channel: "calendar",
      name: "create_event",
      description: "Create event",
      parameters: {},
      mutatesState: true,
    };

    const proxyTool = createWilsonProxyTool(mockClient, mutatingTool);
    expect(proxyTool.definition.mutatesState).toBe(true);
  });

  test("proxies execution to Wilson client", async () => {
    let capturedChannel = "";
    let capturedTool = "";
    let capturedParams: Record<string, unknown> = {};

    const mockClient: WilsonClient = {
      async listTools() {
        return { ok: true, value: [] };
      },
      async executeTool(channel, tool, params) {
        capturedChannel = channel;
        capturedTool = tool;
        capturedParams = params;
        return { ok: true, value: { content: "Executed successfully" } };
      },
    };

    const wilsonTool: WilsonTool = {
      channel: "email",
      name: "send",
      description: "Send email",
      parameters: { type: "object" },
      mutatesState: true,
    };

    const proxyTool = createWilsonProxyTool(mockClient, wilsonTool);
    const ctx: BuiltinToolContext = { topicKey: "test-topic" };

    const result = await proxyTool.execute(
      JSON.stringify({ to: "test@example.com", subject: "Hello" }),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe("Executed successfully");
    expect(capturedChannel).toBe("email");
    expect(capturedTool).toBe("send");
    expect(capturedParams).toEqual({
      to: "test@example.com",
      subject: "Hello",
    });
  });

  test("returns error on invalid JSON arguments", async () => {
    const mockClient: WilsonClient = {
      async listTools() {
        return { ok: true, value: [] };
      },
      async executeTool() {
        return { ok: true, value: { content: "ok" } };
      },
    };

    const wilsonTool: WilsonTool = {
      channel: "test",
      name: "tool",
      description: "Test",
      parameters: {},
      mutatesState: false,
    };

    const proxyTool = createWilsonProxyTool(mockClient, wilsonTool);
    const result = await proxyTool.execute("not valid json{{{", {
      topicKey: "test",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Invalid JSON");
  });

  test("returns error when Wilson client fails", async () => {
    const mockClient: WilsonClient = {
      async listTools() {
        return { ok: true, value: [] };
      },
      async executeTool() {
        return { ok: false, error: "Wilson service unavailable" };
      },
    };

    const wilsonTool: WilsonTool = {
      channel: "test",
      name: "tool",
      description: "Test",
      parameters: {},
      mutatesState: false,
    };

    const proxyTool = createWilsonProxyTool(mockClient, wilsonTool);
    const result = await proxyTool.execute("{}", { topicKey: "test" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Wilson service unavailable");
  });

  test("passes through metadata from Wilson response", async () => {
    const mockClient: WilsonClient = {
      async listTools() {
        return { ok: true, value: [] };
      },
      async executeTool() {
        return {
          ok: true,
          value: {
            content: "Done",
            metadata: { eventId: "123", created: true },
          },
        };
      },
    };

    const wilsonTool: WilsonTool = {
      channel: "calendar",
      name: "create",
      description: "Create",
      parameters: {},
      mutatesState: true,
    };

    const proxyTool = createWilsonProxyTool(mockClient, wilsonTool);
    const result = await proxyTool.execute("{}", { topicKey: "test" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.metadata).toEqual({ eventId: "123", created: true });
  });
});
