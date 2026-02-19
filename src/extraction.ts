/**
 * Fact extraction pipeline for Cortex.
 *
 * Extracts durable facts, preferences, and decisions from conversation turns
 * and stores them in Engram. Runs asynchronously (non-blocking) every N turns
 * per topic, using a cheap/fast model specified by extractionModel in config.
 *
 * Design:
 * - Conditional on extractionModel being set (no-op if absent)
 * - Serialized per topic by the caller (loop.ts in-flight guard) — no
 *   concurrent extraction runs for the same topic, eliminating cursor races
 * - Uses extraction cursors in SQLite to track progress per topic
 * - Passes existing Engram memories into the extraction prompt for dedup
 * - Uses upsert with deterministic idempotency keys (re-extraction safe)
 * - Caps at MAX_FACTS_PER_RUN to guard against hallucinating models
 * - Never blocks the response path — caller wraps in fire-and-forget
 */

import type { Result } from "@shetty4l/core/result";
import { err, ok } from "@shetty4l/core/result";
import type { CortexConfig } from "./config";
import {
  advanceExtractionCursor,
  getExtractionCursor,
  getTopicSummary,
  loadTurnsSinceCursor,
  upsertTopicSummary,
} from "./db";
import { recall, remember } from "./engram";
import type { ChatMessage } from "./synapse";
import { chat } from "./synapse";

// --- Constants ---

/** Maximum facts stored per extraction run. */
const MAX_FACTS_PER_RUN = 10;

/** Maximum existing memories to include in the extraction prompt for dedup. */
const DEDUP_CONTEXT_LIMIT = 10;

/** Maximum turns to feed into a single extraction prompt. */
const MAX_TURNS_PER_EXTRACTION = 100;

/**
 * Approximate character budget for turns in a single extraction prompt.
 * Prevents context-window overflow when turns contain long content
 * (e.g. code dumps, logs). At ~4 chars/token this is roughly 12.5k tokens,
 * well within the context limits of cheap extraction models.
 *
 * The drain loop naturally handles the remainder — if a batch is trimmed,
 * subsequent iterations pick up where we left off.
 */
const MAX_EXTRACTION_CHARS = 50_000;

/** Valid categories for extracted facts. */
const VALID_CATEGORIES = new Set(["fact", "preference", "decision"]);

// --- Types ---

interface ExtractedFact {
  content: string;
  category: string;
}

// --- Extraction ---

/**
 * Run extraction for a topic if due.
 *
 * Called after saving a turn pair. The caller (loop.ts) is responsible for
 * incrementing the turn counter BEFORE calling this function, so that the
 * counter stays accurate even when this call is skipped by the in-flight guard.
 *
 * Safe to call as fire-and-forget — all errors are caught and logged.
 */
export async function maybeExtract(
  topicKey: string,
  config: CortexConfig,
): Promise<void> {
  // Guard: extraction disabled if no model configured
  if (!config.extractionModel) return;

  // Check if extraction is due
  const cursor = getExtractionCursor(topicKey);
  if (!cursor || cursor.turns_since_extraction < config.extractionInterval) {
    return;
  }

  let afterRowid = cursor.last_extracted_rowid;

  // Loop to drain the backlog — each iteration processes up to
  // MAX_TURNS_PER_EXTRACTION turns, trimmed to fit within
  // MAX_EXTRACTION_CHARS. This ensures that a large backlog
  // (e.g. after downtime) is fully processed rather than orphaned,
  // and that oversized batches don't permanently block extraction.
  // Track the most recent successful batch for topic summary generation.
  // The summary only sees this last batch, not the full backlog — this is
  // acceptable because the previous summary (included in the summary prompt)
  // provides continuity for earlier turns. The rolling nature of the summary
  // handles large backlogs across multiple extraction cycles.
  let lastBatchTurns: Array<{ role: string; content: string }> = [];

  while (true) {
    const loaded = loadTurnsSinceCursor(
      topicKey,
      afterRowid,
      MAX_TURNS_PER_EXTRACTION,
    );
    if (loaded.length === 0) {
      // No more turns — advance cursor to reset counter
      advanceExtractionCursor(topicKey, afterRowid);
      break;
    }

    // Trim to character budget so the prompt fits the extraction model's
    // context window. The drain loop handles the remainder naturally.
    const turns = trimToBudget(loaded);

    const result = await extractBatch(topicKey, turns, config);
    if (!result.ok) {
      // Model or parse failure — stop draining, don't advance cursor.
      // Turns will be re-processed next time.
      break;
    }

    // Track the last successful batch for topic summary generation
    lastBatchTurns = turns;

    const lastRowid = turns[turns.length - 1].rowid;
    advanceExtractionCursor(topicKey, lastRowid);
    afterRowid = lastRowid;

    // Continue draining if the batch was trimmed (more turns remain at
    // the same cursor position) or if the DB returned a full page
    // (there may be more turns beyond this page). Break only when
    // we processed everything loaded AND the page wasn't full.
    if (
      turns.length === loaded.length &&
      loaded.length < MAX_TURNS_PER_EXTRACTION
    )
      break;
  }

  // After draining, generate/update the topic summary using the most
  // recent batch of turns. Summary generation is gated on extraction success —
  // both use the same extractionModel, so if extraction failed (model down or
  // bad response), the summary call would likely fail too. Unprocessed turns
  // are retried on the next extraction cycle.
  if (lastBatchTurns.length > 0) {
    await updateTopicSummary(topicKey, lastBatchTurns, config);
  }
}

/**
 * Extract facts from a single batch of turns.
 *
 * Returns Ok on success (even if no facts found).
 * Returns Err on model call or parse failure (caller should stop draining).
 */
async function extractBatch(
  topicKey: string,
  turns: Array<{ role: string; content: string; rowid: number }>,
  config: CortexConfig,
): Promise<Result<void>> {
  // Recall existing memories for dedup context (graceful on failure)
  const recallQuery = turns
    .filter((t) => t.role === "user")
    .map((t) => t.content)
    .slice(0, 3)
    .join(" ");
  const recallResult = await recall(recallQuery, config.engramUrl, {
    limit: DEDUP_CONTEXT_LIMIT,
    scopeId: topicKey,
  });
  const existingMemories = recallResult.ok ? recallResult.value : [];

  // Build extraction prompt
  const messages = buildExtractionPrompt(turns, existingMemories);

  // Call extraction model (extractionModel is guaranteed set by caller guard)
  const result = await chat(
    messages,
    config.extractionModel!,
    config.synapseUrl,
  );
  if (!result.ok) {
    console.error(
      `cortex: [${topicKey}] extraction model failed: ${result.error}`,
    );
    return err(`extraction model failed: ${result.error}`);
  }

  // Parse extracted facts
  const parseResult = parseExtractionResponse(result.value.content);
  if (!parseResult.ok) {
    console.error(`cortex: [${topicKey}] ${parseResult.error}`);
    return err(parseResult.error);
  }
  const facts = parseResult.value;

  // Store facts in Engram (continue on individual failures)
  let stored = 0;
  for (const fact of facts) {
    const key = await computeIdempotencyKey(
      topicKey,
      fact.content,
      fact.category,
    );
    const rememberResult = await remember(
      {
        content: fact.content,
        category: fact.category,
        scopeId: topicKey,
        idempotencyKey: key,
        upsert: true,
      },
      config.engramUrl,
    );

    if (rememberResult.ok && rememberResult.value !== null) {
      stored++;
    } else if (!rememberResult.ok) {
      console.error(
        `cortex: [${topicKey}] remember failed: ${rememberResult.error}`,
      );
    }
  }

  if (facts.length > 0) {
    console.error(
      `cortex: [${topicKey}] extracted ${stored}/${facts.length} facts from ${turns.length} turns`,
    );
  }

  return ok(undefined);
}

// --- Topic summary ---

/**
 * Generate a rolling topic summary and store it in both SQLite (cache)
 * and Engram (source of truth).
 *
 * Uses the extraction model to produce a 1-2 sentence summary of what
 * the conversation is about and its current focus. The previous summary
 * (if any) is included in the prompt so the model updates rather than
 * recreates.
 *
 * Returns Err on failure (model error, DB error, etc.).
 * All errors are logged internally — caller can safely ignore the result.
 */
async function updateTopicSummary(
  topicKey: string,
  turns: Array<{ role: string; content: string }>,
  config: CortexConfig,
): Promise<Result<void>> {
  try {
    const existingSummary = getTopicSummary(topicKey);
    const messages = buildSummaryPrompt(turns, existingSummary);

    const result = await chat(
      messages,
      config.extractionModel!,
      config.synapseUrl,
    );
    if (!result.ok) {
      console.error(
        `cortex: [${topicKey}] summary model failed: ${result.error}`,
      );
      return err(`summary model failed: ${result.error}`);
    }

    const summary = result.value.content.trim();
    if (summary.length === 0) return ok(undefined);

    // Write to local SQLite cache (fast reads at prompt time)
    upsertTopicSummary(topicKey, summary);

    // Write to Engram (source of truth, upsert by topic key).
    // Category "summary" is intentionally outside VALID_CATEGORIES —
    // summaries are a distinct memory type, not extracted facts.
    const rememberResult = await remember(
      {
        content: summary,
        category: "summary",
        scopeId: topicKey,
        idempotencyKey: `topic-summary:${topicKey}`,
        upsert: true,
      },
      config.engramUrl,
    );

    if (!rememberResult.ok) {
      console.error(
        `cortex: [${topicKey}] summary remember failed: ${rememberResult.error}`,
      );
    } else {
      console.error(`cortex: [${topicKey}] topic summary updated`);
    }

    return ok(undefined);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`cortex: [${topicKey}] summary error: ${msg}`);
    return err(`summary error: ${msg}`);
  }
}

/**
 * Build the prompt for topic summary generation.
 */
function buildSummaryPrompt(
  turns: Array<{ role: string; content: string }>,
  existingSummary: string | null,
): ChatMessage[] {
  let systemContent =
    "In 1-2 sentences, summarize what this conversation is about and its current focus.\n" +
    "Be specific and concrete. Do not use filler phrases.\n" +
    "Respond with ONLY the summary text — no labels, no markdown, no explanation.";

  if (existingSummary) {
    systemContent += `\n\nPrevious summary:\n${existingSummary}`;
  }

  let userContent = "Recent conversation:\n";
  for (const turn of turns) {
    userContent += `${turn.role}: ${turn.content}\n`;
  }

  return [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];
}

// --- Prompt construction ---

function buildExtractionPrompt(
  turns: Array<{ role: string; content: string }>,
  existingMemories: Array<{ content: string; category: string | null }>,
): ChatMessage[] {
  let systemContent =
    "You extract durable facts, preferences, and decisions from conversation turns.\n" +
    "Respond with ONLY a JSON array — no markdown, no explanation, no surrounding text.\n" +
    'Format: [{ "content": "...", "category": "fact" | "preference" | "decision" }]\n' +
    "Respond with [] if nothing new to extract. Do NOT repeat facts already known.\n" +
    "Only extract concrete, specific information. Skip pleasantries and filler.\n" +
    "Each fact should be a single, self-contained statement.";

  if (existingMemories.length > 0) {
    systemContent += "\n\nKnown memories (do NOT repeat these):";
    for (const mem of existingMemories) {
      const cat = mem.category ? ` [${mem.category}]` : "";
      systemContent += `\n- ${mem.content}${cat}`;
    }
  }

  let userContent = "New conversation turns:\n";
  for (const turn of turns) {
    userContent += `${turn.role}: ${turn.content}\n`;
  }

  return [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];
}

// --- Response parsing ---

/**
 * Parse the extraction model's response into structured facts.
 *
 * Returns Err on parse failure (caller should not advance cursor).
 * Returns Ok with empty array on valid empty response (no facts to extract).
 * Caps at MAX_FACTS_PER_RUN.
 */
function parseExtractionResponse(response: string): Result<ExtractedFact[]> {
  // Two-stage parse:
  // 1. JSON.parse directly — the prompt explicitly requests raw JSON output,
  //    so this handles the vast majority of cases.
  // 2. Code fence fallback — some models wrap output in ```json ... ```
  //    despite being told not to. Extract the fenced content and parse it.
  //
  // No regex-based bracket matching — that approach is inherently fragile
  // with free-form LLM output. If neither stage works, the model isn't
  // following format instructions and the extractionModel config should
  // point at a more capable model.
  let parsed: unknown;

  // Stage 1: Direct parse
  try {
    parsed = JSON.parse(response);
  } catch {
    // Stage 2: Code fence extraction
    const fenceMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1]);
      } catch {
        return err("extraction response has invalid JSON in code fence");
      }
    } else {
      return err("extraction response is not valid JSON");
    }
  }

  if (!Array.isArray(parsed)) {
    return err("extraction response is not an array");
  }

  // Validate and filter each fact
  const facts: ExtractedFact[] = [];
  for (const item of parsed) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof item.content !== "string" ||
      typeof item.category !== "string"
    ) {
      continue; // Skip malformed entries
    }

    const content = item.content.trim();
    const category = item.category.toLowerCase().trim();

    // Skip empty or very short facts
    if (content.length < 5) continue;

    // Validate category
    if (!VALID_CATEGORIES.has(category)) continue;

    facts.push({ content, category });
  }

  if (facts.length > MAX_FACTS_PER_RUN) {
    console.error(
      `cortex: extraction returned ${parsed.length} facts, capping at ${MAX_FACTS_PER_RUN}`,
    );
  }

  return ok(facts.slice(0, MAX_FACTS_PER_RUN));
}

// --- Batch sizing ---

/**
 * Trim a list of turns to fit within MAX_EXTRACTION_CHARS.
 *
 * Walks the list front-to-back, accumulating character count.
 * Stops adding turns when the next turn would exceed the budget.
 * Always includes at least one turn so a single long turn doesn't
 * deadlock the drain loop (the extraction may still fail on the
 * model side, but the batch shrinks to the minimum possible).
 *
 * Exported for testing.
 */
export function trimToBudget<T extends { content: string }>(
  turns: T[],
  budget: number = MAX_EXTRACTION_CHARS,
): T[] {
  if (turns.length === 0) return turns;

  let chars = 0;
  for (let i = 0; i < turns.length; i++) {
    chars += turns[i].content.length;
    if (chars > budget && i > 0) {
      return turns.slice(0, i);
    }
  }
  return turns;
}

// --- Idempotency ---

/**
 * Compute a deterministic idempotency key for an extracted fact.
 *
 * Uses SHA-256 of topicKey + content + category to ensure re-extraction
 * of the same turns produces the same keys (upsert dedup).
 */
async function computeIdempotencyKey(
  topicKey: string,
  content: string,
  category: string,
): Promise<string> {
  const input = `${topicKey}\0${content}\0${category}`;
  const buffer = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `cortex:extract:${hex.slice(0, 16)}`;
}
