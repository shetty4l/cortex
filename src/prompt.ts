/**
 * Prompt assembly for Cortex.
 *
 * Builds the messages array sent to Synapse from:
 * 1. System prompt (identity + behavior + capability grounding)
 * 2. Recalled memories (from Engram)
 * 3. Topic summary (rolling 1-2 sentence orientation)
 * 4. Recent turn history (from SQLite)
 * 5. Current user message
 */

import type { Memory } from "./engram";
import type { ChatMessage } from "./synapse";

// --- Constants ---

/** Wilson's core identity line. Exported for test assertions. */
export const WILSON_IDENTITY =
  "You are Wilson, a personal life assistant. You are direct, concise, and honest.";

const CAPABILITIES_NO_TOOLS =
  "Right now you can only have conversations and recall what you know about the user. You cannot set reminders, access calendars, search the web, book travel, or perform any actions beyond conversation. If the user asks you to do something you cannot do, say so honestly.";

const MEMORY_INSTRUCTIONS =
  "Facts and preferences you know about the user are listed below. Use them naturally in conversation. If you don't have information about something, say so — do not guess or make things up.";

const FORMATTING_RULES =
  "Keep responses concise. Use short bullet lists when helpful. Do not use markdown tables.";

const MEMORY_HEADER = "What you know about the user:";

const SUMMARY_HEADER = "Current conversation context:";

// --- System prompt builder ---

/**
 * Build the system prompt with dynamic capability grounding.
 *
 * When tools are available, lists them explicitly so Wilson knows what
 * it can do. When no tools are loaded, states conversational-only limits.
 */
export function buildSystemPrompt(toolNames: string[]): string {
  const sections = [WILSON_IDENTITY];

  if (toolNames.length === 0) {
    sections.push(CAPABILITIES_NO_TOOLS);
  } else {
    sections.push(
      `You have access to these tools: ${toolNames.join(", ")}. Only offer to do things you have tools for. NEVER claim you can perform actions you don't have a tool for.`,
    );
  }

  sections.push(MEMORY_INSTRUCTIONS);
  sections.push(FORMATTING_RULES);

  return sections.join("\n\n");
}

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
  /** Tool names available to the agent (may be empty). */
  toolNames?: string[];
}

/**
 * Build the full messages array for a Synapse chat completion call.
 *
 * Layout:
 * - System message (always present, includes capability grounding)
 * - Memory block appended to system message (if memories present)
 * - Topic summary appended to system message (if summary present)
 * - Turn history (alternating user/assistant messages)
 * - Current user message (always present)
 */
export function buildPrompt(opts: BuildPromptOpts): ChatMessage[] {
  const { memories, topicSummary, turns, userText, toolNames = [] } = opts;
  const messages: ChatMessage[] = [];

  // 1. System message (with optional memory block and topic summary)
  let systemContent = buildSystemPrompt(toolNames);

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
