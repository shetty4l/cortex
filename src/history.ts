/**
 * Turn history management for Cortex.
 *
 * Thin wrapper over the turns table — saves user/assistant turn pairs
 * and loads recent turns as ChatMessage[] for prompt assembly.
 */

import { saveTurn as insertTurn, loadRecentTurns as loadTurns } from "./db";
import type { ChatMessage } from "./synapse";

/**
 * Save a user/assistant turn pair for a topic.
 */
export function saveTurnPair(
  topicKey: string,
  userText: string,
  assistantText: string,
): void {
  insertTurn(topicKey, "user", userText);
  insertTurn(topicKey, "assistant", assistantText);
}

/**
 * Load recent turns for a topic as ChatMessage[].
 *
 * Returns up to `limit` turn pairs (limit * 2 messages), ordered oldest-first.
 * Ready to splice directly into a prompt's messages array.
 *
 * @param limit Maximum number of turn pairs (default 8 → 16 messages max).
 */
export function loadHistory(topicKey: string, limit = 8): ChatMessage[] {
  const turns = loadTurns(topicKey, limit);
  return turns.map((t) => ({
    role: t.role as "user" | "assistant",
    content: t.content,
  }));
}
