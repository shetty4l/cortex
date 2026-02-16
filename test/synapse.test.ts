import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chat, SynapseError } from "../src/synapse";

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

// --- Tests ---

describe("synapse client", () => {
  test("parses a successful chat completion", async () => {
    mockHandler = () => Response.json(openaiResponse("Hello from the model!"));

    const result = await chat(
      [{ role: "user", content: "Hi" }],
      "test-model",
      mockUrl,
    );

    expect(result.content).toBe("Hello from the model!");
    expect(result.finishReason).toBe("stop");
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

    expect(result.finishReason).toBe("tool_calls");
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

    expect(result.finishReason).toBe("stop");
  });

  test("throws SynapseError on 502 (all providers exhausted)", async () => {
    mockHandler = () =>
      Response.json(
        { error: { message: "All providers exhausted", type: "server_error" } },
        { status: 502 },
      );

    try {
      await chat(
        [{ role: "user", content: "Hi" }],
        "nonexistent-model",
        mockUrl,
      );
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(SynapseError);
      const se = err as SynapseError;
      expect(se.status).toBe(502);
      expect(se.message).toContain("502");
    }
  });

  test("throws SynapseError on 400 (bad request)", async () => {
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

    try {
      await chat([], "test-model", mockUrl);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SynapseError);
      expect((err as SynapseError).status).toBe(400);
    }
  });

  test("throws on missing choices array", async () => {
    mockHandler = () =>
      Response.json({ id: "chat-1", object: "chat.completion" });

    try {
      await chat([{ role: "user", content: "Hi" }], "test-model", mockUrl);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SynapseError);
      expect((err as SynapseError).message).toContain("missing choices");
    }
  });

  test("throws on empty choices array", async () => {
    mockHandler = () => Response.json({ choices: [] });

    try {
      await chat([{ role: "user", content: "Hi" }], "test-model", mockUrl);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SynapseError);
      expect((err as SynapseError).message).toContain("missing choices");
    }
  });

  test("throws on null content in response", async () => {
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

    try {
      await chat([{ role: "user", content: "Hi" }], "test-model", mockUrl);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SynapseError);
      expect((err as SynapseError).message).toContain("no content");
    }
  });

  test("throws on invalid JSON response", async () => {
    mockHandler = () => new Response("not json at all", { status: 200 });

    try {
      await chat([{ role: "user", content: "Hi" }], "test-model", mockUrl);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SynapseError);
      expect((err as SynapseError).message).toContain("invalid JSON");
    }
  });

  test("throws on connection failure", async () => {
    try {
      await chat(
        [{ role: "user", content: "Hi" }],
        "test-model",
        "http://127.0.0.1:1", // port 1 — nothing listening
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SynapseError);
      expect((err as SynapseError).status).toBe(0);
      expect((err as SynapseError).message).toContain("connection failed");
    }
  });
});
