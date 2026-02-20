/**
 * Prompt assembly for Cortex.
 *
 * Builds the messages array sent to Synapse from:
 * 1. System prompt (loaded from template file or default, rendered once at startup)
 * 2. Recalled memories (from Engram)
 * 3. Topic summary (rolling 1-2 sentence orientation)
 * 4. Recent turn history (from SQLite)
 * 5. Current user message
 *
 * The system prompt is the static prefix of every request. Rendering it once
 * and reusing the frozen string ensures byte-identical prefixes across messages,
 * enabling KV-cache reuse on local models and automatic prefix caching on
 * cloud providers.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "@shetty4l/core/log";
import type { Memory } from "./engram";
import type { ChatMessage } from "./synapse";
import { renderTemplate } from "./template";

const log = createLogger("cortex");

// --- Constants ---

/**
 * Default system prompt template. Used when no systemPromptFile is configured,
 * or as the initial content written to the file path on first run.
 *
 * Minimal and unopinionated — no name, no personality. Users customize by
 * editing their local copy at the configured systemPromptFile path.
 */
export const DEFAULT_SYSTEM_PROMPT_TEMPLATE = `You are a personal life assistant. You are direct, concise, and honest.

{{#if toolNames}}
You have access to these tools: {{toolNames}}. Only offer to do things you have tools for.
{{else}}
You can only have conversations right now. If asked to do something you cannot do, say so.
{{/if}}

Use any known facts about the user naturally. If you don't know something, say so — do not guess.

Keep responses concise.`;

const MEMORY_HEADER = "What you know about the user:";

const SUMMARY_HEADER = "Current conversation context:";

// --- System prompt loader ---

/**
 * Load and render the system prompt template.
 *
 * Called once at loop startup. The returned string is frozen and reused for
 * every message to maintain a stable prefix for KV-cache.
 *
 * - If templatePath is set and the file exists, reads it.
 * - If templatePath is set but the file doesn't exist, writes the default
 *   template to that path (creating parent dirs) so the user has a starting
 *   point to edit.
 * - If templatePath is not set, uses the embedded default.
 */
export function loadAndRenderSystemPrompt(opts: {
  templatePath?: string;
  toolNames: string[];
}): string {
  let template: string;

  if (opts.templatePath) {
    if (existsSync(opts.templatePath)) {
      template = readFileSync(opts.templatePath, "utf-8");
      log(`loaded system prompt from ${opts.templatePath}`);
    } else {
      // Write default so user has a starting point to edit
      const dir = dirname(opts.templatePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(opts.templatePath, DEFAULT_SYSTEM_PROMPT_TEMPLATE, "utf-8");
      template = DEFAULT_SYSTEM_PROMPT_TEMPLATE;
      log(`wrote default system prompt to ${opts.templatePath}`);
    }
  } else {
    template = DEFAULT_SYSTEM_PROMPT_TEMPLATE;
  }

  return renderTemplate(template, {
    toolNames: opts.toolNames.join(", "),
  });
}

// --- Prompt builder ---

export interface BuildPromptOpts {
  /** Pre-rendered system prompt (frozen at loop startup). */
  systemPrompt: string;
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
 * - System message (pre-rendered, frozen prefix for cache)
 * - Memory block appended to system message (if memories present)
 * - Topic summary appended to system message (if summary present)
 * - Turn history (alternating user/assistant messages)
 * - Current user message (always present)
 */
export function buildPrompt(opts: BuildPromptOpts): ChatMessage[] {
  const { systemPrompt, memories, topicSummary, turns, userText } = opts;
  const messages: ChatMessage[] = [];

  // 1. System message (with optional memory block and topic summary)
  let systemContent = systemPrompt;

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
