/**
 * Prompt assembly for Cortex.
 *
 * Builds the messages array sent to Synapse from:
 * 1. System prompt (identity + behavior)
 * 2. Recalled memories (from Engram)
 * 3. Topic summary (rolling 1-2 sentence orientation)
 * 4. Recent turn history (from SQLite)
 * 5. Current user message
 */

import type { Memory } from "./engram";
import type { ChatMessage } from "./synapse";

// --- Constants ---

export const SYSTEM_PROMPT =
  "You are Cortex, a helpful life assistant. Be concise, direct, and actionable.";

const MEMORY_HEADER =
  "These are facts and preferences you've learned about the user:";

const SUMMARY_HEADER = "Current conversation context:";

// --- Prompt builder ---

export interface BuildPromptOpts {
  /** Recalled memories from Engram (may be empty). */
  memories: Memory[];
  /** Rolling topic summary (null if no summary exists yet). */
  topicSummary?: string | null;
  /** Recent turn history as ChatMessage[] (may be empty). */
  turns: ChatMessage[];
  /** The current user message text. */
  userText: string;
}

/**
 * Build the full messages array for a Synapse chat completion call.
 *
 * Layout:
 * - System message (always present)
 * - Memory block appended to system message (if memories present)
 * - Topic summary appended to system message (if summary present)
 * - Turn history (alternating user/assistant messages)
 * - Current user message (always present)
 */
export function buildPrompt(opts: BuildPromptOpts): ChatMessage[] {
  const { memories, topicSummary, turns, userText } = opts;
  const messages: ChatMessage[] = [];

  // 1. System message (with optional memory block and topic summary)
  let systemContent = SYSTEM_PROMPT;

  if (memories.length > 0) {
    const memoryBlock = memories.map((m) => `- ${m.content}`).join("\n");
    systemContent += `\n\n${MEMORY_HEADER}\n${memoryBlock}`;
  }

  if (topicSummary) {
    systemContent += `\n\n${SUMMARY_HEADER}\n${topicSummary}`;
  }

  messages.push({ role: "system", content: systemContent });

  // 2. Turn history (preserve tool_calls, tool_call_id, name for tool-calling exchanges)
  for (const turn of turns) {
    const msg: ChatMessage = { role: turn.role, content: turn.content };
    if (turn.tool_calls) msg.tool_calls = turn.tool_calls;
    if (turn.tool_call_id) msg.tool_call_id = turn.tool_call_id;
    if (turn.name) msg.name = turn.name;
    messages.push(msg);
  }

  // 3. Current user message
  messages.push({ role: "user", content: userText });

  return messages;
}
