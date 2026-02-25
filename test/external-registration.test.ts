/**
 * Tests for external tool registration.
 *
 * Tests cover:
 * - Register provider with tools, verify tools appear in registry
 * - Re-register same provider updates tools (idempotent)
 * - Unregister provider removes all its tools
 * - Heartbeat updates timestamp
 * - Execute external tool calls provider callback with correct payload
 * - Auth header included in callback when specified
 * - Error handling when provider callback fails/times out
 * - Tool namespacing prevents collision between providers
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { CortexConfig } from "../src/config";
import { closeDatabase, getDatabase, initDatabase } from "../src/db";
import { startServer } from "../src/server";
import { StateLoader } from "../src/state";
import { Thalamus } from "../src/thalamus";
import {
  ExternalToolProvider,
  getProvider,
} from "../src/tools/external-provider";
import {
  externalToolRegistry,
  loadExternalTools,
} from "../src/tools/external-proxy";

// --- Test configuration ---

function makeConfig(): CortexConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    ingestApiKey: "test-key",
    models: ["test-model"],
    synapseUrl: "http://localhost:7750",
    engramUrl: "http://localhost:7749",
    activeWindowSize: 10,
    extractionInterval: 3,
    turnTtlDays: 30,
    schedulerTickSeconds: 30,
    schedulerTimezone: "UTC",
    outboxPollDefaultBatch: 20,
    outboxLeaseSeconds: 60,
    outboxMaxAttempts: 10,
    inboxMaxAttempts: 5,
    skillDirs: [],
    skillConfig: {},
    toolTimeoutMs: 20000,
    maxToolRounds: 8,
    synapseTimeoutMs: 60_000,
    thalamusModels: ["test-model"],
    thalamusSyncIntervalMs: 21_600_000,
  };
}

function createStateLoader(): StateLoader {
  return new StateLoader(getDatabase());
}

const API_KEY = "test-key";

// --- HTTP endpoint tests ---

describe("POST /tools/external/register", () => {
  let server: { port: number; stop: () => void };
  let baseUrl: string;
  let stateLoader: StateLoader;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    savedEnv.CORTEX_CONFIG_PATH = process.env.CORTEX_CONFIG_PATH;
    process.env.CORTEX_CONFIG_PATH = "/nonexistent/config.json";
    initDatabase(":memory:");
    stateLoader = createStateLoader();
    const thalamus = new Thalamus();
    server = startServer(makeConfig(), thalamus, stateLoader);
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    server.stop();
    await stateLoader.flush();
    closeDatabase();
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  function post(body: unknown, token?: string) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token !== undefined) {
      headers.Authorization = `Bearer ${token}`;
    }
    return fetch(`${baseUrl}/tools/external/register`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  // --- Auth tests ---

  test("returns 401 when no auth header", async () => {
    const response = await post({
      providerId: "test",
      callbackUrl: "http://localhost:9000/tools",
      tools: [{ name: "test" }],
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  test("returns 401 when wrong auth token", async () => {
    const response = await post(
      {
        providerId: "test",
        callbackUrl: "http://localhost:9000/tools",
        tools: [{ name: "test" }],
      },
      "wrong-key",
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  // --- ProviderId validation tests ---

  test("returns 400 when providerId contains dots", async () => {
    const response = await post(
      {
        providerId: "my.provider",
        callbackUrl: "http://localhost:9000/tools",
        tools: [{ name: "test" }],
      },
      API_KEY,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: string[];
    };
    expect(body.error).toBe("invalid_request");
    expect(
      body.details.some(
        (d) => d.includes("providerId") && d.includes("alphanumeric"),
      ),
    ).toBe(true);
  });

  test("returns 400 when providerId contains spaces", async () => {
    const response = await post(
      {
        providerId: "my provider",
        callbackUrl: "http://localhost:9000/tools",
        tools: [{ name: "test" }],
      },
      API_KEY,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: string[];
    };
    expect(body.error).toBe("invalid_request");
    expect(
      body.details.some(
        (d) => d.includes("providerId") && d.includes("alphanumeric"),
      ),
    ).toBe(true);
  });

  test("returns 400 when providerId is empty string", async () => {
    const response = await post(
      {
        providerId: "",
        callbackUrl: "http://localhost:9000/tools",
        tools: [{ name: "test" }],
      },
      API_KEY,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: string[];
    };
    expect(body.error).toBe("invalid_request");
    expect(body.details.some((d) => d.includes("providerId"))).toBe(true);
  });

  test("accepts valid providerId with alphanumeric, hyphens, and underscores", async () => {
    const response = await post(
      {
        providerId: "valid-id_123",
        callbackUrl: "http://localhost:9000/tools",
        tools: [{ name: "test_tool" }],
      },
      API_KEY,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      toolCount: number;
    };
    expect(body.success).toBe(true);
  });

  // --- Existing tests (now with auth) ---

  test("registers provider with tools, tools appear in registry", async () => {
    const response = await post(
      {
        providerId: "calendar",
        callbackUrl: "http://localhost:9000/tools",
        tools: [
          { name: "get_events", description: "Get calendar events" },
          { name: "create_event", description: "Create a calendar event" },
        ],
      },
      API_KEY,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      toolCount: number;
    };
    expect(body.success).toBe(true);
    expect(body.toolCount).toBe(2);

    // Verify tools appear in external tool registry
    const tools = externalToolRegistry.getTools(stateLoader);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("calendar.get_events");
    expect(toolNames).toContain("calendar.create_event");
  });

  test("re-register same provider updates tools (idempotent)", async () => {
    // First registration
    const first = await post(
      {
        providerId: "email",
        callbackUrl: "http://localhost:9001/tools",
        tools: [{ name: "send_email", description: "Send email" }],
      },
      API_KEY,
    );
    expect(first.status).toBe(200);

    const provider1 = getProvider(stateLoader, "email");
    expect(provider1).not.toBeNull();
    const registeredAt1 = provider1!.registeredAt;

    // Wait a bit to ensure timestamp changes
    await new Promise((r) => setTimeout(r, 10));

    // Re-register with different tools
    const second = await post(
      {
        providerId: "email",
        callbackUrl: "http://localhost:9001/tools",
        tools: [
          { name: "send_email", description: "Send email v2" },
          { name: "read_inbox", description: "Read inbox" },
        ],
      },
      API_KEY,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      success: boolean;
      toolCount: number;
    };
    expect(secondBody.toolCount).toBe(2);

    // Verify only one provider exists with updated tools
    const provider2 = getProvider(stateLoader, "email");
    expect(provider2).not.toBeNull();
    expect(provider2!.registeredAt).toBeGreaterThan(registeredAt1);

    const tools = externalToolRegistry.getTools(stateLoader);
    const emailTools = tools.filter((t) => t.name.startsWith("email."));
    expect(emailTools).toHaveLength(2);
    expect(emailTools.map((t) => t.name)).toContain("email.send_email");
    expect(emailTools.map((t) => t.name)).toContain("email.read_inbox");
  });

  test("returns 400 when providerId is missing", async () => {
    const response = await post(
      {
        callbackUrl: "http://localhost:9000/tools",
        tools: [{ name: "test" }],
      },
      API_KEY,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: string[];
    };
    expect(body.error).toBe("invalid_request");
    expect(body.details.some((d) => d.includes("providerId"))).toBe(true);
  });

  test("returns 400 when callbackUrl is invalid", async () => {
    const response = await post(
      {
        providerId: "test",
        callbackUrl: "not-a-url",
        tools: [{ name: "test" }],
      },
      API_KEY,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: string[];
    };
    expect(body.details.some((d) => d.includes("callbackUrl"))).toBe(true);
  });

  test("returns 400 when tools is not an array", async () => {
    const response = await post(
      {
        providerId: "test",
        callbackUrl: "http://localhost:9000/tools",
        tools: "not-an-array",
      },
      API_KEY,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: string[];
    };
    expect(body.details.some((d) => d.includes("tools"))).toBe(true);
  });

  test("returns 400 when tool.name is missing", async () => {
    const response = await post(
      {
        providerId: "test",
        callbackUrl: "http://localhost:9000/tools",
        tools: [{ description: "missing name" }],
      },
      API_KEY,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: string[];
    };
    expect(body.details.some((d) => d.includes("tools[0].name"))).toBe(true);
  });

  test("stores optional authHeader", async () => {
    const response = await post(
      {
        providerId: "secure-provider",
        callbackUrl: "http://localhost:9000/tools",
        authHeader: "Bearer secret-token",
        tools: [{ name: "secure_action" }],
      },
      API_KEY,
    );

    expect(response.status).toBe(200);

    const provider = getProvider(stateLoader, "secure-provider");
    expect(provider).not.toBeNull();
    expect(provider!.authHeader).toBe("Bearer secret-token");
  });
});

describe("DELETE /tools/external/unregister/:providerId", () => {
  let server: { port: number; stop: () => void };
  let baseUrl: string;
  let stateLoader: StateLoader;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    savedEnv.CORTEX_CONFIG_PATH = process.env.CORTEX_CONFIG_PATH;
    process.env.CORTEX_CONFIG_PATH = "/nonexistent/config.json";
    initDatabase(":memory:");
    stateLoader = createStateLoader();
    const thalamus = new Thalamus();
    server = startServer(makeConfig(), thalamus, stateLoader);
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    server.stop();
    await stateLoader.flush();
    closeDatabase();
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  function registerProvider(providerId: string) {
    return fetch(`${baseUrl}/tools/external/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        providerId,
        callbackUrl: "http://localhost:9000/tools",
        tools: [{ name: "tool_a" }, { name: "tool_b" }],
      }),
    });
  }

  function unregister(providerId: string, token?: string) {
    const headers: Record<string, string> = {};
    if (token !== undefined) {
      headers.Authorization = `Bearer ${token}`;
    }
    return fetch(`${baseUrl}/tools/external/unregister/${providerId}`, {
      method: "DELETE",
      headers,
    });
  }

  // --- Auth tests ---

  test("returns 401 when no auth header", async () => {
    const response = await unregister("any-provider");

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  test("returns 401 when wrong auth token", async () => {
    const response = await unregister("any-provider", "wrong-key");

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  // --- URL-encoded providerId tests ---

  test("unregister with URL-encoded providerId decodes correctly", async () => {
    // Register a provider with hyphen in name
    const registerResp = await registerProvider("my-provider");
    expect(registerResp.status).toBe(200);

    // Verify tools exist
    let tools = externalToolRegistry.getTools(stateLoader);
    expect(tools.some((t) => t.name === "my-provider.tool_a")).toBe(true);

    // Unregister using URL-encoded providerId (hyphen as %2D)
    const unregisterResp = await unregister("my%2Dprovider", API_KEY);
    expect(unregisterResp.status).toBe(200);
    const body = (await unregisterResp.json()) as { success: boolean };
    expect(body.success).toBe(true);

    // Verify tools are removed
    tools = externalToolRegistry.getTools(stateLoader);
    expect(tools.some((t) => t.name === "my-provider.tool_a")).toBe(false);
  });

  // --- Existing tests ---

  test("unregister provider removes all its tools", async () => {
    // First register a provider
    const registerResp = await registerProvider("to-remove");
    expect(registerResp.status).toBe(200);

    // Verify tools exist
    let tools = externalToolRegistry.getTools(stateLoader);
    expect(tools.some((t) => t.name === "to-remove.tool_a")).toBe(true);
    expect(tools.some((t) => t.name === "to-remove.tool_b")).toBe(true);

    // Unregister the provider
    const unregisterResp = await unregister("to-remove", API_KEY);
    expect(unregisterResp.status).toBe(200);
    const body = (await unregisterResp.json()) as { success: boolean };
    expect(body.success).toBe(true);

    // Verify tools are removed
    tools = externalToolRegistry.getTools(stateLoader);
    expect(tools.some((t) => t.name === "to-remove.tool_a")).toBe(false);
    expect(tools.some((t) => t.name === "to-remove.tool_b")).toBe(false);
  });

  test("returns 404 for unknown provider", async () => {
    const response = await unregister("unknown-provider", API_KEY);

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });
});

describe("POST /tools/external/heartbeat/:providerId", () => {
  let server: { port: number; stop: () => void };
  let baseUrl: string;
  let stateLoader: StateLoader;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    savedEnv.CORTEX_CONFIG_PATH = process.env.CORTEX_CONFIG_PATH;
    process.env.CORTEX_CONFIG_PATH = "/nonexistent/config.json";
    initDatabase(":memory:");
    stateLoader = createStateLoader();
    const thalamus = new Thalamus();
    server = startServer(makeConfig(), thalamus, stateLoader);
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    server.stop();
    await stateLoader.flush();
    closeDatabase();
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  function registerProvider(providerId: string) {
    return fetch(`${baseUrl}/tools/external/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        providerId,
        callbackUrl: "http://localhost:9000/tools",
        tools: [{ name: "test" }],
      }),
    });
  }

  function heartbeat(providerId: string, token?: string) {
    const headers: Record<string, string> = {};
    if (token !== undefined) {
      headers.Authorization = `Bearer ${token}`;
    }
    return fetch(`${baseUrl}/tools/external/heartbeat/${providerId}`, {
      method: "POST",
      headers,
    });
  }

  // --- Auth tests ---

  test("returns 401 when no auth header", async () => {
    const response = await heartbeat("any-provider");

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  test("returns 401 when wrong auth token", async () => {
    const response = await heartbeat("any-provider", "wrong-key");

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  // --- URL-encoded providerId tests ---

  test("heartbeat with URL-encoded providerId decodes correctly", async () => {
    // Register a provider with hyphen in name
    const registerResp = await registerProvider("hb-provider");
    expect(registerResp.status).toBe(200);

    const provider1 = getProvider(stateLoader, "hb-provider");
    expect(provider1).not.toBeNull();
    expect(provider1!.lastHeartbeatAt).toBeNull();

    // Send heartbeat using URL-encoded providerId (hyphen as %2D)
    const beforeHeartbeat = Date.now();
    const response = await heartbeat("hb%2Dprovider", API_KEY);
    const afterHeartbeat = Date.now();

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(true);

    const provider2 = getProvider(stateLoader, "hb-provider");
    expect(provider2).not.toBeNull();
    expect(provider2!.lastHeartbeatAt).not.toBeNull();
    expect(provider2!.lastHeartbeatAt).toBeGreaterThanOrEqual(beforeHeartbeat);
    expect(provider2!.lastHeartbeatAt).toBeLessThanOrEqual(afterHeartbeat);
  });

  // --- Existing tests ---

  test("heartbeat updates timestamp", async () => {
    // First register a provider
    await registerProvider("heartbeat-test");

    const provider1 = getProvider(stateLoader, "heartbeat-test");
    expect(provider1).not.toBeNull();
    expect(provider1!.lastHeartbeatAt).toBeNull();

    // Send heartbeat
    const beforeHeartbeat = Date.now();
    const response = await heartbeat("heartbeat-test", API_KEY);
    const afterHeartbeat = Date.now();

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(true);

    const provider2 = getProvider(stateLoader, "heartbeat-test");
    expect(provider2).not.toBeNull();
    expect(provider2!.lastHeartbeatAt).not.toBeNull();
    expect(provider2!.lastHeartbeatAt).toBeGreaterThanOrEqual(beforeHeartbeat);
    expect(provider2!.lastHeartbeatAt).toBeLessThanOrEqual(afterHeartbeat);
  });

  test("returns 404 for unknown provider", async () => {
    const response = await heartbeat("unknown-provider", API_KEY);

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });
});

// --- Tool execution tests ---

describe("external tool execution", () => {
  let stateLoader: StateLoader;
  let mockServer: ReturnType<typeof Bun.serve>;
  let mockServerPort: number;
  let receivedRequests: Array<{
    path: string;
    body: unknown;
    headers: Headers;
  }>;

  beforeEach(() => {
    initDatabase(":memory:");
    stateLoader = createStateLoader();
    receivedRequests = [];

    // Start a mock server to receive tool execution callbacks
    mockServer = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const body = await req.json().catch(() => null);
        receivedRequests.push({
          path: url.pathname,
          body,
          headers: req.headers,
        });

        // Handle different test scenarios based on path
        if (url.pathname === "/timeout/execute") {
          // Simulate timeout by delaying response
          await new Promise((r) => setTimeout(r, 15000));
          return new Response(JSON.stringify({ content: "too late" }));
        }

        if (url.pathname === "/error/execute") {
          return new Response("Internal Server Error", { status: 500 });
        }

        if (url.pathname === "/bad-json/execute") {
          return new Response("not valid json{{");
        }

        // Normal success response
        return new Response(
          JSON.stringify({
            content: `Executed ${body?.name} with args ${body?.arguments}`,
            metadata: { executedBy: "mock-server" },
          }),
        );
      },
    });
    mockServerPort = mockServer.port!;
  });

  afterEach(async () => {
    mockServer.stop();
    await stateLoader.flush();
    closeDatabase();
  });

  test("execute external tool calls provider callback with correct payload", async () => {
    // Register provider pointing to mock server
    const provider = stateLoader.create(ExternalToolProvider, {
      providerId: "mock",
      callbackUrl: `http://localhost:${mockServerPort}`,
      authHeader: null,
      toolsJson: JSON.stringify([
        { name: "do_action", description: "Test action" },
      ]),
      registeredAt: Date.now(),
      lastHeartbeatAt: null,
    });
    await provider.save();

    // Execute the tool
    const result = await externalToolRegistry.executeTool(
      stateLoader,
      "mock.do_action",
      '{"key":"value"}',
      {} as never,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toContain("do_action");
      expect(result.value.content).toContain('{"key":"value"}');
      expect(result.value.metadata?.executedBy).toBe("mock-server");
    }

    // Verify the callback received correct payload
    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0].path).toBe("/execute");
    expect(receivedRequests[0].body).toEqual({
      name: "do_action", // Original name without provider prefix
      arguments: '{"key":"value"}',
    });
  });

  test("auth header included in callback when specified", async () => {
    // Register provider with auth header
    const provider = stateLoader.create(ExternalToolProvider, {
      providerId: "auth-test",
      callbackUrl: `http://localhost:${mockServerPort}`,
      authHeader: "Bearer my-secret-token",
      toolsJson: JSON.stringify([{ name: "secure_action" }]),
      registeredAt: Date.now(),
      lastHeartbeatAt: null,
    });
    await provider.save();

    // Execute the tool
    await externalToolRegistry.executeTool(
      stateLoader,
      "auth-test.secure_action",
      "{}",
      {} as never,
    );

    // Verify auth header was sent
    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0].headers.get("Authorization")).toBe(
      "Bearer my-secret-token",
    );
  });

  test("error handling when provider callback fails", async () => {
    // Register provider pointing to error endpoint
    const provider = stateLoader.create(ExternalToolProvider, {
      providerId: "error-test",
      callbackUrl: `http://localhost:${mockServerPort}/error`,
      authHeader: null,
      toolsJson: JSON.stringify([{ name: "fail_action" }]),
      registeredAt: Date.now(),
      lastHeartbeatAt: null,
    });
    await provider.save();

    // Execute the tool - should return error result, not throw
    const result = await externalToolRegistry.executeTool(
      stateLoader,
      "error-test.fail_action",
      "{}",
      {} as never,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("HTTP 500");
    }
  });

  test("error handling when provider callback times out", async () => {
    // Register provider pointing to timeout endpoint
    const provider = stateLoader.create(ExternalToolProvider, {
      providerId: "timeout-test",
      callbackUrl: `http://localhost:${mockServerPort}/timeout`,
      authHeader: null,
      toolsJson: JSON.stringify([{ name: "slow_action" }]),
      registeredAt: Date.now(),
      lastHeartbeatAt: null,
    });
    await provider.save();

    // Execute the tool - should return timeout error
    const result = await externalToolRegistry.executeTool(
      stateLoader,
      "timeout-test.slow_action",
      "{}",
      {} as never,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("timed out");
    }
  }, 15000);

  test("returns error for unknown external tool", async () => {
    const result = await externalToolRegistry.executeTool(
      stateLoader,
      "nonexistent.tool",
      "{}",
      {} as never,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unknown external tool");
    }
  });
});

// --- Tool namespacing tests ---

describe("tool namespacing", () => {
  let stateLoader: StateLoader;

  beforeEach(() => {
    initDatabase(":memory:");
    stateLoader = createStateLoader();
  });

  afterEach(async () => {
    await stateLoader.flush();
    closeDatabase();
  });

  test("tool namespacing prevents collision between providers", async () => {
    // Register two providers with tools of the same name
    const provider1 = stateLoader.create(ExternalToolProvider, {
      providerId: "provider-a",
      callbackUrl: "http://localhost:9001",
      authHeader: null,
      toolsJson: JSON.stringify([
        { name: "get_data", description: "Get data from A" },
      ]),
      registeredAt: Date.now(),
      lastHeartbeatAt: null,
    });
    await provider1.save();

    const provider2 = stateLoader.create(ExternalToolProvider, {
      providerId: "provider-b",
      callbackUrl: "http://localhost:9002",
      authHeader: null,
      toolsJson: JSON.stringify([
        { name: "get_data", description: "Get data from B" },
      ]),
      registeredAt: Date.now(),
      lastHeartbeatAt: null,
    });
    await provider2.save();

    // Load external tools
    const toolMap = loadExternalTools(stateLoader);

    // Both tools should exist with different namespaced names
    expect(toolMap.has("provider-a.get_data")).toBe(true);
    expect(toolMap.has("provider-b.get_data")).toBe(true);

    // Verify they point to different providers
    const toolA = toolMap.get("provider-a.get_data");
    const toolB = toolMap.get("provider-b.get_data");

    expect(toolA?.provider.callbackUrl).toBe("http://localhost:9001");
    expect(toolB?.provider.callbackUrl).toBe("http://localhost:9002");

    // Verify descriptions are different
    expect(toolA?.def.description).toBe("Get data from A");
    expect(toolB?.def.description).toBe("Get data from B");
  });

  test("external tools appear with namespaced names in combined registry", async () => {
    const provider = stateLoader.create(ExternalToolProvider, {
      providerId: "wilson",
      callbackUrl: "http://localhost:9000",
      authHeader: null,
      toolsJson: JSON.stringify([
        { name: "calendar.get_events", description: "Get events" },
        { name: "calendar.create_event", description: "Create event" },
      ]),
      registeredAt: Date.now(),
      lastHeartbeatAt: null,
    });
    await provider.save();

    const tools = externalToolRegistry.getTools(stateLoader);
    const toolNames = tools.map((t) => t.name);

    // Tools should be namespaced as providerId.toolName
    expect(toolNames).toContain("wilson.calendar.get_events");
    expect(toolNames).toContain("wilson.calendar.create_event");
  });

  test("mutatesState flag is preserved in tool definitions", async () => {
    const provider = stateLoader.create(ExternalToolProvider, {
      providerId: "mutating",
      callbackUrl: "http://localhost:9000",
      authHeader: null,
      toolsJson: JSON.stringify([
        { name: "read_only", description: "Read", mutatesState: false },
        { name: "write_action", description: "Write", mutatesState: true },
      ]),
      registeredAt: Date.now(),
      lastHeartbeatAt: null,
    });
    await provider.save();

    expect(
      externalToolRegistry.isMutating(stateLoader, "mutating.read_only"),
    ).toBe(false);
    expect(
      externalToolRegistry.isMutating(stateLoader, "mutating.write_action"),
    ).toBe(true);
  });

  test("invalid toolsJson is skipped gracefully", async () => {
    // Create provider with invalid JSON
    const provider = stateLoader.create(ExternalToolProvider, {
      providerId: "invalid",
      callbackUrl: "http://localhost:9000",
      authHeader: null,
      toolsJson: "not valid json{{",
      registeredAt: Date.now(),
      lastHeartbeatAt: null,
    });
    await provider.save();

    // Should not throw, just skip the invalid provider
    const toolMap = loadExternalTools(stateLoader);
    const invalidTools = Array.from(toolMap.keys()).filter((k) =>
      k.startsWith("invalid."),
    );
    expect(invalidTools).toHaveLength(0);
  });

  test("tools without name are skipped", async () => {
    const provider = stateLoader.create(ExternalToolProvider, {
      providerId: "partial",
      callbackUrl: "http://localhost:9000",
      authHeader: null,
      toolsJson: JSON.stringify([
        { name: "valid_tool" },
        { description: "Missing name" }, // No name
        { name: "", description: "Empty name" }, // Empty name
      ]),
      registeredAt: Date.now(),
      lastHeartbeatAt: null,
    });
    await provider.save();

    const toolMap = loadExternalTools(stateLoader);
    const partialTools = Array.from(toolMap.keys()).filter((k) =>
      k.startsWith("partial."),
    );
    expect(partialTools).toHaveLength(1);
    expect(partialTools[0]).toBe("partial.valid_tool");
  });
});
