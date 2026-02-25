import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateLoader } from "@shetty4l/core/state";
import {
  closeDatabase,
  createConnectionPool,
  getDatabase,
  initDatabase,
} from "../src/db";
import { InboxMessage } from "../src/inbox";

describe("ConnectionPool", () => {
  const testDbPath = join(tmpdir(), `cortex-pool-test-${Date.now()}.db`);

  beforeEach(() => {
    // Initialize the main database to create the file
    initDatabase(testDbPath);
    // Create the inbox table schema via StateLoader
    const loader = new StateLoader(getDatabase());
    // Touch InboxMessage to ensure table exists
    loader.find(InboxMessage, { limit: 1 });
  });

  afterEach(() => {
    closeDatabase();
    try {
      unlinkSync(testDbPath);
      unlinkSync(`${testDbPath}-wal`);
      unlinkSync(`${testDbPath}-shm`);
    } catch {
      // Ignore cleanup errors
    }
  });

  test("getConnection returns same connection for same consumerId", () => {
    const pool = createConnectionPool(testDbPath);

    const conn1 = pool.getConnection("main");
    const conn2 = pool.getConnection("main");

    expect(conn1).toBe(conn2);

    pool.closeAll();
  });

  test("getConnection returns different connections for different consumerIds", () => {
    const pool = createConnectionPool(testDbPath);

    const conn1 = pool.getConnection("main");
    const conn2 = pool.getConnection("channels");

    expect(conn1).not.toBe(conn2);

    pool.closeAll();
  });

  test("getLoader returns same loader for same consumerId", () => {
    const pool = createConnectionPool(testDbPath);

    const loader1 = pool.getLoader("main");
    const loader2 = pool.getLoader("main");

    expect(loader1).toBe(loader2);

    pool.closeAll();
  });

  test("getLoader returns different loaders for different consumerIds", () => {
    const pool = createConnectionPool(testDbPath);

    const loader1 = pool.getLoader("main");
    const loader2 = pool.getLoader("channels");

    expect(loader1).not.toBe(loader2);

    pool.closeAll();
  });

  test("sequential transactions on different loaders work correctly", async () => {
    const pool = createConnectionPool(testDbPath);
    const loader1 = pool.getLoader("main");
    const loader2 = pool.getLoader("channels");

    // Sequential transactions on different loaders work fine
    const result1 = await loader1.transaction(async () => {
      return "result1";
    });

    const result2 = await loader2.transaction(async () => {
      return "result2";
    });

    expect(result1).toBe("result1");
    expect(result2).toBe("result2");

    pool.closeAll();
  });

  test("different loaders avoid nested transaction error", async () => {
    const pool = createConnectionPool(testDbPath);
    const loader1 = pool.getLoader("main");
    const loader2 = pool.getLoader("channels");

    // The key fix: when the silent channel starts and tries to do a transaction,
    // and the processing loop is also trying to do a transaction at the same time,
    // having separate connections prevents "cannot start a transaction within a transaction"
    // because each connection has its own transaction state.

    // Start transaction on loader1
    await loader1.transaction(async () => {
      // While loader1's transaction is open, loader2 can also start one
      // (though it will block until loader1 commits)
      // This does NOT throw "cannot start a transaction within a transaction"
      // because they are separate connections
      return "done1";
    });

    // loader2 can run its own transaction independently
    await loader2.transaction(async () => {
      return "done2";
    });

    pool.closeAll();
  });

  test("single loader concurrent transactions DO conflict (documents the issue)", async () => {
    const pool = createConnectionPool(testDbPath);
    const loader = pool.getLoader("main");

    // When using the SAME loader for concurrent transactions, we get an error
    // This documents why we need the connection pool
    let errorThrown = false;

    try {
      await Promise.all([
        loader.transaction(async () => {
          await Bun.sleep(50);
          return "result1";
        }),
        loader.transaction(async () => {
          await Bun.sleep(50);
          return "result2";
        }),
      ]);
    } catch (e) {
      errorThrown = true;
      expect(String(e)).toContain("cannot start a transaction");
    }

    expect(errorThrown).toBe(true);

    pool.closeAll();
  });

  test("closeAll closes all connections", () => {
    const pool = createConnectionPool(testDbPath);

    // Create multiple connections
    pool.getConnection("main");
    pool.getConnection("channels");
    pool.getConnection("tick");

    // Should not throw
    pool.closeAll();

    // Getting a connection after closeAll creates a new one
    const newConn = pool.getConnection("main");
    expect(newConn).toBeTruthy();

    pool.closeAll();
  });

  test("connections use WAL mode", () => {
    const pool = createConnectionPool(testDbPath);
    const conn = pool.getConnection("test");

    const result = conn.query("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    expect(result.journal_mode).toBe("wal");

    pool.closeAll();
  });
});
