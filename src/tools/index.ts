/**
 * Built-in tools for Cortex.
 *
 * Built-in tools are first-party primitives that run inside the agent loop
 * with direct access to cortex internals (outbox, channels, config).
 * They are NOT namespaced — tool names are bare (e.g. "send_message").
 *
 * External skills loaded from skillDirs are namespaced as "skillId.toolName".
 */

import type { Result } from "@shetty4l/core/result";
import type { CortexConfig } from "../config";
import type { SkillRegistry, SkillToolResult, ToolDefinition } from "../skills";

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
  const channel = SYSTEM_CHANNELS.has(inputChannel) ? "silent" : inputChannel;
  if (channel === "silent" && config.silentChannelAlias) {
    return config.silentChannelAlias;
  }
  return channel;
}

// --- Combined registry ---

/**
 * Create a unified SkillRegistry that dispatches to built-in tools first,
 * then falls through to the external skill registry.
 *
 * Built-in tools receive a BuiltinToolContext (topicKey, etc.) instead of
 * the SkillRuntimeContext used by external skills.
 *
 * @param builtinTools Array of built-in tool definitions + executors.
 * @param skillRegistry External skill registry loaded from skillDirs.
 * @param getContext Closure that returns the current per-message context.
 */
export function createCombinedRegistry(
  builtinTools: BuiltinTool[],
  skillRegistry: SkillRegistry,
  getContext: () => BuiltinToolContext,
): SkillRegistry {
  const builtinMap = new Map(builtinTools.map((t) => [t.definition.name, t]));

  const allTools: ReadonlyArray<ToolDefinition> = [
    ...builtinTools.map((t) => t.definition),
    ...skillRegistry.tools,
  ];

  return {
    tools: allTools,

    async executeTool(name, argumentsJson, ctx) {
      const builtin = builtinMap.get(name);
      if (builtin) {
        return builtin.execute(argumentsJson, getContext());
      }
      return skillRegistry.executeTool(name, argumentsJson, ctx);
    },

    isMutating(name) {
      const builtin = builtinMap.get(name);
      if (builtin) return builtin.definition.mutatesState;
      return skillRegistry.isMutating(name);
    },
  };
}
