/**
 * SQLite database for Cortex.
 *
 * This module provides core database lifecycle management.
 * Entity CRUD operations have been moved to their respective modules:
 * - src/inbox/index.ts - InboxMessage operations
 * - src/outbox/index.ts - OutboxMessage operations
 * - src/turns/index.ts - Turn operations
 * - src/receptor-buffers/index.ts - ReceptorBuffer operations
 * - src/approvals/index.ts - PendingApproval operations
 * - src/scheduled-events/index.ts - ScheduledEvent operations
 *
 * Database location: ~/.local/share/cortex/cortex.db
 * Tests can override via initDatabase(":memory:").
 */

import type { Database } from "bun:sqlite";
import { getDataDir } from "@shetty4l/core/config";
import { createDatabaseManager } from "@shetty4l/core/db";
import { createLogger } from "@shetty4l/core/log";
import { StateLoader } from "@shetty4l/core/state";
import { join } from "path";
import { InboxMessage } from "./inbox";
import { OutboxMessage } from "./outbox";

const log = createLogger("cortex");

// --- Connection (via core DatabaseManager) ---

const dbManager = createDatabaseManager({
  path: join(getDataDir("cortex"), "cortex.db"),
  // Schema is now managed by StateLoader's @PersistedCollection entities
  schema: "",
});

/**
 * Initialize the database. Returns the Database instance on success.
 * Idempotent — returns existing instance if already open.
 * Pass a pathOverride to force close + reopen (used by tests with ":memory:").
 */
export function initDatabase(pathOverride?: string): Database {
  // If a pathOverride is given, close existing and re-init
  if (pathOverride !== undefined) {
    dbManager.close();
  }
  const db = dbManager.init(pathOverride);
  // Enable foreign keys (core sets WAL mode already)
  db.exec("PRAGMA foreign_keys = ON");

  // Recover inbox messages stuck in 'processing' from a prior crash.
  // Safe because the processing loop hasn't started yet at this point.
  const loader = new StateLoader(db);
  const recovered = loader.updateWhere(
    InboxMessage,
    { status: "processing" },
    { status: "pending" },
  );
  if (recovered > 0) {
    log(`recovered ${recovered} inbox messages stuck in processing`);
  }

  return db;
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

// --- Utility functions ---

/**
 * Compute exponential backoff delay for queue retries.
 * Formula: min(2^(attempts-1) * 5000ms, 15min) with ±20% jitter.
 *
 * Pure function — exported for testing.
 */
export function computeBackoffDelay(attempts: number): number {
  const base = Math.min(2 ** (attempts - 1) * 5000, 900_000);
  const jitter = 0.8 + Math.random() * 0.4; // [0.8, 1.2]
  return Math.round(base * jitter);
}

// --- Purge operations ---

/**
 * Purge all inbox and outbox messages. Returns deleted counts.
 * Intended for dev/test cleanup only.
 */
export function purgeMessages(): { inbox: number; outbox: number } {
  const db = getDatabase();
  const loader = new StateLoader(db);

  // Use deleteWhere with status IN [...all statuses] since deleteWhere requires a condition
  // Type cast needed due to WhereCondition type limitation for 'in' operator
  const inboxCount = loader.deleteWhere(InboxMessage, {
    status: {
      op: "in",
      value: ["pending", "processing", "done", "failed"] as unknown as string,
    },
  });
  const outboxCount = loader.deleteWhere(OutboxMessage, {
    status: {
      op: "in",
      value: ["pending", "leased", "delivered", "dead"] as unknown as string,
    },
  });

  return {
    inbox: inboxCount,
    outbox: outboxCount,
  };
}
