/**
 * Turn history management for Cortex.
 *
 * Thin wrapper over the turns module — saves user/assistant turn pairs
 * and loads recent turns as ChatMessage[] for prompt assembly.
 *
 * Supports both simple turn pairs (saveTurnPair) and full agent loop
 * histories (saveAgentHistory) with tool calls and tool results.
 *
 * All functions require a StateLoader instance as the first parameter.
 */

import { type StateLoader as IStateLoader } from "@shetty4l/core/state";
import type { ChatMessage } from "./synapse";
import {
  saveTurn as insertTurn,
  loadRecentTurns as loadTurns,
  saveAgentTurns,
  type Turn,
} from "./turns";

// --- Turn conversion ---

function turnToMessage(t: Turn): ChatMessage {
  const msg: ChatMessage = {
    role: t.role as ChatMessage["role"],
    content: t.content ?? "",
  };
  if (t.tool_call_id) msg.tool_call_id = t.tool_call_id;
  if (t.tool_calls) {
    try {
      msg.tool_calls = JSON.parse(t.tool_calls);
    } catch {
      // Malformed JSON — skip tool_calls field
    }
  }
  if (t.name) msg.name = t.name;
  return msg;
}

function groupTurnsByUser(turns: Turn[], limit: number): ChatMessage[] {
  if (turns.length === 0) return [];

  // Group turns by user messages: each group starts at a user message
  // and includes everything until the next user message.
  const groups: ChatMessage[][] = [];
  let currentGroup: ChatMessage[] = [];

  for (const t of turns) {
    if (t.role === "user" && currentGroup.length > 0) {
      groups.push(currentGroup);
      currentGroup = [];
    }
    currentGroup.push(turnToMessage(t));
  }
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  // Take the last `limit` groups and flatten
  const trimmed = groups.slice(-limit);
  return trimmed.flat();
}

// --- New API (with stateLoader) ---

/**
 * Save a user/assistant turn pair for a topic.
 * New API with explicit stateLoader parameter.
 */
export async function saveTurnPairWithLoader(
  stateLoader: IStateLoader,
  topicKey: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  await insertTurn(stateLoader, { topicKey, role: "user", content: userText });
  await insertTurn(stateLoader, {
    topicKey,
    role: "assistant",
    content: assistantText,
  });
}

/**
 * Save an agent loop's turns for a topic.
 * New API with explicit stateLoader parameter.
 *
 * Expects the full sequence: [user message, ...assistant+tool messages from loop].
 * Uses a single transaction for atomicity.
 */
export async function saveAgentHistoryWithLoader(
  stateLoader: IStateLoader,
  topicKey: string,
  turns: ChatMessage[],
): Promise<void> {
  await saveAgentTurns(
    stateLoader,
    topicKey,
    turns.map((t) => ({
      role: t.role,
      content: t.content ?? null,
      tool_call_id: t.tool_call_id,
      tool_calls: t.tool_calls,
      name: t.name,
    })),
  );
}

/**
 * Load recent turns for a topic as ChatMessage[].
 * New API with explicit stateLoader parameter.
 *
 * `limit` counts USER messages (not total messages). Loads enough rows
 * to capture the last `limit` user-message groups, where a "group" is
 * one user message plus all following assistant/tool messages until the
 * next user message.
 *
 * @param limit Maximum number of user-message groups (default 8).
 */
export function loadHistoryWithLoader(
  stateLoader: IStateLoader,
  topicKey: string,
  limit = 8,
): ChatMessage[] {
  // Load a generous number of rows to ensure we get enough user messages.
  // With tool calling, a single user group can have many messages
  // (user + assistant-with-tools + N tool-results + final-assistant).
  // Use limit * 8 to handle heavy tool-use topics (e.g. 3 parallel tools,
  // 2 rounds per exchange = ~8 messages per user group).
  const turns = loadTurns(stateLoader, topicKey, limit * 8);
  return groupTurnsByUser(turns, limit);
}
