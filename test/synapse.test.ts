import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { OpenAITool } from "../src/synapse";
import { chat } from "../src/synapse";

// --- Mock Synapse server ---

let mockServer: ReturnType<typeof Bun.serve>;
let mockUrl: string;
let mockHandler: (req: Request) => Response | Promise<Response>;

beforeAll(() => {
  mockHandler = () =>
    Response.json({ error: "no mock configured" }, { status: 500 });

  mockServer = Bun.serve({
    port: 0, // random available port
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

function openaiResponse(content: string, finishReason = "stop") {
  return {
    id: "chat-test",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function toolCallResponse(
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
  }>,
  content: string | null = null,
) {
  return {
    id: "chat-test",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

// --- Tests ---

describe("synapse client", () => {
  test("parses a successful chat completion", async () => {
    mockHandler = () => Response.json(openaiResponse("Hello from the model!"));

    const result = await chat(
      [{ role: "user", content: "Hi" }],
      "test-model",
      mockUrl,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe("Hello from the model!");
    expect(result.value.finishReason).toBe("stop");
  });

  test("sends correct request shape to Synapse", async () => {
    let capturedBody: unknown;
    let capturedMethod: string | undefined;
    let capturedPath: string | undefined;
    let capturedContentType: string | null | undefined;

    mockHandler = async (req) => {
      capturedMethod = req.method;
      capturedPath = new URL(req.url).pathname;
      capturedContentType = req.headers.get("content-type");
      capturedBody = await req.json();
      return Response.json(openaiResponse("ok"));
    };

    await chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ],
      "my-model",
      mockUrl,
    );

    expect(capturedMethod).toBe("POST");
    expect(capturedPath).toBe("/v1/chat/completions");
    expect(capturedContentType).toBe("application/json");
    expect(capturedBody).toEqual({
      model: "my-model",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ],
      stream: false,
    });
  });

  test("preserves finish_reason from response", async () => {
    mockHandler = () =>
      Response.json(openaiResponse("I need to use a tool", "tool_calls"));

    const result = await chat(
      [{ role: "user", content: "What time is it?" }],
      "test-model",
      mockUrl,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.finishReason).toBe("tool_calls");
  });

  test("defaults finish_reason to stop when missing", async () => {
    mockHandler = () =>
      Response.json({
        choices: [{ index: 0, message: { role: "assistant", content: "Hi" } }],
      });

    const result = await chat(
      [{ role: "user", content: "Hi" }],
      "test-model",
      mockUrl,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.finishReason).toBe("stop");
  });

  test("returns error on 502 (all providers exhausted)", async () => {
    mockHandler = () =>
      Response.json(
        { error: { message: "All providers exhausted", type: "server_error" } },
        { status: 502 },
      );

    const result = await chat(
      [{ role: "user", content: "Hi" }],
      "nonexistent-model",
      mockUrl,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("502");
  });

  test("returns error on 400 (bad request)", async () => {
    mockHandler = () =>
      Response.json(
        {
          error: {
            message: "model is required",
            type: "invalid_request_error",
          },
        },
        { status: 400 },
      );

    const result = await chat([], "test-model", mockUrl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("400");
  });

  test("returns error on missing choices array", async () => {
    mockHandler = () =>
      Response.json({ id: "chat-1", object: "chat.completion" });

    const result = await chat(
      [{ role: "user", content: "Hi" }],
      "test-model",
      mockUrl,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("missing choices");
  });

  test("returns error on empty choices array", async () => {
    mockHandler = () => Response.json({ choices: [] });

    const result = await chat(
      [{ role: "user", content: "Hi" }],
      "test-model",
      mockUrl,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("missing choices");
  });

  test("returns error on null content without tool_calls", async () => {
    mockHandler = () =>
      Response.json({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null },
            finish_reason: "stop",
          },
        ],
      });

    const result = await chat(
      [{ role: "user", content: "Hi" }],
      "test-model",
      mockUrl,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no content");
  });

  test("returns error on invalid JSON response", async () => {
    mockHandler = () => new Response("not json at all", { status: 200 });

    const result = await chat(
      [{ role: "user", content: "Hi" }],
      "test-model",
      mockUrl,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("invalid JSON");
  });

  test("returns error on connection failure", async () => {
    const result = await chat(
      [{ role: "user", content: "Hi" }],
      "test-model",
      "http://127.0.0.1:1", // port 1 — nothing listening
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("connection failed");
  });

  // --- Tool calling tests ---

  test("parses tool_calls with content: null", async () => {
    mockHandler = () =>
      Response.json(
        toolCallResponse(
          [
            {
              id: "call_1",
              name: "echo.say",
              arguments: '{"text":"hello"}',
            },
          ],
          null,
        ),
      );

    const result = await chat(
      [{ role: "user", content: "Say hello" }],
      "test-model",
      mockUrl,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe("");
    expect(result.value.finishReason).toBe("tool_calls");
    expect(result.value.toolCalls).toBeDefined();
    expect(result.value.toolCalls).toHaveLength(1);
    expect(result.value.toolCalls![0].id).toBe("call_1");
    expect(result.value.toolCalls![0].type).toBe("function");
    expect(result.value.toolCalls![0].function.name).toBe("echo.say");
    expect(result.value.toolCalls![0].function.arguments).toBe(
      '{"text":"hello"}',
    );
  });

  test("parses tool_calls with content: empty string", async () => {
    mockHandler = () =>
      Response.json(
        toolCallResponse(
          [
            {
              id: "call_2",
              name: "math.add",
              arguments: '{"a":1,"b":2}',
            },
          ],
          "",
        ),
      );

    const result = await chat(
      [{ role: "user", content: "Add 1+2" }],
      "test-model",
      mockUrl,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe("");
    expect(result.value.toolCalls).toHaveLength(1);
  });

  test("includes tools in request body when provided", async () => {
    let capturedBody: Record<string, unknown> = {};

    mockHandler = async (req) => {
      capturedBody = (await req.json()) as Record<string, unknown>;
      return Response.json(openaiResponse("ok"));
    };

    const tools: OpenAITool[] = [
      {
        type: "function",
        function: {
          name: "echo.say",
          description: "Echo back text",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
          },
        },
      },
    ];

    await chat([{ role: "user", content: "Hi" }], "test-model", mockUrl, tools);

    expect(capturedBody.tools).toBeDefined();
    expect(capturedBody.tools).toEqual(tools);
  });

  test("does not include tools in request when undefined", async () => {
    let capturedBody: Record<string, unknown> = {};

    mockHandler = async (req) => {
      capturedBody = (await req.json()) as Record<string, unknown>;
      return Response.json(openaiResponse("ok"));
    };

    await chat(
      [{ role: "user", content: "Hi" }],
      "test-model",
      mockUrl,
      undefined,
    );

    expect(capturedBody.tools).toBeUndefined();
  });

  test("does not include tools in request when empty array", async () => {
    let capturedBody: Record<string, unknown> = {};

    mockHandler = async (req) => {
      capturedBody = (await req.json()) as Record<string, unknown>;
      return Response.json(openaiResponse("ok"));
    };

    await chat([{ role: "user", content: "Hi" }], "test-model", mockUrl, []);

    expect(capturedBody.tools).toBeUndefined();
  });

  test("regular response without tool_calls still works", async () => {
    mockHandler = () => Response.json(openaiResponse("Just text"));

    const result = await chat(
      [{ role: "user", content: "Hi" }],
      "test-model",
      mockUrl,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe("Just text");
    expect(result.value.toolCalls).toBeUndefined();
  });

  test("parses multiple tool calls in single response", async () => {
    mockHandler = () =>
      Response.json(
        toolCallResponse(
          [
            {
              id: "call_a",
              name: "echo.say",
              arguments: '{"text":"hi"}',
            },
            {
              id: "call_b",
              name: "math.add",
              arguments: '{"a":2,"b":3}',
            },
          ],
          null,
        ),
      );

    const result = await chat(
      [{ role: "user", content: "Do two things" }],
      "test-model",
      mockUrl,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.toolCalls).toHaveLength(2);
    expect(result.value.toolCalls![0].id).toBe("call_a");
    expect(result.value.toolCalls![0].function.name).toBe("echo.say");
    expect(result.value.toolCalls![1].id).toBe("call_b");
    expect(result.value.toolCalls![1].function.name).toBe("math.add");
  });
});
