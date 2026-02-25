/**
 * Wilson proxy tool factory.
 *
 * Creates BuiltinTool wrappers that proxy tool execution to a Wilson server.
 * Each Wilson tool is exposed with a qualified name: "channel.tool"
 * (e.g., calendar.get_events).
 *
 * Proxy tools preserve the mutatesState flag from Wilson's tool definition,
 * allowing Cortex's approval gate to work correctly.
 */

import { err, ok } from "@shetty4l/core/result";
import type { WilsonClient, WilsonTool } from "../wilson";
import type { BuiltinTool, BuiltinToolContext } from "./index";

/**
 * Create a BuiltinTool that proxies execution to a Wilson tool.
 *
 * @param client Wilson client instance
 * @param wilsonTool Tool definition from Wilson
 * @param timeoutMs Optional timeout for tool execution
 */
export function createWilsonProxyTool(
  client: WilsonClient,
  wilsonTool: WilsonTool,
  timeoutMs?: number,
): BuiltinTool {
  const qualifiedName = `${wilsonTool.channel}.${wilsonTool.name}`;

  return {
    definition: {
      name: qualifiedName,
      description: wilsonTool.description,
      inputSchema: wilsonTool.parameters,
      mutatesState: wilsonTool.mutatesState,
    },

    async execute(argsJson: string, _ctx: BuiltinToolContext) {
      let params: Record<string, unknown>;
      try {
        params = JSON.parse(argsJson) as Record<string, unknown>;
      } catch {
        return err(`Invalid JSON arguments: ${argsJson}`);
      }

      const result = await client.executeTool(
        wilsonTool.channel,
        wilsonTool.name,
        params,
        timeoutMs,
      );

      if (!result.ok) {
        return err(result.error);
      }

      return ok({
        content: result.value.content,
        ...(result.value.metadata && { metadata: result.value.metadata }),
      });
    },
  };
}

/**
 * Create BuiltinTool array from Wilson tools.
 *
 * @param client Wilson client instance
 * @param tools Array of Wilson tool definitions
 * @param timeoutMs Optional timeout for tool execution
 */
export function createWilsonProxyTools(
  client: WilsonClient,
  tools: WilsonTool[],
  timeoutMs?: number,
): BuiltinTool[] {
  return tools.map((tool) => createWilsonProxyTool(client, tool, timeoutMs));
}
