/**
 * Task management built-in tools.
 *
 * Allows the agent to create, list, update, and complete tasks.
 * Tasks are linked to topics via topic keys (auto-created if needed).
 */

import { err, ok } from "@shetty4l/core/result";
import type { StateLoader } from "@shetty4l/core/state";
import {
  completeTask,
  createTask,
  getTask,
  listTasks,
  updateTask,
} from "../tasks";
import { getOrCreateTopicByKey, getTopicByKey } from "../topics";
import type { BuiltinTool, BuiltinToolContext } from "./index";

// --- tasks_create ---

function createTasksCreateTool(stateLoader: StateLoader): BuiltinTool {
  return {
    definition: {
      name: "tasks_create",
      description:
        "Create a new task. If topic_key is omitted, uses the current conversation's topic.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Task title",
          },
          description: {
            type: "string",
            description: "Optional task description",
          },
          topic_key: {
            type: "string",
            description:
              "Topic key to link task to (defaults to current topic)",
          },
          due_at: {
            type: "string",
            description:
              "Due date in ISO 8601 format (e.g. '2024-12-31T23:59:59Z')",
          },
        },
        required: ["title"],
      },
      mutatesState: true,
    },

    async execute(argsJson: string, ctx: BuiltinToolContext) {
      const args = JSON.parse(argsJson) as {
        title?: string;
        description?: string;
        topic_key?: string;
        due_at?: string;
      };

      if (!args.title || typeof args.title !== "string") {
        return err("title is required and must be a string");
      }

      const topicKey = args.topic_key ?? ctx.topicKey;
      if (!topicKey) {
        return err("topic_key is required when no topic context is available");
      }

      // Auto-create topic if it doesn't exist
      const topic = getOrCreateTopicByKey(stateLoader, topicKey);

      const dueAt = args.due_at ? new Date(args.due_at).getTime() : undefined;

      const task = createTask(stateLoader, {
        topic_id: topic.id,
        title: args.title,
        description: args.description,
        due_at: dueAt,
      });

      return ok({
        content: JSON.stringify({
          id: task.id,
          title: task.title,
          topic_key: topicKey,
          status: task.status,
          due_at: task.due_at ? new Date(task.due_at).toISOString() : null,
        }),
      });
    },
  };
}

// --- tasks_list ---

function createTasksListTool(stateLoader: StateLoader): BuiltinTool {
  return {
    definition: {
      name: "tasks_list",
      description:
        "List tasks, optionally filtered by topic_key and/or status.",
      inputSchema: {
        type: "object",
        properties: {
          topic_key: {
            type: "string",
            description: "Filter by topic key",
          },
          status: {
            type: "string",
            description: "Filter by status (e.g. 'pending', 'completed')",
          },
        },
        required: [],
      },
      mutatesState: false,
    },

    async execute(argsJson: string, _ctx: BuiltinToolContext) {
      const args = JSON.parse(argsJson) as {
        topic_key?: string;
        status?: string;
      };

      let topicId: string | undefined;
      if (args.topic_key) {
        const topic = getTopicByKey(stateLoader, args.topic_key);
        if (!topic) {
          return ok({ content: JSON.stringify([]) });
        }
        topicId = topic.id;
      }

      const tasks = listTasks(stateLoader, {
        topicId,
        status: args.status,
      });

      const result = tasks.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        due_at: t.due_at ? new Date(t.due_at).toISOString() : null,
        completed_at: t.completed_at
          ? new Date(t.completed_at).toISOString()
          : null,
      }));

      return ok({ content: JSON.stringify(result) });
    },
  };
}

// --- tasks_complete ---

function createTasksCompleteTool(stateLoader: StateLoader): BuiltinTool {
  return {
    definition: {
      name: "tasks_complete",
      description: "Mark a task as completed.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Task ID to complete",
          },
        },
        required: ["id"],
      },
      mutatesState: true,
    },

    async execute(argsJson: string, _ctx: BuiltinToolContext) {
      const args = JSON.parse(argsJson) as { id?: string };

      if (!args.id || typeof args.id !== "string") {
        return err("id is required and must be a string");
      }

      const task = getTask(stateLoader, args.id);
      if (!task) {
        return err(`task not found: ${args.id}`);
      }

      await completeTask(stateLoader, args.id);

      return ok({
        content: JSON.stringify({
          id: args.id,
          status: "completed",
          message: "Task marked as completed",
        }),
      });
    },
  };
}

// --- tasks_update ---

function createTasksUpdateTool(stateLoader: StateLoader): BuiltinTool {
  return {
    definition: {
      name: "tasks_update",
      description: "Update a task's title, description, status, or due date.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Task ID to update",
          },
          title: {
            type: "string",
            description: "New title",
          },
          description: {
            type: "string",
            description: "New description",
          },
          status: {
            type: "string",
            description:
              "New status (e.g. 'pending', 'in_progress', 'completed', 'cancelled')",
          },
          due_at: {
            type: "string",
            description: "New due date in ISO 8601 format",
          },
        },
        required: ["id"],
      },
      mutatesState: true,
    },

    async execute(argsJson: string, _ctx: BuiltinToolContext) {
      const args = JSON.parse(argsJson) as {
        id?: string;
        title?: string;
        description?: string;
        status?: string;
        due_at?: string;
      };

      if (!args.id || typeof args.id !== "string") {
        return err("id is required and must be a string");
      }

      const task = getTask(stateLoader, args.id);
      if (!task) {
        return err(`task not found: ${args.id}`);
      }

      const updates: {
        title?: string;
        description?: string;
        status?: string;
        due_at?: number;
      } = {};

      if (args.title !== undefined) updates.title = args.title;
      if (args.description !== undefined)
        updates.description = args.description;
      if (args.status !== undefined) updates.status = args.status;
      if (args.due_at !== undefined)
        updates.due_at = new Date(args.due_at).getTime();

      if (Object.keys(updates).length === 0) {
        return err("no fields to update");
      }

      await updateTask(stateLoader, args.id, updates);

      const updated = getTask(stateLoader, args.id);
      return ok({
        content: JSON.stringify({
          id: updated!.id,
          title: updated!.title,
          description: updated!.description,
          status: updated!.status,
          due_at: updated!.due_at
            ? new Date(updated!.due_at).toISOString()
            : null,
          message: "Task updated",
        }),
      });
    },
  };
}

// --- Export all task tools ---

export function createTaskTools(stateLoader: StateLoader): BuiltinTool[] {
  return [
    createTasksCreateTool(stateLoader),
    createTasksListTool(stateLoader),
    createTasksCompleteTool(stateLoader),
    createTasksUpdateTool(stateLoader),
  ];
}
