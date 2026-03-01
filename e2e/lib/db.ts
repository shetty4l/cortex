/**
 * Database helpers for E2E tests using bun:sqlite.
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { getConfig } from "./config";

let _cortexDb: Database | null = null;
let _wilsonDb: Database | null = null;

export async function openCortexDb(): Promise<Database> {
  if (!_cortexDb) {
    const config = await getConfig();
    _cortexDb = new Database(config.db.cortexPath, { readwrite: true });
  }
  return _cortexDb;
}

export async function openWilsonDb(): Promise<Database> {
  if (!_wilsonDb) {
    const config = await getConfig();
    _wilsonDb = new Database(config.db.wilsonPath, { readwrite: true });
  }
  return _wilsonDb;
}

export function query<T>(
  db: Database,
  sql: string,
  params?: SQLQueryBindings
): T[] {
  const stmt = db.prepare(sql);
  if (params) {
    return stmt.all(params) as T[];
  }
  return stmt.all() as T[];
}

export function queryOne<T>(
  db: Database,
  sql: string,
  params?: SQLQueryBindings
): T | null {
  const results = query<T>(db, sql, params);
  return results[0] ?? null;
}

export function execute(
  db: Database,
  sql: string,
  params?: SQLQueryBindings
): void {
  const stmt = db.prepare(sql);
  if (params) {
    stmt.run(params);
  } else {
    stmt.run();
  }
}
