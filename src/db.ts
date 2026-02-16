/**
 * SQLite database for Cortex.
 *
 * Manages inbox/outbox queues, turns, extraction cursors, and scheduler jobs.
 * Tables are created incrementally as each slice adds its schema.
 *
 * Database location: ~/.local/share/cortex/cortex.db
 * Tests can override via initDatabase({ path: ":memory:", force: true }).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

// --- Connection ---

let db: Database | null = null;

const DEFAULT_DB_PATH = join(
  homedir(),
  ".local",
  "share",
  "cortex",
  "cortex.db",
);

export function initDatabase(options?: {
  path?: string;
  force?: boolean;
}): Database {
  if (db && !options?.force) return db;
  if (db) {
    db.close();
    db = null;
  }

  const dbPath = options?.path ?? DEFAULT_DB_PATH;

  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  createSchema(db);
  return db;
}

export function getDatabase(): Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// --- Schema ---

function createSchema(database: Database): void {
  database.exec(`
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
  `);
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
