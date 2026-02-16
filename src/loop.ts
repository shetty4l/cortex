/**
 * Processing loop for Cortex.
 *
 * Polls the inbox for pending messages and processes them sequentially:
 *   1. Claim the oldest pending inbox message
 *   2. Build a minimal prompt (system + user message)
 *   3. Call Synapse for a chat completion
 *   4. Write the assistant response to the outbox
 *   5. Mark the inbox message as done (or failed on error)
 *
 * Slice 2 is the tracer bullet — no history, no Engram recall, no tools.
 * Those are layered on in Slices 3-7.
 */

import type { CortexConfig } from "./config";
import {
  claimNextInboxMessage,
  completeInboxMessage,
  enqueueOutboxMessage,
} from "./db";
import { chat } from "./synapse";

// --- Constants ---

/** How often to check for new messages when the inbox has work. */
const POLL_INTERVAL_BUSY_MS = 100;

/** How long to wait before re-checking when the inbox was empty. */
const POLL_INTERVAL_IDLE_MS = 2_000;

const SYSTEM_PROMPT =
  "You are Cortex, a helpful life assistant. Be concise, direct, and actionable.";

// --- Loop ---

export interface ProcessingLoop {
  /** Stop the loop gracefully. Resolves when the current message (if any) finishes. */
  stop(): Promise<void>;
}

/**
 * Start the processing loop. Claims and processes inbox messages one at a time.
 *
 * Returns a handle with a `stop()` method for graceful shutdown.
 */
export function startProcessingLoop(config: CortexConfig): ProcessingLoop {
  let running = true;

  const done = (async () => {
    while (running) {
      let delay = POLL_INTERVAL_IDLE_MS;

      try {
        const message = claimNextInboxMessage();

        if (message) {
          delay = POLL_INTERVAL_BUSY_MS;

          try {
            const response = await chat(
              [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: message.text },
              ],
              config.model,
              config.synapseUrl,
            );

            enqueueOutboxMessage({
              source: message.source,
              topicKey: message.topic_key,
              text: response.content,
            });

            completeInboxMessage(message.id);
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            console.error(
              `Failed to process inbox message ${message.id}:`,
              reason,
            );
            completeInboxMessage(message.id, reason);
          }
        }
      } catch (err) {
        // Unexpected error in the loop itself (e.g. DB failure on claim).
        // Log and continue — don't crash the loop.
        console.error("Processing loop error:", err);
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
