/**
 * send_message built-in tool.
 *
 * Allows the agent to proactively send a message to the user on a
 * specific channel. Validates the channel exists and can deliver,
 * then writes to the outbox for async delivery.
 */

import { err, ok } from "@shetty4l/core/result";
import {
  type StateLoader as IStateLoader,
  StateLoader,
} from "@shetty4l/core/state";
import type { ChannelRegistry } from "../channels";
import { getDatabase } from "../db";
import { enqueueOutboxMessage } from "../outbox";
import type { BuiltinTool, BuiltinToolContext } from "./index";

// Internal shim StateLoader for backward compatibility in tests
let _shimStateLoader: StateLoader | null = null;

function getShimStateLoader(): StateLoader {
  if (!_shimStateLoader) {
    _shimStateLoader = new StateLoader(getDatabase());
  }
  return _shimStateLoader;
}

export function createSendMessageTool(
  channelRegistry: ChannelRegistry,
  stateLoader?: IStateLoader,
): BuiltinTool {
  return {
    definition: {
      name: "send_message",
      description:
        "Send a message to the user on a specific channel (e.g. 'telegram'). Use this to proactively share information.",
      inputSchema: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: "Target delivery channel (e.g. 'telegram')",
          },
          text: {
            type: "string",
            description: "Message text to send",
          },
        },
        required: ["channel", "text"],
      },
      mutatesState: true,
    },

    async execute(argsJson: string, ctx: BuiltinToolContext) {
      const args = JSON.parse(argsJson) as {
        channel?: string;
        text?: string;
      };

      if (!args.channel || typeof args.channel !== "string") {
        return err("channel is required and must be a string");
      }
      if (!args.text || typeof args.text !== "string") {
        return err("text is required and must be a string");
      }

      // Validate channel exists and can deliver
      const channel = channelRegistry.get(args.channel);
      if (!channel) {
        return err(`unknown channel: '${args.channel}'`);
      }
      if (!channel.canDeliver) {
        return err(`channel '${args.channel}' cannot deliver messages`);
      }

      // Use provided stateLoader or fall back to internal shim
      const loader = stateLoader ?? getShimStateLoader();

      enqueueOutboxMessage(loader, {
        channel: args.channel,
        topicKey: ctx.topicKey,
        text: args.text,
      });

      return ok({
        content: `Message queued for delivery on ${args.channel}`,
      });
    },
  };
}
