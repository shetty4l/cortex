/**
 * Processing loop for Cortex.
 *
 * Polls the inbox for pending messages and processes them sequentially:
 *   1. Claim the oldest pending inbox message
 *   2. Check for pending approvals - block new messages if approval pending
 *   3. Handle approval_response messages specially
 *   4. Recall relevant memories from Engram (topic-scoped + global)
 *   5. Load recent turn history from SQLite
 *   6. Load topic summary from SQLite (if available)
 *   7. Build prompt (system + memories + summary + history + user message)
 *   8. Call Synapse (plain chat or agent loop with tools)
 *   9. If agent returns needsApproval, send approval request with buttons
 *  10. Save turns to history
 *  11. Trigger async fact extraction + summary update (fire-and-forget)
 *  12. Write the assistant response to the outbox
 *  13. Mark the inbox message as done (or failed on error)
 */

import { createLogger } from "@shetty4l/core/log";
import { runAgentLoop } from "./agent";
import {
  getApprovalById,
  isExpired,
  listPendingApprovals,
  proposeApproval,
  resolveApproval,
} from "./approval";
import type { CortexConfig } from "./config";
import { getDatabase } from "./db";
import { getDebugLogger } from "./debug-logger";
import { recallDual } from "./engram";
import { maybeExtract } from "./extraction";
import {
  loadHistoryWithLoader,
  saveAgentHistoryWithLoader,
  saveTurnPairWithLoader,
} from "./history";
import {
  claimNextInboxMessage,
  completeInboxMessage,
  getInboxMessage,
  retryInboxMessage,
} from "./inbox";
import { enqueueOutboxMessage } from "./outbox";
import { buildPrompt, loadAndRenderSystemPrompt } from "./prompt";
import type { SkillRegistry } from "./skills";
import {
  ExtractionCursorState,
  type StateLoader as IStateLoader,
  StateLoader,
  TopicSummaryState,
} from "./state";
import type { ChatMessage, OpenAITool, ToolCall } from "./synapse";
import { chat } from "./synapse";
import type { BuiltinToolContext } from "./tools";
import { resolveOutputChannel } from "./tools";
import { generateTraceId, runWithTraceId } from "./trace";

// --- Constants ---

/** How often to check for new messages when the inbox has work. */
const DEFAULT_POLL_BUSY_MS = 100;

/** How long to wait before re-checking when the inbox was empty. */
const DEFAULT_POLL_IDLE_MS = 2_000;

const log = createLogger("cortex");

// --- Transient error detection ---

/**
 * Detect whether an error message indicates a transient failure
 * that should be retried (vs a permanent failure).
 *
 * Transient: rate limits, server errors, timeouts, connection failures.
 * Permanent: bad requests, auth failures, model errors.
 */
const TRANSIENT_ERROR_PATTERN =
  /\b(429|502|503|504|timed?\s*out|ECONNREFUSED|ECONNRESET)\b/i;

export function isTransientError(error: string): boolean {
  return TRANSIENT_ERROR_PATTERN.test(error);
}

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
  /** Mutable context shared with built-in tools (topicKey updated per message). */
  builtinContext?: BuiltinToolContext;
  /** StateLoader for persisted state classes. */
  stateLoader?: IStateLoader;
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
  const builtinCtx = options?.builtinContext;

  // Helper to get a StateLoader - uses provided one or creates from current database
  // Creating from getDatabase() each time allows tests to re-init the database
  const getLoader = (): IStateLoader => {
    return options?.stateLoader ?? new StateLoader(getDatabase());
  };

  if (!config.extractionModels) {
    log("extraction disabled — no extractionModels configured");
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

  // Render system prompt once (frozen prefix for KV-cache reuse)
  const systemPrompt = loadAndRenderSystemPrompt({
    templatePath: config.systemPromptFile,
    toolNames: openAITools.map((t) => t.function.name),
  });

  const done = (async () => {
    while (running) {
      let delay = pollIdleMs;

      try {
        // Get a fresh StateLoader on each iteration to handle test DB resets
        const stateLoader = getLoader();

        const message = await claimNextInboxMessage(stateLoader);

        if (message) {
          delay = pollBusyMs;

          // Generate trace ID for this message
          const traceId = generateTraceId();

          // Process within trace context
          await runWithTraceId(traceId, async () => {
            const startMs = performance.now();
            const debug = getDebugLogger();

            // Update built-in tool context for this message
            if (builtinCtx) {
              builtinCtx.topicKey = message.topic_key;
            }

            const preview =
              message.text.length > 60
                ? `${message.text.slice(0, 57)}...`
                : message.text;
            log(`[${message.topic_key}] claimed: ${preview}`);

            // Emit claim event
            if (debug.isEnabled()) {
              debug.log({
                type: "claim",
                traceId,
                timestamp: new Date().toISOString(),
                topicKey: message.topic_key,
                channel: message.channel,
                textPreview: preview,
                inboxId: message.id,
              });
            }

            // Handle approval_response messages specially
            const metadata = message.metadata_json
              ? (JSON.parse(message.metadata_json) as Record<string, unknown>)
              : null;
            if (metadata?.type === "approval_response") {
              const approvalId = metadata.approvalId as string;
              const action = metadata.action as "approve" | "reject";

              log(
                `[${message.topic_key}] approval response: ${approvalId} -> ${action}`,
              );

              const approval = getApprovalById(stateLoader, approvalId);

              if (!approval) {
                enqueueOutboxMessage(stateLoader, {
                  channel: resolveOutputChannel(message.channel, config),
                  topicKey: message.topic_key,
                  text: "This approval request was not found or has already been processed.",
                });
                const processingMs = Math.round(performance.now() - startMs);
                await completeInboxMessage(
                  stateLoader,
                  message.id,
                  processingMs,
                );
                return;
              }

              if (approval.status !== "pending") {
                enqueueOutboxMessage(stateLoader, {
                  channel: resolveOutputChannel(message.channel, config),
                  topicKey: message.topic_key,
                  text: "This approval request has already been processed.",
                });
                const processingMs = Math.round(performance.now() - startMs);
                await completeInboxMessage(
                  stateLoader,
                  message.id,
                  processingMs,
                );
                return;
              }

              if (isExpired(approval)) {
                // Expired: resolve approval and mark original message as failed
                await resolveApproval(stateLoader, approvalId, "expired");
                const originalMessage = getInboxMessage(
                  stateLoader,
                  approval.inboxMessageId,
                );
                if (originalMessage) {
                  originalMessage.status = "failed";
                  originalMessage.error = "Approval expired";
                  await originalMessage.save();
                }
                enqueueOutboxMessage(stateLoader, {
                  channel: resolveOutputChannel(message.channel, config),
                  topicKey: message.topic_key,
                  text: "This approval request has expired. Please try your request again.",
                });
                const processingMs = Math.round(performance.now() - startMs);
                await completeInboxMessage(
                  stateLoader,
                  message.id,
                  processingMs,
                );

                if (debug.isEnabled()) {
                  debug.log({
                    type: "done",
                    traceId,
                    timestamp: new Date().toISOString(),
                    totalMs: processingMs,
                    ok: true,
                    approvalId,
                    action: "expired",
                  });
                }

                return;
              }

              if (action === "reject") {
                // Rejected: resolve approval and complete original message
                await resolveApproval(stateLoader, approvalId, "rejected");
                const originalMessage = getInboxMessage(
                  stateLoader,
                  approval.inboxMessageId,
                );
                if (originalMessage) {
                  originalMessage.status = "done";
                  await originalMessage.save();
                }
                enqueueOutboxMessage(stateLoader, {
                  channel: resolveOutputChannel(message.channel, config),
                  topicKey: message.topic_key,
                  text: "Action cancelled.",
                });
                const processingMs = Math.round(performance.now() - startMs);
                await completeInboxMessage(
                  stateLoader,
                  message.id,
                  processingMs,
                );

                if (debug.isEnabled()) {
                  debug.log({
                    type: "done",
                    traceId,
                    timestamp: new Date().toISOString(),
                    totalMs: processingMs,
                    ok: true,
                    approvalId,
                    action,
                  });
                }

                return;
              }

              // Approve: resolve approval, re-queue original message for processing
              await resolveApproval(stateLoader, approvalId, "approved");
              const originalMessage = getInboxMessage(
                stateLoader,
                approval.inboxMessageId,
              );
              if (originalMessage) {
                // Re-queue: set status back to pending so it gets picked up
                originalMessage.status = "pending";
                originalMessage.next_attempt_at = 0;
                await originalMessage.save();
              }

              enqueueOutboxMessage(stateLoader, {
                channel: resolveOutputChannel(message.channel, config),
                topicKey: message.topic_key,
                text: "Approved. Processing your request...",
              });

              const processingMs = Math.round(performance.now() - startMs);
              await completeInboxMessage(stateLoader, message.id, processingMs);

              if (debug.isEnabled()) {
                debug.log({
                  type: "done",
                  traceId,
                  timestamp: new Date().toISOString(),
                  totalMs: processingMs,
                  ok: true,
                  approvalId,
                  action,
                });
              }

              return; // Exit trace context, continue loop
            }

            // Check message.approvalId: if linked to an approved approval, set approvalGranted=true
            let approvalGranted = false;
            if (message.approvalId) {
              const linkedApproval = getApprovalById(
                stateLoader,
                message.approvalId,
              );
              if (linkedApproval?.status === "approved") {
                approvalGranted = true;
                log(
                  `[${message.topic_key}] approval granted for message: ${message.approvalId}`,
                );
              }
            }

            // Check for pending approvals - block new messages if approval pending
            // (only if this message doesn't already have approval granted)
            if (!approvalGranted) {
              const pendingApprovals = listPendingApprovals(
                stateLoader,
                message.topic_key,
              );
              if (pendingApprovals.length > 0) {
                const approval = pendingApprovals[0]; // Most recent

                if (!isExpired(approval)) {
                  // Re-present approval buttons
                  log(
                    `[${message.topic_key}] blocked by pending approval: ${approval.id}`,
                  );

                  enqueueOutboxMessage(stateLoader, {
                    channel: resolveOutputChannel(message.channel, config),
                    topicKey: message.topic_key,
                    text: "Please respond to the pending approval request first.",
                    payload: {
                      buttons: [
                        {
                          label: "✓ Approve",
                          data: `approval:${approval.id}:approve`,
                        },
                        {
                          label: "✗ Reject",
                          data: `approval:${approval.id}:reject`,
                        },
                      ],
                    },
                  });

                  // Mark inbox message as done (we handled it by re-presenting)
                  const processingMs = Math.round(performance.now() - startMs);
                  await completeInboxMessage(
                    stateLoader,
                    message.id,
                    processingMs,
                  );
                  return; // Exit the trace context, continue loop
                }

                // Approval expired - resolve it and mark original message as failed
                await resolveApproval(stateLoader, approval.id, "expired");
                const originalMessage = getInboxMessage(
                  stateLoader,
                  approval.inboxMessageId,
                );
                if (originalMessage && originalMessage.id !== message.id) {
                  originalMessage.status = "failed";
                  originalMessage.error = "Approval expired";
                  await originalMessage.save();
                }
              }
            }

            // 1. Recall memories from Engram (graceful on failure)
            const memories = await recallDual(
              message.text,
              message.topic_key,
              config.engramUrl,
            );

            // 2. Load recent turn history
            const turns = loadHistoryWithLoader(stateLoader, message.topic_key);

            // 3. Load topic summary (fast SQLite read via StateLoader)
            const topicSummary = stateLoader
              ? stateLoader.load(TopicSummaryState, message.topic_key).summary
              : null;

            log(
              `[${message.topic_key}] context: memories=${memories.length} turns=${turns.length}`,
            );

            // 4. Build prompt
            const messages = buildPrompt({
              systemPrompt,
              memories,
              topicSummary,
              turns,
              userText: message.text,
              messageType: message.message_type,
            });

            // Emit context event (char counts only)
            if (debug.isEnabled()) {
              const systemChars = systemPrompt.length;
              const memoriesChars = memories.reduce(
                (sum, m) => sum + m.content.length,
                0,
              );
              const summaryChars = topicSummary?.length ?? 0;
              const turnsChars = turns.reduce(
                (sum, t) => sum + (t.content?.length ?? 0),
                0,
              );
              const userChars = message.text.length;

              debug.log({
                type: "context",
                traceId,
                timestamp: new Date().toISOString(),
                systemPromptChars: systemChars,
                memoriesChars,
                memoriesCount: memories.length,
                summaryChars,
                turnsChars,
                turnsCount: turns.length,
                userChars,
              });

              // Emit prompt event (only if debugPrompt enabled)
              if (debug.isPromptEnabled()) {
                debug.log({
                  type: "prompt",
                  traceId,
                  timestamp: new Date().toISOString(),
                  messages,
                });
              }
            }

            // 5. Call Synapse — agent loop with tools or plain chat
            let responseText: string;
            let ok: boolean;
            let errorMsg: string | undefined;
            let needsApproval = false;
            let blockedToolCalls: ToolCall[] | undefined;

            if (hasTools) {
              const agentResult = await runAgentLoop({
                messages,
                tools: openAITools,
                registry,
                config: {
                  models: config.models,
                  synapseUrl: config.synapseUrl,
                  toolTimeoutMs: config.toolTimeoutMs,
                  maxToolRounds: config.maxToolRounds,
                  skillConfig: config.skillConfig,
                  synapseTimeoutMs: config.synapseTimeoutMs,
                },
                topicKey: message.topic_key,
                approvalGranted,
              });

              if (agentResult.ok) {
                // Check if agent needs approval
                if (agentResult.value.needsApproval) {
                  needsApproval = true;
                  blockedToolCalls = agentResult.value.blockedToolCalls;
                  ok = true;
                  responseText = "";

                  // Don't save partial history when blocked - we'll re-run the full request on approval
                } else {
                  ok = true;
                  responseText = agentResult.value.response;

                  // Save full agent history (user message + all loop turns)
                  const userMessage = {
                    role: "user" as const,
                    content: message.text,
                  };
                  await saveAgentHistoryWithLoader(
                    stateLoader,
                    message.topic_key,
                    [userMessage, ...agentResult.value.turns],
                  );
                }
              } else {
                ok = false;
                responseText = "";
                errorMsg = agentResult.error;
              }
            } else {
              // Plain chat path (no tools loaded)
              const result = await chat(
                messages,
                config.models,
                config.synapseUrl,
                { timeoutMs: config.synapseTimeoutMs },
              );

              if (result.ok) {
                ok = true;
                responseText = result.value.content;
                await saveTurnPairWithLoader(
                  stateLoader,
                  message.topic_key,
                  message.text,
                  responseText,
                );
              } else {
                ok = false;
                responseText = "";
                errorMsg = result.error;
              }
            }

            const elapsed = ((performance.now() - startMs) / 1000).toFixed(1);
            const processingMs = Math.round(performance.now() - startMs);

            if (ok) {
              // Handle approval request case
              if (needsApproval && blockedToolCalls) {
                // Build tool description for the approval action
                const toolDescriptions = blockedToolCalls
                  .filter((tc) => registry.isMutating(tc.function.name))
                  .map((tc) => {
                    try {
                      const args = JSON.parse(tc.function.arguments);
                      return `${tc.function.name}(${JSON.stringify(args)})`;
                    } catch {
                      return `${tc.function.name}(${tc.function.arguments})`;
                    }
                  })
                  .join(", ");

                const mutatingToolCall = blockedToolCalls.find((tc) =>
                  registry.isMutating(tc.function.name),
                );

                // Create approval with inboxMessageId
                const approval = proposeApproval(stateLoader, {
                  topicKey: message.topic_key,
                  action: `execute: ${toolDescriptions}`,
                  inboxMessageId: message.id,
                  toolName: mutatingToolCall?.function.name,
                  toolArgsJson: mutatingToolCall?.function.arguments,
                });

                // Link approval to message
                message.approvalId = approval.id;
                await message.save();

                // Generate approval request message with buttons
                const approvalMessage = await generateApprovalMessage(
                  blockedToolCalls,
                  registry,
                  config,
                );

                // Enqueue approval request to outbox with buttons
                enqueueOutboxMessage(stateLoader, {
                  channel: resolveOutputChannel(message.channel, config),
                  topicKey: message.topic_key,
                  text: approvalMessage,
                  payload: {
                    buttons: [
                      {
                        label: "✓ Approve",
                        data: `approval:${approval.id}:approve`,
                      },
                      {
                        label: "✗ Reject",
                        data: `approval:${approval.id}:reject`,
                      },
                    ],
                  },
                });

                // Don't complete the message - leave it for re-processing after approval
                // Set status back to pending but with a flag that it's waiting for approval
                message.status = "pending";
                // Set next_attempt_at far in future - approval response will reset it
                message.next_attempt_at = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
                await message.save();

                log(`[${message.topic_key}] approval required: ${approval.id}`);

                // Emit done event
                if (debug.isEnabled()) {
                  debug.log({
                    type: "done",
                    traceId,
                    timestamp: new Date().toISOString(),
                    totalMs: processingMs,
                    ok: true,
                    approvalId: approval.id,
                  });
                }
              } else {
                // Normal success path
                // 7. Trigger async extraction (fire-and-forget, serialized per topic)
                //    Always increment the turn counter — even when extraction is
                //    already in-flight — so the cadence stays accurate.
                if (config.extractionModels && stateLoader) {
                  const cursor = stateLoader.load(
                    ExtractionCursorState,
                    message.topic_key,
                  );
                  cursor.turnsSinceExtraction += 1;
                  // Flush immediately so maybeExtract sees the updated counter
                  await stateLoader.flush();
                }
                if (stateLoader && !extractionInFlight.has(message.topic_key)) {
                  const p = maybeExtract(message.topic_key, config, stateLoader)
                    .catch((e) =>
                      log(
                        `[${message.topic_key}] extraction error: ${e instanceof Error ? e.message : String(e)}`,
                      ),
                    )
                    .finally(() =>
                      extractionInFlight.delete(message.topic_key),
                    );
                  extractionInFlight.set(message.topic_key, p);
                }

                // 8. Write to outbox
                enqueueOutboxMessage(stateLoader, {
                  channel: resolveOutputChannel(message.channel, config),
                  topicKey: message.topic_key,
                  text: responseText,
                  messageType: message.message_type,
                  responseTo: message.id,
                });

                await completeInboxMessage(
                  stateLoader,
                  message.id,
                  processingMs,
                );

                const responsePreview =
                  responseText.length > 120
                    ? `${responseText.slice(0, 117)}...`
                    : responseText;
                log(
                  `[${message.topic_key}] done in ${elapsed}s: ${responsePreview}`,
                );

                // Emit done event
                if (debug.isEnabled()) {
                  debug.log({
                    type: "done",
                    traceId,
                    timestamp: new Date().toISOString(),
                    totalMs: processingMs,
                    ok: true,
                  });
                }
              }
            } else {
              log(`[${message.topic_key}] failed in ${elapsed}s: ${errorMsg}`);

              // Emit done event (failure)
              if (debug.isEnabled()) {
                debug.log({
                  type: "done",
                  traceId,
                  timestamp: new Date().toISOString(),
                  totalMs: processingMs,
                  ok: false,
                  error: errorMsg,
                });
              }

              if (isTransientError(errorMsg!)) {
                await retryInboxMessage(
                  stateLoader,
                  message.id,
                  message.attempts,
                  config.inboxMaxAttempts,
                  errorMsg!,
                );
              } else {
                await completeInboxMessage(
                  stateLoader,
                  message.id,
                  processingMs,
                  errorMsg,
                );
              }
            }
          });
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

// --- Approval helpers ---

/**
 * Generate an approval request message describing the blocked tools.
 * Uses the LLM without tools to generate a human-readable approval prompt.
 */
async function generateApprovalMessage(
  blockedToolCalls: ToolCall[],
  _registry: SkillRegistry,
  config: CortexConfig,
): Promise<string> {
  // Build tool descriptions for the approval message
  const toolDescriptions = blockedToolCalls
    .map((tc) => {
      const name = tc.function.name;
      let argsDisplay: string;
      try {
        const args = JSON.parse(tc.function.arguments);
        argsDisplay = JSON.stringify(args, null, 2);
      } catch {
        argsDisplay = tc.function.arguments;
      }
      return `**${name}**\n\`\`\`json\n${argsDisplay}\n\`\`\``;
    })
    .join("\n\n");

  // Create a prompt for the LLM to generate an approval message
  const approvalPromptMessages: ChatMessage[] = [
    {
      role: "system",
      content: `You are an assistant helping a user approve or reject a tool execution request.
Generate a brief, clear message explaining what action is about to be taken and asking for approval.
Be concise but informative. The user will see Approve/Reject buttons below your message.
Do not include the buttons in your response - they will be added automatically.`,
    },
    {
      role: "user",
      content: `The following tool(s) require approval before execution:\n\n${toolDescriptions}\n\nGenerate an approval request message.`,
    },
  ];

  // Call LLM without tools to generate approval message
  const result = await chat(
    approvalPromptMessages,
    config.models,
    config.synapseUrl,
    { timeoutMs: config.synapseTimeoutMs },
  );

  if (result.ok) {
    return result.value.content;
  }

  // Fallback to a simple message if LLM fails
  const toolNames = blockedToolCalls.map((tc) => tc.function.name).join(", ");
  return `The following action requires your approval: **${toolNames}**\n\nPlease review and approve or reject.`;
}
