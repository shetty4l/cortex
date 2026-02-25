/**
 * External tool proxy for Cortex.
 *
 * Loads tools from registered ExternalToolProviders and executes them
 * by proxying requests to the provider's callback URL.
 *
 * Tools are namespaced as {providerId}.{toolName} to avoid collisions.
 */

import type { Result } from "@shetty4l/core/result";
import { err, ok } from "@shetty4l/core/result";
import type { StateLoader } from "@shetty4l/core/state";
import type {
  SkillRuntimeContext,
  SkillToolResult,
  ToolDefinition,
} from "../skills";
import { type ExternalToolProvider, listProviders } from "./external-provider";

/** Timeout for external tool execution requests (10 seconds). */
const EXECUTE_TIMEOUT_MS = 10_000;

/** Parsed tool definition from provider's toolsJson. */
interface ExternalToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  mutatesState?: boolean;
}

/** Internal registry entry for an external tool. */
interface ExternalToolEntry {
  provider: ExternalToolProvider;
  localName: string;
  def: ToolDefinition;
}

/**
 * Load all external tools from registered providers.
 *
 * Returns a map of namespaced tool names to their entries.
 */
export function loadExternalTools(
  stateLoader: StateLoader,
): Map<string, ExternalToolEntry> {
  const toolMap = new Map<string, ExternalToolEntry>();
  const providers = listProviders(stateLoader);

  for (const provider of providers) {
    let tools: ExternalToolDef[];
    try {
      tools = JSON.parse(provider.toolsJson) as ExternalToolDef[];
    } catch {
      // Skip providers with invalid toolsJson
      continue;
    }

    if (!Array.isArray(tools)) continue;

    for (const tool of tools) {
      if (!tool.name || typeof tool.name !== "string") continue;

      const qualifiedName = `${provider.providerId}.${tool.name}`;
      toolMap.set(qualifiedName, {
        provider,
        localName: tool.name,
        def: {
          name: qualifiedName,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
          mutatesState: tool.mutatesState ?? false,
        },
      });
    }
  }

  return toolMap;
}

/**
 * Execute an external tool by proxying to the provider's callback URL.
 *
 * @param entry The external tool entry containing provider info
 * @param argumentsJson JSON string of tool arguments
 * @returns Result with tool output or error message
 */
export async function executeExternalTool(
  entry: ExternalToolEntry,
  argumentsJson: string,
): Promise<Result<SkillToolResult>> {
  const { provider, localName } = entry;

  // Build callback URL: provider.callbackUrl + /execute
  const callbackUrl = provider.callbackUrl.endsWith("/")
    ? `${provider.callbackUrl}execute`
    : `${provider.callbackUrl}/execute`;

  // Build request headers
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (provider.authHeader) {
    headers["Authorization"] = provider.authHeader;
  }

  // Build request body - send original tool name (without provider prefix)
  const body = JSON.stringify({
    name: localName,
    arguments: argumentsJson,
  });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EXECUTE_TIMEOUT_MS);

    const response = await fetch(callbackUrl, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return err(
        `external tool ${entry.def.name} failed: HTTP ${response.status}${text ? `: ${text}` : ""}`,
      );
    }

    const result = (await response.json()) as {
      content?: string;
      metadata?: Record<string, unknown>;
    };

    return ok({
      content: result.content ?? "",
      metadata: result.metadata,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      return err(
        `external tool ${entry.def.name} timed out after ${EXECUTE_TIMEOUT_MS}ms`,
      );
    }
    return err(
      `external tool ${entry.def.name} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Create an external tool registry that integrates with SkillRegistry.
 *
 * The registry dynamically loads tools from providers on each access,
 * ensuring newly registered providers are immediately available.
 */
export interface ExternalToolRegistry {
  /** Get all external tool definitions (re-loads from storage). */
  getTools(stateLoader: StateLoader): ReadonlyArray<ToolDefinition>;

  /** Get a single external tool entry by namespaced name, or undefined if not found. */
  getTool(
    stateLoader: StateLoader,
    name: string,
  ): ExternalToolEntry | undefined;

  /** Execute an external tool by its namespaced name. */
  executeTool(
    stateLoader: StateLoader,
    name: string,
    argumentsJson: string,
    ctx: SkillRuntimeContext,
  ): Promise<Result<SkillToolResult>>;

  /** Check if a tool mutates state. */
  isMutating(stateLoader: StateLoader, name: string): boolean;
}

export const externalToolRegistry: ExternalToolRegistry = {
  getTools(stateLoader: StateLoader): ReadonlyArray<ToolDefinition> {
    const toolMap = loadExternalTools(stateLoader);
    return Array.from(toolMap.values()).map((e) => e.def);
  },

  getTool(
    stateLoader: StateLoader,
    name: string,
  ): ExternalToolEntry | undefined {
    const toolMap = loadExternalTools(stateLoader);
    return toolMap.get(name);
  },

  async executeTool(
    stateLoader: StateLoader,
    name: string,
    argumentsJson: string,
    _ctx: SkillRuntimeContext,
  ): Promise<Result<SkillToolResult>> {
    const toolMap = loadExternalTools(stateLoader);
    const entry = toolMap.get(name);

    if (!entry) {
      return err(`unknown external tool: ${name}`);
    }

    return executeExternalTool(entry, argumentsJson);
  },

  isMutating(stateLoader: StateLoader, name: string): boolean {
    const toolMap = loadExternalTools(stateLoader);
    return toolMap.get(name)?.def.mutatesState ?? false;
  },
};
