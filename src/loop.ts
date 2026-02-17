/**
 * Processing loop for Cortex.
 *
 * Polls the inbox for pending messages and processes them sequentially:
 *   1. Claim the oldest pending inbox message
 *   2. Recall relevant memories from Engram (topic-scoped + global)
 *   3. Load recent turn history from SQLite
 *   4. Build prompt (system + memories + history + user message)
 *   5. Call Synapse for a chat completion
 *   6. Save the turn pair (user + assistant) to history
 *   7. Write the assistant response to the outbox
 *   8. Mark the inbox message as done (or failed on error)
 */

import type { CortexConfig } from "./config";
import {
  claimNextInboxMessage,
  completeInboxMessage,
  enqueueOutboxMessage,
} from "./db";
import { recallDual } from "./engram";
import { loadHistory, saveTurnPair } from "./history";
import { buildPrompt } from "./prompt";
import { chat } from "./synapse";

// --- Constants ---

/** How often to check for new messages when the inbox has work. */
const DEFAULT_POLL_BUSY_MS = 100;

/** How long to wait before re-checking when the inbox was empty. */
const DEFAULT_POLL_IDLE_MS = 2_000;

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
 * Returns a handle with a `stop()` method for graceful shutdown.
 */
export function startProcessingLoop(
  config: CortexConfig,
  options?: ProcessingLoopOptions,
): ProcessingLoop {
  let running = true;
  const pollBusyMs = options?.pollBusyMs ?? DEFAULT_POLL_BUSY_MS;
  const pollIdleMs = options?.pollIdleMs ?? DEFAULT_POLL_IDLE_MS;

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
          console.error(`cortex: [${message.topic_key}] claimed: ${preview}`);

          // 1. Recall memories from Engram (graceful on failure)
          const memories = await recallDual(
            message.text,
            message.topic_key,
            config.engramUrl,
          );

          // 2. Load recent turn history
          const turns = loadHistory(message.topic_key);

          console.error(
            `cortex: [${message.topic_key}] context: memories=${memories.length} turns=${turns.length}`,
          );

          // 3. Build prompt
          const messages = buildPrompt({
            memories,
            turns,
            userText: message.text,
          });

          // 4. Call Synapse
          const result = await chat(messages, config.model, config.synapseUrl);

          const elapsed = ((performance.now() - startMs) / 1000).toFixed(1);

          if (result.ok) {
            // 5. Save turn pair to history
            saveTurnPair(message.topic_key, message.text, result.value.content);

            // 6. Write to outbox
            enqueueOutboxMessage({
              source: message.source,
              topicKey: message.topic_key,
              text: result.value.content,
            });

            completeInboxMessage(message.id);

            console.error(`cortex: [${message.topic_key}] done in ${elapsed}s`);
          } else {
            console.error(
              `cortex: [${message.topic_key}] failed in ${elapsed}s: ${result.error}`,
            );
            completeInboxMessage(message.id, result.error);
          }
        }
      } catch (err) {
        // Unexpected error in the loop itself (e.g. DB failure on claim).
        // Log and continue — don't crash the loop.
        console.error("cortex: processing loop error:", err);
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
