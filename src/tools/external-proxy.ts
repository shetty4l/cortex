/**
 * External tool proxy factory.
 *
 * Creates BuiltinTool wrappers that proxy tool execution to external tool providers.
 * Each tool is exposed with a qualified name: "namespace.channel.tool"
 * (e.g., provider.calendar.get_events) or "channel.tool" if no namespace is provided.
 *
 * Proxy tools preserve the mutatesState flag from the provider's tool definition,
 * allowing Cortex's approval gate to work correctly.
 */

import { err, ok } from "@shetty4l/core/result";
import type { ExternalTool, ExternalToolClient } from "../external-tools";
import type { BuiltinTool, BuiltinToolContext } from "./index";

/**
 * Create a BuiltinTool that proxies execution to an external tool.
 *
 * @param client External tool client instance
 * @param externalTool Tool definition from the provider
 * @param namespace Optional namespace prefix for tool naming
 * @param timeoutMs Optional timeout for tool execution
 */
export function createExternalProxyTool(
  client: ExternalToolClient,
  externalTool: ExternalTool,
  namespace?: string,
  timeoutMs?: number,
): BuiltinTool {
  const baseName = `${externalTool.channel}.${externalTool.name}`;
  const qualifiedName = namespace ? `${namespace}.${baseName}` : baseName;

  return {
    definition: {
      name: qualifiedName,
      description: externalTool.description,
      inputSchema: externalTool.parameters,
      mutatesState: externalTool.mutatesState,
    },

    async execute(argsJson: string, _ctx: BuiltinToolContext) {
      let params: Record<string, unknown>;
      try {
        params = JSON.parse(argsJson) as Record<string, unknown>;
      } catch {
        return err(`Invalid JSON arguments: ${argsJson}`);
      }

      const result = await client.executeTool(
        externalTool.channel,
        externalTool.name,
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
 * Create BuiltinTool array from external tools.
 *
 * @param client External tool client instance
 * @param tools Array of external tool definitions
 * @param namespace Optional namespace prefix for tool naming
 * @param timeoutMs Optional timeout for tool execution
 */
export function createExternalProxyTools(
  client: ExternalToolClient,
  tools: ExternalTool[],
  namespace?: string,
  timeoutMs?: number,
): BuiltinTool[] {
  return tools.map((tool) =>
    createExternalProxyTool(client, tool, namespace, timeoutMs),
  );
}
