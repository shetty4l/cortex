/**
 * Fact extraction pipeline for Cortex.
 *
 * Extracts durable facts, preferences, and decisions from conversation turns
 * and stores them in Engram. Runs asynchronously (non-blocking) every N turns
 * per topic, using a cheap/fast model specified by extractionModel in config.
 *
 * Design:
 * - Conditional on extractionModel being set (no-op if absent)
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
  incrementTurnsSinceExtraction,
  loadTurnsSinceCursor,
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
 * Call this after saving a turn pair. It increments the turn counter
 * and triggers extraction when the threshold is reached.
 *
 * Safe to call as fire-and-forget — all errors are caught and logged.
 */
export async function maybeExtract(
  topicKey: string,
  config: CortexConfig,
): Promise<void> {
  // Guard: extraction disabled if no model configured
  if (!config.extractionModel) return;

  // Increment counter (creates cursor if first time)
  incrementTurnsSinceExtraction(topicKey);

  // Check if extraction is due
  const cursor = getExtractionCursor(topicKey);
  if (!cursor || cursor.turns_since_extraction < config.extractionInterval) {
    return;
  }

  const afterRowid = cursor.last_extracted_rowid;

  // Load turns since last extraction (capped to prevent unbounded prompt size)
  const turns = loadTurnsSinceCursor(
    topicKey,
    afterRowid,
    MAX_TURNS_PER_EXTRACTION,
  );
  if (turns.length === 0) {
    // No new turns — advance cursor to reset counter
    advanceExtractionCursor(topicKey, afterRowid);
    return;
  }

  // Recall existing memories for dedup context (graceful on failure)
  const topicSummary = turns
    .filter((t) => t.role === "user")
    .map((t) => t.content)
    .slice(0, 3)
    .join(" ");
  const recallResult = await recall(topicSummary, config.engramUrl, {
    limit: DEDUP_CONTEXT_LIMIT,
    scopeId: topicKey,
  });
  const existingMemories = recallResult.ok ? recallResult.value : [];

  // Build extraction prompt
  const messages = buildExtractionPrompt(turns, existingMemories);

  // Call extraction model
  const result = await chat(
    messages,
    config.extractionModel,
    config.synapseUrl,
  );
  if (!result.ok) {
    console.error(
      `cortex: [${topicKey}] extraction model failed: ${result.error}`,
    );
    // Do NOT advance cursor — turns will be re-processed next time
    return;
  }

  // Parse extracted facts
  const parseResult = parseExtractionResponse(result.value.content);
  if (!parseResult.ok) {
    console.error(`cortex: [${topicKey}] ${parseResult.error}`);
    // Do NOT advance cursor — turns will be re-processed next time
    return;
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

  // Advance cursor regardless of individual remember failures
  // (upsert makes re-extraction safe on next cycle)
  const lastRowid = turns[turns.length - 1].rowid;
  advanceExtractionCursor(topicKey, lastRowid);

  if (facts.length > 0) {
    console.error(
      `cortex: [${topicKey}] extracted ${stored}/${facts.length} facts from ${turns.length} turns`,
    );
  }
}

// --- Prompt construction ---

function buildExtractionPrompt(
  turns: Array<{ role: string; content: string }>,
  existingMemories: Array<{ content: string; category: string | null }>,
): ChatMessage[] {
  let systemContent =
    "You extract durable facts, preferences, and decisions from conversation turns.\n" +
    "Return a JSON array of objects: " +
    '[{ "content": "...", "category": "fact" | "preference" | "decision" }]\n' +
    "Return [] if nothing new to extract. Do NOT repeat facts already known.\n" +
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
  // 1. Try JSON.parse directly (handles clean JSON-only responses)
  // 2. Fall back to extracting [...] candidates last-first from the response
  //    (JSON is typically at the end; trying each candidate with JSON.parse
  //    handles prose-before-JSON, brackets-inside-strings, and markdown wrapping)
  let parsed: unknown;

  try {
    parsed = JSON.parse(response);
  } catch {
    // Response isn't pure JSON — find all [...] candidates and try last-first
    const candidates = [...response.matchAll(/\[[\s\S]*?\]/g)];
    if (candidates.length === 0) {
      return err("extraction response has no JSON array");
    }

    let found = false;
    for (let i = candidates.length - 1; i >= 0; i--) {
      try {
        parsed = JSON.parse(candidates[i][0]);
        found = true;
        break;
      } catch {
        // Try next candidate
      }
    }

    if (!found) {
      return err("extraction response has invalid JSON");
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
