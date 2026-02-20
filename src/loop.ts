/**
 * Processing loop for Cortex.
 *
 * Polls the inbox for pending messages and processes them sequentially:
 *   1. Claim the oldest pending inbox message
 *   2. Recall relevant memories from Engram (topic-scoped + global)
 *   3. Load recent turn history from SQLite
 *   4. Load topic summary from SQLite (if available)
 *   5. Build prompt (system + memories + summary + history + user message)
 *   6. Call Synapse (plain chat or agent loop with tools)
 *   7. Save turns to history
 *   8. Trigger async fact extraction + summary update (fire-and-forget)
 *   9. Write the assistant response to the outbox
 *  10. Mark the inbox message as done (or failed on error)
 */

import { createLogger } from "@shetty4l/core/log";
import { runAgentLoop } from "./agent";
import type { CortexConfig } from "./config";
import {
  claimNextInboxMessage,
  completeInboxMessage,
  enqueueOutboxMessage,
  getTopicSummary,
  incrementTurnsSinceExtraction,
} from "./db";
import { recallDual } from "./engram";
import { maybeExtract } from "./extraction";
import { loadHistory, saveAgentHistory, saveTurnPair } from "./history";
import { buildPrompt } from "./prompt";
import type { SkillRegistry } from "./skills";
import type { OpenAITool } from "./synapse";
import { chat } from "./synapse";

// --- Constants ---

/** How often to check for new messages when the inbox has work. */
const DEFAULT_POLL_BUSY_MS = 100;

/** How long to wait before re-checking when the inbox was empty. */
const DEFAULT_POLL_IDLE_MS = 2_000;

const log = createLogger("cortex");

// --- Extraction concurrency ---

/**
 * Per-topic in-flight guard for extraction.
 *
 * Prevents overlapping fire-and-forget extraction runs on the same topic,
 * which would cause duplicate model/Engram calls and cursor race conditions.
 * At most one extraction runs per topic at any time; subsequent triggers
 * for an already-running topic are silently skipped (the next message will
 * re-evaluate the cursor and trigger if still due).
 */
const extractionInFlight = new Map<string, Promise<void>>();

// --- Loop ---

export interface ProcessingLoop {
  /** Stop the loop gracefully. Resolves when the current message (if any) finishes. */
  stop(): Promise<void>;
}

export interface ProcessingLoopOptions {
  /** Override busy poll interval (ms). Default: 100. */
  pollBusyMs?: number;
  /** Override idle poll interval (ms). Default: 2000. */
  pollIdleMs?: number;
}

/**
 * Start the processing loop. Claims and processes inbox messages one at a time.
 *
 * When a skill registry with tools is provided, the loop uses the agent
 * tool-calling loop (runAgentLoop). Otherwise falls back to plain chat.
 *
 * Returns a handle with a `stop()` method for graceful shutdown.
 */
export function startProcessingLoop(
  config: CortexConfig,
  registry: SkillRegistry,
  options?: ProcessingLoopOptions,
): ProcessingLoop {
  let running = true;
  const pollBusyMs = options?.pollBusyMs ?? DEFAULT_POLL_BUSY_MS;
  const pollIdleMs = options?.pollIdleMs ?? DEFAULT_POLL_IDLE_MS;

  if (!config.extractionModel) {
    log("extraction disabled — no extractionModel configured");
  }

  // Convert registry tools → OpenAI format once at loop start (cache-aware)
  const openAITools: OpenAITool[] = registry.tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));

  const hasTools = openAITools.length > 0;

  const done = (async () => {
    while (running) {
      let delay = pollIdleMs;

      try {
        const message = claimNextInboxMessage();

        if (message) {
          delay = pollBusyMs;
          const startMs = performance.now();

          const preview =
            message.text.length > 60
              ? `${message.text.slice(0, 57)}...`
              : message.text;
          log(`[${message.topic_key}] claimed: ${preview}`);

          // 1. Recall memories from Engram (graceful on failure)
          const memories = await recallDual(
            message.text,
            message.topic_key,
            config.engramUrl,
          );

          // 2. Load recent turn history
          const turns = loadHistory(message.topic_key);

          // 3. Load topic summary (fast SQLite read)
          const topicSummary = getTopicSummary(message.topic_key);

          log(
            `[${message.topic_key}] context: memories=${memories.length} turns=${turns.length}`,
          );

          // 4. Build prompt
          const messages = buildPrompt({
            memories,
            topicSummary,
            turns,
            userText: message.text,
            toolNames: openAITools.map((t) => t.function.name),
          });

          // 5. Call Synapse — agent loop with tools or plain chat
          let responseText: string;
          let ok: boolean;
          let errorMsg: string | undefined;

          if (hasTools) {
            const agentResult = await runAgentLoop({
              messages,
              tools: openAITools,
              registry,
              config: {
                model: config.model,
                synapseUrl: config.synapseUrl,
                toolTimeoutMs: config.toolTimeoutMs,
                maxToolRounds: config.maxToolRounds,
                skillConfig: config.skillConfig,
              },
            });

            if (agentResult.ok) {
              ok = true;
              responseText = agentResult.value.response;

              // Save full agent history (user message + all loop turns)
              const userMessage = {
                role: "user" as const,
                content: message.text,
              };
              saveAgentHistory(message.topic_key, [
                userMessage,
                ...agentResult.value.turns,
              ]);
            } else {
              ok = false;
              responseText = "";
              errorMsg = agentResult.error;
            }
          } else {
            // Plain chat path (no tools loaded)
            const result = await chat(
              messages,
              config.model,
              config.synapseUrl,
            );

            if (result.ok) {
              ok = true;
              responseText = result.value.content;
              saveTurnPair(message.topic_key, message.text, responseText);
            } else {
              ok = false;
              responseText = "";
              errorMsg = result.error;
            }
          }

          const elapsed = ((performance.now() - startMs) / 1000).toFixed(1);

          if (ok) {
            // 7. Trigger async extraction (fire-and-forget, serialized per topic)
            //    Always increment the turn counter — even when extraction is
            //    already in-flight — so the cadence stays accurate.
            if (config.extractionModel) {
              incrementTurnsSinceExtraction(message.topic_key);
            }
            if (!extractionInFlight.has(message.topic_key)) {
              const p = maybeExtract(message.topic_key, config)
                .catch((e) =>
                  log(
                    `[${message.topic_key}] extraction error: ${e instanceof Error ? e.message : String(e)}`,
                  ),
                )
                .finally(() => extractionInFlight.delete(message.topic_key));
              extractionInFlight.set(message.topic_key, p);
            }

            // 8. Write to outbox
            enqueueOutboxMessage({
              source: message.source,
              topicKey: message.topic_key,
              text: responseText,
            });

            completeInboxMessage(message.id);

            log(`[${message.topic_key}] done in ${elapsed}s`);
          } else {
            log(`[${message.topic_key}] failed in ${elapsed}s: ${errorMsg}`);
            completeInboxMessage(message.id, errorMsg);
          }
        }
      } catch (err) {
        // Unexpected error in the loop itself (e.g. DB failure on claim).
        // Log and continue — don't crash the loop.
        log(
          `processing loop error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (running) {
        await Bun.sleep(delay);
      }
    }
  })();

  return {
    async stop() {
      running = false;
      await done;
    },
  };
}
