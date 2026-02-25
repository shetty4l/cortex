/**
 * Thin Wilson client for Cortex.
 *
 * Wilson is an external tool provider that exposes channel-specific tools
 * (e.g., calendar.get_events) via a REST API. Cortex proxies Wilson tools
 * to the LLM, allowing dynamic tool expansion without redeploying Cortex.
 *
 * API endpoints:
 * - GET /api/tools: List available tools
 * - POST /api/tools/execute: Execute a tool
 *
 * Design:
 * - Timeouts: 10s for listTools (startup), configurable for executeTool
 * - On failure: returns Result.err(), never throws
 * - Optional API key sent as Authorization header
 */

import { createLogger } from "@shetty4l/core/log";
import type { Result } from "@shetty4l/core/result";
import { err, ok } from "@shetty4l/core/result";

const log = createLogger("cortex");

// --- Types ---

/** Tool definition from Wilson's GET /api/tools response. */
export interface WilsonTool {
  channel: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  mutatesState: boolean;
}

/** Result of executing a Wilson tool. */
export interface WilsonToolResult {
  content: string;
  metadata?: Record<string, unknown>;
}

/** Client interface for interacting with Wilson. */
export interface WilsonClient {
  listTools(): Promise<Result<WilsonTool[]>>;
  executeTool(
    channel: string,
    tool: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Result<WilsonToolResult>>;
}

// --- Constants ---

/** Timeout for listTools (startup-time, not latency-sensitive). */
const LIST_TOOLS_TIMEOUT_MS = 10_000;

/** Default timeout for executeTool. */
const DEFAULT_EXECUTE_TIMEOUT_MS = 20_000;

// --- Client implementation ---

/**
 * Create a Wilson client.
 *
 * @param url Base URL of the Wilson API (e.g., "http://localhost:7752")
 * @param apiKey Optional API key for authentication
 */
export function createWilsonClient(url: string, apiKey?: string): WilsonClient {
  const baseUrl = url.replace(/\/$/, ""); // Remove trailing slash

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return {
    async listTools(): Promise<Result<WilsonTool[]>> {
      const endpoint = `${baseUrl}/api/tools`;

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(LIST_TOOLS_TIMEOUT_MS),
        });
      } catch (e) {
        if (e instanceof DOMException && e.name === "TimeoutError") {
          log(`Wilson listTools timed out after ${LIST_TOOLS_TIMEOUT_MS}ms`);
          return err(
            `Wilson listTools timed out after ${LIST_TOOLS_TIMEOUT_MS}ms`,
          );
        }
        if (e instanceof DOMException && e.name === "AbortError") {
          return err("Wilson listTools was aborted");
        }
        const msg = `Wilson connection failed: ${e instanceof Error ? e.message : String(e)}`;
        log(msg);
        return err(msg);
      }

      if (!response.ok) {
        let body: string;
        try {
          body = await response.text();
        } catch {
          body = "(unreadable)";
        }
        const msg = `Wilson listTools returned ${response.status}: ${body.slice(0, 500)}`;
        log(msg);
        return err(msg);
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        return err("Wilson listTools returned invalid JSON");
      }

      // Validate response shape
      if (!Array.isArray(data)) {
        return err("Wilson listTools response must be an array");
      }

      const tools: WilsonTool[] = [];
      for (let i = 0; i < data.length; i++) {
        const item = data[i] as Record<string, unknown>;
        if (typeof item !== "object" || item === null) {
          return err(`Wilson listTools[${i}]: must be an object`);
        }
        if (typeof item.channel !== "string" || item.channel.length === 0) {
          return err(
            `Wilson listTools[${i}]: channel must be a non-empty string`,
          );
        }
        if (typeof item.name !== "string" || item.name.length === 0) {
          return err(`Wilson listTools[${i}]: name must be a non-empty string`);
        }
        if (typeof item.description !== "string") {
          return err(`Wilson listTools[${i}]: description must be a string`);
        }
        if (
          typeof item.parameters !== "object" ||
          item.parameters === null ||
          Array.isArray(item.parameters)
        ) {
          return err(`Wilson listTools[${i}]: parameters must be an object`);
        }
        if (typeof item.mutatesState !== "boolean") {
          return err(`Wilson listTools[${i}]: mutatesState must be a boolean`);
        }

        tools.push({
          channel: item.channel,
          name: item.name,
          description: item.description,
          parameters: item.parameters as Record<string, unknown>,
          mutatesState: item.mutatesState,
        });
      }

      log(`Wilson listTools returned ${tools.length} tools`);
      return ok(tools);
    },

    async executeTool(
      channel: string,
      tool: string,
      params: Record<string, unknown>,
      timeoutMs?: number,
    ): Promise<Result<WilsonToolResult>> {
      const endpoint = `${baseUrl}/api/tools/execute`;
      const effectiveTimeout = timeoutMs ?? DEFAULT_EXECUTE_TIMEOUT_MS;

      const requestBody = { channel, tool, params };

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(effectiveTimeout),
        });
      } catch (e) {
        if (e instanceof DOMException && e.name === "TimeoutError") {
          const msg = `Wilson executeTool timed out after ${effectiveTimeout}ms`;
          log(msg);
          return err(msg);
        }
        if (e instanceof DOMException && e.name === "AbortError") {
          return err("Wilson executeTool was aborted");
        }
        const msg = `Wilson connection failed: ${e instanceof Error ? e.message : String(e)}`;
        log(msg);
        return err(msg);
      }

      if (!response.ok) {
        let body: string;
        try {
          body = await response.text();
        } catch {
          body = "(unreadable)";
        }
        const msg = `Wilson executeTool returned ${response.status}: ${body.slice(0, 500)}`;
        log(msg);
        return err(msg);
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        return err("Wilson executeTool returned invalid JSON");
      }

      // Validate response shape
      const result = data as Record<string, unknown>;
      if (typeof result !== "object" || result === null) {
        return err("Wilson executeTool response must be an object");
      }
      if (typeof result.content !== "string") {
        return err("Wilson executeTool response.content must be a string");
      }

      const output: WilsonToolResult = { content: result.content };
      if (result.metadata !== undefined) {
        if (
          typeof result.metadata !== "object" ||
          result.metadata === null ||
          Array.isArray(result.metadata)
        ) {
          return err("Wilson executeTool response.metadata must be an object");
        }
        output.metadata = result.metadata as Record<string, unknown>;
      }

      return ok(output);
    },
  };
}
