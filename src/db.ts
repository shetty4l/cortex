/**
 * SQLite database for Cortex.
 *
 * Manages inbox/outbox queues, turns, extraction cursors, topic summaries,
 * and scheduler jobs.
 * Tables are created incrementally as each slice adds its schema.
 *
 * Database location: ~/.local/share/cortex/cortex.db
 * Tests can override via initDatabase(":memory:").
 */

import type { Database } from "bun:sqlite";
import { getDataDir } from "@shetty4l/core/config";
import { createDatabaseManager } from "@shetty4l/core/db";
import type { Result } from "@shetty4l/core/result";
import { err, ok } from "@shetty4l/core/result";
import { join } from "path";

// --- Schema ---

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS inbox_messages (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    external_message_id TEXT NOT NULL,
    topic_key TEXT NOT NULL,
    user_id TEXT NOT NULL,
    text TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL,
    metadata_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    -- Dedup is on (source, external_message_id), NOT idempotency_key.
    -- idempotency_key is stored for connector-layer tracing/debugging.
    UNIQUE(source, external_message_id)
  );

  CREATE INDEX IF NOT EXISTS idx_inbox_status_created
    ON inbox_messages(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_inbox_topic_status
    ON inbox_messages(topic_key, status);

  CREATE TABLE IF NOT EXISTS outbox_messages (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    topic_key TEXT NOT NULL,
    text TEXT NOT NULL,
    payload_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    lease_token TEXT,
    lease_expires_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_outbox_source_status_next
    ON outbox_messages(source, status, next_attempt_at);

  CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    topic_key TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_turns_topic_created
    ON turns(topic_key, created_at);

  CREATE TABLE IF NOT EXISTS extraction_cursors (
    topic_key TEXT PRIMARY KEY,
    last_extracted_rowid INTEGER NOT NULL,
    turns_since_extraction INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS topic_summaries (
    topic_key TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

// --- Connection (via core DatabaseManager) ---

const dbManager = createDatabaseManager({
  path: join(getDataDir("cortex"), "cortex.db"),
  schema: SCHEMA,
});

/**
 * Initialize the database. Returns the Database instance on success.
 * Idempotent — returns existing instance if already open.
 * Pass a pathOverride to force close + reopen (used by tests with ":memory:").
 */
export function initDatabase(pathOverride?: string): Result<Database> {
  try {
    // If a pathOverride is given, close existing and re-init
    if (pathOverride !== undefined) {
      dbManager.close();
    }
    const db = dbManager.init(pathOverride);
    // Enable foreign keys (core sets WAL mode already)
    db.exec("PRAGMA foreign_keys = ON");
    return ok(db);
  } catch (e) {
    return err(
      `Failed to initialize database: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export function getDatabase(): Database {
  return dbManager.db();
}

export function closeDatabase(): void {
  dbManager.close();
}

/** Reset the singleton for tests without closing. */
export function resetDatabase(): void {
  dbManager.reset();
}

// --- Inbox operations ---

export interface InboxInsertInput {
  source: string;
  externalMessageId: string;
  topicKey: string;
  userId: string;
  text: string;
  occurredAt: number;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface InboxMessage {
  id: string;
  source: string;
  external_message_id: string;
  topic_key: string;
  user_id: string;
  text: string;
  occurred_at: number;
  idempotency_key: string;
  metadata_json: string | null;
  status: string;
  attempts: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Check if an inbox message already exists for this (source, externalMessageId).
 * Returns the existing message ID if found, null otherwise.
 */
export function findInboxDuplicate(
  source: string,
  externalMessageId: string,
): string | null {
  const database = getDatabase();
  const stmt = database.prepare(
    "SELECT id FROM inbox_messages WHERE source = $source AND external_message_id = $externalMessageId",
  );
  const row = stmt.get({
    $source: source,
    $externalMessageId: externalMessageId,
  }) as { id: string } | null;
  return row?.id ?? null;
}

export interface EnqueueResult {
  eventId: string;
  duplicate: boolean;
}

/**
 * Insert a new inbox message. If a UNIQUE constraint violation occurs
 * (concurrent duplicate), falls back to returning the existing row's ID.
 */
export function enqueueInboxMessage(input: InboxInsertInput): EnqueueResult {
  const database = getDatabase();
  const id = `evt_${crypto.randomUUID()}`;
  const now = Date.now();

  const stmt = database.prepare(`
    INSERT INTO inbox_messages (
      id, source, external_message_id, topic_key, user_id, text,
      occurred_at, idempotency_key, metadata_json, status, attempts,
      created_at, updated_at
    ) VALUES (
      $id, $source, $externalMessageId, $topicKey, $userId, $text,
      $occurredAt, $idempotencyKey, $metadataJson, 'pending', 0,
      $now, $now
    )
  `);

  try {
    stmt.run({
      $id: id,
      $source: input.source,
      $externalMessageId: input.externalMessageId,
      $topicKey: input.topicKey,
      $userId: input.userId,
      $text: input.text,
      $occurredAt: input.occurredAt,
      $idempotencyKey: input.idempotencyKey,
      $metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
      $now: now,
    });
    return { eventId: id, duplicate: false };
  } catch (err) {
    // UNIQUE constraint violation — concurrent duplicate slipped past the check
    if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
      const existingId = findInboxDuplicate(
        input.source,
        input.externalMessageId,
      );
      if (existingId) {
        return { eventId: existingId, duplicate: true };
      }
    }
    throw err;
  }
}

/**
 * Get an inbox message by ID.
 */
export function getInboxMessage(id: string): InboxMessage | null {
  const database = getDatabase();
  const stmt = database.prepare("SELECT * FROM inbox_messages WHERE id = $id");
  return (stmt.get({ $id: id }) as InboxMessage) ?? null;
}

// --- Inbox processing operations ---

/**
 * Atomically claim the oldest pending inbox message.
 * Sets status to 'processing' and increments attempts.
 * Returns null if no pending messages exist.
 */
export function claimNextInboxMessage(): InboxMessage | null {
  const database = getDatabase();
  const now = Date.now();

  // SQLite RETURNING requires 3.35+; Bun's bundled SQLite supports it.
  const stmt = database.prepare(`
    UPDATE inbox_messages
    SET status = 'processing', attempts = attempts + 1, updated_at = $now
    WHERE id = (
      SELECT id FROM inbox_messages
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
    )
    RETURNING *
  `);

  return (stmt.get({ $now: now }) as InboxMessage) ?? null;
}

/**
 * Mark an inbox message as done (or failed with an error reason).
 */
export function completeInboxMessage(id: string, error?: string): void {
  const database = getDatabase();
  const now = Date.now();
  const status = error ? "failed" : "done";

  const stmt = database.prepare(`
    UPDATE inbox_messages
    SET status = $status, error = $error, updated_at = $now
    WHERE id = $id
  `);
  stmt.run({ $id: id, $status: status, $error: error ?? null, $now: now });
}

// --- Outbox operations ---

export interface OutboxInsertInput {
  source: string;
  topicKey: string;
  text: string;
  payload?: Record<string, unknown>;
}

export interface OutboxMessage {
  id: string;
  source: string;
  topic_key: string;
  text: string;
  payload_json: string | null;
  status: string;
  attempts: number;
  next_attempt_at: number;
  lease_token: string | null;
  lease_expires_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Insert a new outbox message, ready for connector delivery.
 */
export function enqueueOutboxMessage(input: OutboxInsertInput): string {
  const database = getDatabase();
  const id = `out_${crypto.randomUUID()}`;
  const now = Date.now();

  const stmt = database.prepare(`
    INSERT INTO outbox_messages (
      id, source, topic_key, text, payload_json,
      status, attempts, next_attempt_at, created_at, updated_at
    ) VALUES (
      $id, $source, $topicKey, $text, $payloadJson,
      'pending', 0, $now, $now, $now
    )
  `);

  stmt.run({
    $id: id,
    $source: input.source,
    $topicKey: input.topicKey,
    $text: input.text,
    $payloadJson: input.payload ? JSON.stringify(input.payload) : null,
    $now: now,
  });

  return id;
}

/**
 * Get an outbox message by ID.
 */
export function getOutboxMessage(id: string): OutboxMessage | null {
  const database = getDatabase();
  const stmt = database.prepare("SELECT * FROM outbox_messages WHERE id = $id");
  return (stmt.get({ $id: id }) as OutboxMessage) ?? null;
}

/**
 * List all outbox messages for a given topic key, ordered by creation time.
 */
export function listOutboxMessagesByTopic(topicKey: string): OutboxMessage[] {
  const database = getDatabase();
  const stmt = database.prepare(
    "SELECT * FROM outbox_messages WHERE topic_key = $topicKey ORDER BY created_at ASC",
  );
  return stmt.all({ $topicKey: topicKey }) as OutboxMessage[];
}

// --- Outbox poll/ack operations ---

/**
 * Compute exponential backoff delay for outbox retries.
 * Formula: min(2^(attempts-1) * 5000ms, 15min) with ±20% jitter.
 *
 * Pure function — exported for testing.
 */
export function computeBackoffDelay(attempts: number): number {
  const base = Math.min(2 ** (attempts - 1) * 5000, 900_000);
  const jitter = 0.8 + Math.random() * 0.4; // [0.8, 1.2]
  return Math.round(base * jitter);
}

export interface OutboxPollResult {
  messageId: string;
  leaseToken: string;
  topicKey: string;
  text: string;
  payload: Record<string, unknown> | null;
}

/**
 * Atomically claim outbox messages for a connector source.
 *
 * Eligible rows: matching source, next_attempt_at <= now, and either
 * status='pending' OR (status='leased' AND lease_expires_at <= now).
 *
 * For each eligible row:
 *   - Increment attempts
 *   - If attempts > maxAttempts → transition to 'dead' (DLQ)
 *   - Else → set status='leased', fresh lease_token + lease_expires_at,
 *     and next_attempt_at = now + backoff(attempts) for retry if lease expires
 *
 * Returns only successfully leased messages (not dead-lettered ones).
 */
export function pollOutboxMessages(
  source: string,
  max: number,
  leaseSeconds: number,
  maxAttempts: number,
  topicKey?: string,
): OutboxPollResult[] {
  const database = getDatabase();
  const now = Date.now();

  // Use a transaction for atomicity — no other poller can claim the same rows.
  const results: OutboxPollResult[] = [];

  database.transaction(() => {
    // Find eligible rows
    const topicFilter = topicKey ? " AND topic_key = $topicKey" : "";
    const eligible = database
      .prepare(
        `SELECT id, attempts FROM outbox_messages
         WHERE source = $source
           AND next_attempt_at <= $now
           AND (status = 'pending' OR (status = 'leased' AND lease_expires_at <= $now))${topicFilter}
         ORDER BY next_attempt_at ASC, created_at ASC
         LIMIT $max`,
      )
      .all({
        $source: source,
        $now: now,
        $max: max,
        ...(topicKey ? { $topicKey: topicKey } : {}),
      }) as Array<{
      id: string;
      attempts: number;
    }>;

    const deadLetterStmt = database.prepare(`
      UPDATE outbox_messages
      SET status = 'dead', attempts = $attempts, last_error = 'max attempts exceeded', updated_at = $now
      WHERE id = $id
    `);

    const leaseStmt = database.prepare(`
      UPDATE outbox_messages
      SET status = 'leased',
          attempts = $attempts,
          lease_token = $leaseToken,
          lease_expires_at = $leaseExpiresAt,
          next_attempt_at = $nextAttemptAt,
          updated_at = $now
      WHERE id = $id
      RETURNING id, topic_key, text, payload_json, lease_token
    `);

    for (const row of eligible) {
      const newAttempts = row.attempts + 1;

      if (newAttempts > maxAttempts) {
        deadLetterStmt.run({
          $id: row.id,
          $attempts: newAttempts,
          $now: now,
        });
        continue;
      }

      const leaseToken = `lease_${crypto.randomUUID()}`;
      const leaseExpiresAt = now + leaseSeconds * 1000;
      const nextAttemptAt = now + computeBackoffDelay(newAttempts);

      const leased = leaseStmt.get({
        $id: row.id,
        $attempts: newAttempts,
        $leaseToken: leaseToken,
        $leaseExpiresAt: leaseExpiresAt,
        $nextAttemptAt: nextAttemptAt,
        $now: now,
      }) as {
        id: string;
        topic_key: string;
        text: string;
        payload_json: string | null;
        lease_token: string;
      } | null;

      if (leased) {
        results.push({
          messageId: leased.id,
          leaseToken: leased.lease_token,
          topicKey: leased.topic_key,
          text: leased.text,
          payload: leased.payload_json
            ? (JSON.parse(leased.payload_json) as Record<string, unknown>)
            : null,
        });
      }
    }
  })();

  return results;
}

export type AckResult =
  | "delivered"
  | "already_delivered"
  | "lease_conflict"
  | "not_found";

/**
 * Acknowledge successful delivery of an outbox message.
 *
 * Requires matching messageId + leaseToken with an active (non-expired) lease.
 * Idempotent: re-acking an already-delivered message with the same token returns
 * "already_delivered".
 */
export function ackOutboxMessage(
  messageId: string,
  leaseToken: string,
): AckResult {
  const database = getDatabase();
  const now = Date.now();

  return database.transaction(() => {
    const row = database
      .prepare(
        "SELECT status, lease_token, lease_expires_at FROM outbox_messages WHERE id = $id",
      )
      .get({ $id: messageId }) as {
      status: string;
      lease_token: string | null;
      lease_expires_at: number | null;
    } | null;

    if (!row) return "not_found" as const;

    // Idempotent: already delivered with same token
    if (row.status === "delivered" && row.lease_token === leaseToken) {
      return "already_delivered" as const;
    }

    // Must be leased with matching token and active lease
    if (
      row.status !== "leased" ||
      row.lease_token !== leaseToken ||
      !row.lease_expires_at ||
      row.lease_expires_at <= now
    ) {
      return "lease_conflict" as const;
    }

    const result = database
      .prepare(
        `UPDATE outbox_messages
         SET status = 'delivered', updated_at = $now
         WHERE id = $id AND status = 'leased' AND lease_token = $leaseToken`,
      )
      .run({ $id: messageId, $leaseToken: leaseToken, $now: now });

    return result.changes === 1
      ? ("delivered" as const)
      : ("lease_conflict" as const);
  })();
}

// --- List + purge operations ---

/**
 * List recent inbox messages, most recent first.
 */
export function listInboxMessages(limit = 20): InboxMessage[] {
  const database = getDatabase();
  return database
    .prepare(
      "SELECT * FROM inbox_messages ORDER BY created_at DESC LIMIT $limit",
    )
    .all({ $limit: limit }) as InboxMessage[];
}

/**
 * List recent outbox messages, most recent first.
 */
export function listOutboxMessages(limit = 20): OutboxMessage[] {
  const database = getDatabase();
  return database
    .prepare(
      "SELECT * FROM outbox_messages ORDER BY created_at DESC LIMIT $limit",
    )
    .all({ $limit: limit }) as OutboxMessage[];
}

/**
 * Purge all inbox and outbox messages. Returns deleted counts.
 * Intended for dev/test cleanup only.
 */
export function purgeMessages(): { inbox: number; outbox: number } {
  const database = getDatabase();
  return database.transaction(() => {
    const inboxResult = database.prepare("DELETE FROM inbox_messages").run();
    const outboxResult = database.prepare("DELETE FROM outbox_messages").run();
    return {
      inbox: inboxResult.changes,
      outbox: outboxResult.changes,
    };
  })();
}

// --- Turn operations ---

export interface Turn {
  id: string;
  topic_key: string;
  role: "user" | "assistant";
  content: string;
  created_at: number;
}

/**
 * Save a single turn (user or assistant) for a topic.
 */
export function saveTurn(
  topicKey: string,
  role: "user" | "assistant",
  content: string,
): Turn {
  const database = getDatabase();
  const id = `turn_${crypto.randomUUID()}`;
  const now = Date.now();

  database
    .prepare(
      "INSERT INTO turns (id, topic_key, role, content, created_at) VALUES ($id, $topicKey, $role, $content, $now)",
    )
    .run({
      $id: id,
      $topicKey: topicKey,
      $role: role,
      $content: content,
      $now: now,
    });

  return { id, topic_key: topicKey, role, content, created_at: now };
}

/**
 * Load the most recent turns for a topic, ordered oldest-first.
 *
 * @param limit Maximum number of turn **pairs** to return (default 8).
 *              Fetches limit * 2 rows to cover user + assistant per pair.
 */
export function loadRecentTurns(topicKey: string, limit = 8): Turn[] {
  const database = getDatabase();
  const maxRows = limit * 2;

  // Subquery grabs the most recent rows (DESC), outer query re-orders ASC.
  // Use _rowid_ for deterministic ordering when created_at ties (same ms).
  return database
    .prepare(
      `SELECT id, topic_key, role, content, created_at FROM (
        SELECT *, _rowid_ AS rn FROM turns
        WHERE topic_key = $topicKey
        ORDER BY rn DESC
        LIMIT $maxRows
      ) ORDER BY rn ASC`,
    )
    .all({ $topicKey: topicKey, $maxRows: maxRows }) as Turn[];
}

// --- Extraction cursor operations ---

export interface ExtractionCursor {
  topic_key: string;
  last_extracted_rowid: number;
  turns_since_extraction: number;
}

/**
 * Get the extraction cursor for a topic.
 * Returns null if no extraction has ever run for this topic.
 */
export function getExtractionCursor(topicKey: string): ExtractionCursor | null {
  const database = getDatabase();
  return (
    (database
      .prepare(
        "SELECT topic_key, last_extracted_rowid, turns_since_extraction FROM extraction_cursors WHERE topic_key = $topicKey",
      )
      .get({ $topicKey: topicKey }) as ExtractionCursor | null) ?? null
  );
}

/**
 * Increment the turns-since-extraction counter for a topic.
 *
 * If no cursor exists, creates one with last_extracted_rowid = 0
 * and turns_since_extraction = 1 (first turn, no extraction yet).
 */
export function incrementTurnsSinceExtraction(topicKey: string): void {
  const database = getDatabase();
  database
    .prepare(
      `INSERT INTO extraction_cursors (topic_key, last_extracted_rowid, turns_since_extraction)
       VALUES ($topicKey, 0, 1)
       ON CONFLICT(topic_key) DO UPDATE
       SET turns_since_extraction = turns_since_extraction + 1`,
    )
    .run({ $topicKey: topicKey });
}

/**
 * Advance the extraction cursor after a successful extraction run.
 * Resets turns_since_extraction to 0.
 *
 * Uses MAX() as defense-in-depth — the caller (loop.ts) serializes
 * extraction per topic, so out-of-order advances should not occur,
 * but the guard is cheap and makes the invariant self-enforcing.
 */
export function advanceExtractionCursor(
  topicKey: string,
  lastRowid: number,
): void {
  const database = getDatabase();
  database
    .prepare(
      `INSERT INTO extraction_cursors (topic_key, last_extracted_rowid, turns_since_extraction)
       VALUES ($topicKey, $lastRowid, 0)
       ON CONFLICT(topic_key) DO UPDATE
       SET last_extracted_rowid = MAX(last_extracted_rowid, $lastRowid),
           turns_since_extraction = 0`,
    )
    .run({ $topicKey: topicKey, $lastRowid: lastRowid });
}

/**
 * Load turns newer than the extraction cursor for a topic.
 *
 * Returns turns with _rowid_ > afterRowid, ordered oldest-first.
 * Also returns each turn's _rowid_ for cursor advancement.
 *
 * @param limit Maximum number of turns to return (default: no limit).
 */
export function loadTurnsSinceCursor(
  topicKey: string,
  afterRowid: number,
  limit?: number,
): Array<Turn & { rowid: number }> {
  const database = getDatabase();
  const limitClause = limit !== undefined ? `LIMIT $limit` : "";
  return database
    .prepare(
      `SELECT _rowid_ AS rowid, id, topic_key, role, content, created_at
       FROM turns
       WHERE topic_key = $topicKey AND _rowid_ > $afterRowid
       ORDER BY _rowid_ ASC
       ${limitClause}`,
    )
    .all(
      limit !== undefined
        ? { $topicKey: topicKey, $afterRowid: afterRowid, $limit: limit }
        : { $topicKey: topicKey, $afterRowid: afterRowid },
    ) as Array<Turn & { rowid: number }>;
}

// --- Topic summary operations ---

/**
 * Get the cached topic summary for a topic.
 * Returns null if no summary exists yet.
 */
export function getTopicSummary(topicKey: string): string | null {
  const database = getDatabase();
  const row = database
    .prepare("SELECT summary FROM topic_summaries WHERE topic_key = $topicKey")
    .get({ $topicKey: topicKey }) as { summary: string } | null;
  return row?.summary ?? null;
}

/**
 * Upsert the cached topic summary for a topic.
 * Overwrites any existing summary (INSERT OR REPLACE on PK).
 */
export function upsertTopicSummary(topicKey: string, summary: string): void {
  const database = getDatabase();
  database
    .prepare(
      `INSERT INTO topic_summaries (topic_key, summary, updated_at)
       VALUES ($topicKey, $summary, $now)
       ON CONFLICT(topic_key) DO UPDATE
       SET summary = $summary, updated_at = $now`,
    )
    .run({ $topicKey: topicKey, $summary: summary, $now: Date.now() });
}
