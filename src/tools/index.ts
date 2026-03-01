/**
 * Built-in tools for Cortex.
 *
 * Built-in tools are first-party primitives that run inside the agent loop
 * with direct access to cortex internals (outbox, channels, config).
 * They are NOT namespaced — tool names are bare (e.g. "tasks_create").
 *
 * External skills loaded from skillDirs are namespaced as "skillId.toolName".
 * External tools from registered providers are namespaced as "providerId.toolName".
 */

import type { Result } from "@shetty4l/core/result";
import type { StateLoader } from "@shetty4l/core/state";
import type { CortexConfig } from "../config";
import type { SkillRegistry, SkillToolResult, ToolDefinition } from "../skills";
import { executeExternalTool, externalToolRegistry } from "./external-proxy";

// --- Types ---

/** Mutable context updated per-message in the processing loop. */
export interface BuiltinToolContext {
  /** Topic key of the message currently being processed. */
  topicKey: string;
}

/** A built-in tool with direct access to cortex internals. */
export interface BuiltinTool {
  readonly definition: ToolDefinition;
  execute(
    argsJson: string,
    ctx: BuiltinToolContext,
  ): Promise<Result<SkillToolResult>>;
}

// --- Output channel resolution ---

/** Channels that are internal (system) and should not receive user-facing responses. */
const SYSTEM_CHANNELS = new Set(["thalamus", "calendar"]);

/**
 * Resolve the output channel for a response.
 *
 * - If the input channel is a system channel, route to "silent".
 * - If the channel is "silent" and an alias is configured, redirect to the alias.
 * - Otherwise, return the channel unchanged (echo back to sender).
 */
export function resolveOutputChannel(
  inputChannel: string,
  config: Pick<CortexConfig, "silentChannelAlias">,
): string {
  // TODO: Remove when Cerebellum slow-path routes tick messages properly
  const channel =
    inputChannel === "tick"
      ? "telegram"
      : SYSTEM_CHANNELS.has(inputChannel)
        ? "silent"
        : inputChannel;
  if (channel === "silent" && config.silentChannelAlias) {
    return config.silentChannelAlias;
  }
  return channel;
}

// --- Combined registry ---

/** Options for creating a combined registry. */
export interface CombinedRegistryOptions {
  /** StateLoader for accessing external tool providers. */
  stateLoader?: StateLoader;
}

/**
 * Create a unified SkillRegistry that dispatches to built-in tools first,
 * then external tool providers, then falls through to the skill registry.
 *
 * Built-in tools receive a BuiltinToolContext (topicKey, etc.) instead of
 * the SkillRuntimeContext used by external skills.
 *
 * External tools from registered providers are loaded dynamically so that
 * newly registered providers are immediately available.
 *
 * @param builtinTools Array of built-in tool definitions + executors.
 * @param skillRegistry External skill registry loaded from skillDirs.
 * @param getContext Closure that returns the current per-message context.
 * @param options Optional configuration including stateLoader for external tools.
 */
export function createCombinedRegistry(
  builtinTools: BuiltinTool[],
  skillRegistry: SkillRegistry,
  getContext: () => BuiltinToolContext,
  options?: CombinedRegistryOptions,
): SkillRegistry {
  const builtinMap = new Map(builtinTools.map((t) => [t.definition.name, t]));
  const stateLoader = options?.stateLoader;

  // Build static tool list (external tools added dynamically in getter)
  const staticTools: ToolDefinition[] = [
    ...builtinTools.map((t) => t.definition),
    ...skillRegistry.tools,
  ];

  return {
    // Tools getter returns static tools + current external tools from providers
    get tools(): ReadonlyArray<ToolDefinition> {
      if (!stateLoader) return staticTools;
      const externalTools = externalToolRegistry.getTools(stateLoader);
      return [...staticTools, ...externalTools];
    },

    async executeTool(name, argumentsJson, ctx) {
      // 1. Check built-in tools first
      const builtin = builtinMap.get(name);
      if (builtin) {
        return builtin.execute(argumentsJson, getContext());
      }

      // 2. Check external tool providers (namespaced as providerId.toolName)
      if (stateLoader && name.includes(".")) {
        const entry = externalToolRegistry.getTool(stateLoader, name);
        if (entry) {
          return executeExternalTool(entry, argumentsJson);
        }
      }

      // 3. Fall through to skill registry
      return skillRegistry.executeTool(name, argumentsJson, ctx);
    },

    isMutating(name) {
      // 1. Check built-in tools
      const builtin = builtinMap.get(name);
      if (builtin) return builtin.definition.mutatesState;

      // 2. Check external tools
      if (stateLoader && name.includes(".")) {
        const entry = externalToolRegistry.getTool(stateLoader, name);
        if (entry) {
          return entry.def.mutatesState ?? false;
        }
      }

      // 3. Fall through to skill registry
      return skillRegistry.isMutating(name);
    },
  };
}
