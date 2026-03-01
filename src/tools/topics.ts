/**
 * Topic management built-in tools.
 *
 * Allows the agent to create and list topics.
 */

import { err, ok } from "@shetty4l/core/result";
import type { StateLoader } from "@shetty4l/core/state";
import { createTopic, getTopicByKey, listTopics, updateTopic } from "../topics";
import type { BuiltinTool, BuiltinToolContext } from "./index";

// --- topics_create ---

export function createTopicsCreateTool(stateLoader: StateLoader): BuiltinTool {
  return {
    definition: {
      name: "topics_create",
      description: "Create a new topic.",
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Unique topic key for referencing",
          },
          name: {
            type: "string",
            description: "Topic name",
          },
          description: {
            type: "string",
            description: "Optional topic description",
          },
        },
        required: ["key"],
      },
      mutatesState: true,
    },

    async execute(argsJson: string, _ctx: BuiltinToolContext) {
      const args = JSON.parse(argsJson) as {
        key?: string;
        name?: string;
        description?: string;
      };

      if (!args.key || typeof args.key !== "string") {
        return err("key is required and must be a string");
      }

      const topic = createTopic(stateLoader, {
        key: args.key,
        name: args.name ?? args.key,
        description: args.description,
      });

      return ok({
        content: JSON.stringify({
          id: topic.id,
          key: topic.key,
          name: topic.name,
          description: topic.description,
          status: topic.status,
        }),
      });
    },
  };
}

// --- topics_list ---

export function createTopicsListTool(stateLoader: StateLoader): BuiltinTool {
  return {
    definition: {
      name: "topics_list",
      description: "List topics, optionally filtered by status.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description:
              "Filter by status (e.g. 'active', 'completed', 'archived')",
          },
        },
        required: [],
      },
      mutatesState: false,
    },

    async execute(argsJson: string, _ctx: BuiltinToolContext) {
      const args = JSON.parse(argsJson) as {
        status?: string;
      };

      const topics = listTopics(stateLoader, args.status);

      const result = topics.map((t) => ({
        id: t.id,
        key: t.key,
        name: t.name,
        description: t.description,
        status: t.status,
      }));

      return ok({ content: JSON.stringify(result) });
    },
  };
}

// --- topics_update ---

export function createTopicsUpdateTool(stateLoader: StateLoader): BuiltinTool {
  return {
    definition: {
      name: "topics_update",
      description: "Update a topic's name, description, or status.",
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Topic key to update",
          },
          name: {
            type: "string",
            description: "New name",
          },
          description: {
            type: "string",
            description: "New description",
          },
          status: {
            type: "string",
            description: "New status (e.g. 'active', 'completed', 'archived')",
          },
        },
        required: ["key"],
      },
      mutatesState: true,
    },

    async execute(argsJson: string, _ctx: BuiltinToolContext) {
      const args = JSON.parse(argsJson) as {
        key?: string;
        name?: string;
        description?: string;
        status?: string;
      };

      if (!args.key || typeof args.key !== "string") {
        return err("key is required and must be a string");
      }

      const topic = getTopicByKey(stateLoader, args.key);
      if (!topic) {
        return err(`topic not found: ${args.key}`);
      }

      const updates: {
        name?: string;
        description?: string;
        status?: string;
      } = {};

      if (args.name !== undefined) updates.name = args.name;
      if (args.description !== undefined)
        updates.description = args.description;
      if (args.status !== undefined) updates.status = args.status;

      if (Object.keys(updates).length === 0) {
        return err("no fields to update");
      }

      await updateTopic(stateLoader, topic.id, updates);

      const updated = getTopicByKey(stateLoader, args.key);
      return ok({
        content: JSON.stringify({
          id: updated!.id,
          key: updated!.key,
          name: updated!.name,
          description: updated!.description,
          status: updated!.status,
          message: "Topic updated",
        }),
      });
    },
  };
}

// --- topics_close ---

export function createTopicsCloseTool(stateLoader: StateLoader): BuiltinTool {
  return {
    definition: {
      name: "topics_close",
      description: "Close a topic by setting its status to 'completed'.",
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Topic key to close",
          },
        },
        required: ["key"],
      },
      mutatesState: true,
    },

    async execute(argsJson: string, _ctx: BuiltinToolContext) {
      const args = JSON.parse(argsJson) as {
        key?: string;
      };

      if (!args.key || typeof args.key !== "string") {
        return err("key is required and must be a string");
      }

      const topic = getTopicByKey(stateLoader, args.key);
      if (!topic) {
        return err(`topic not found: ${args.key}`);
      }

      await updateTopic(stateLoader, topic.id, { status: "completed" });

      const updated = getTopicByKey(stateLoader, args.key);
      return ok({
        content: JSON.stringify({
          id: updated!.id,
          key: updated!.key,
          name: updated!.name,
          status: updated!.status,
          message: "Topic closed",
        }),
      });
    },
  };
}

// --- Export all topic tools ---

export function createTopicTools(stateLoader: StateLoader): BuiltinTool[] {
  return [
    createTopicsCreateTool(stateLoader),
    createTopicsListTool(stateLoader),
    createTopicsUpdateTool(stateLoader),
    createTopicsCloseTool(stateLoader),
  ];
}
