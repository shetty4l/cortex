/**
 * Cortex — Channel-agnostic life assistant runtime.
 *
 * Entry point. Loads config, initializes the database,
 * starts the HTTP server, and runs the processing loop.
 */

import { loadConfig } from "./config";
import { initDatabase } from "./db";
import { startProcessingLoop } from "./loop";
import { createServer } from "./server";
import { VERSION } from "./version";

console.log(`cortex v${VERSION}`);

const config = loadConfig();
initDatabase();

const server = createServer(config);
const httpServer = server.start();

const loop = startProcessingLoop(config);
console.log("cortex: processing loop started");

// Graceful shutdown
const SHUTDOWN_TIMEOUT_MS = 35_000;
let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return; // ignore double SIGINT/SIGTERM
  shuttingDown = true;

  console.log("cortex: shutting down...");

  // Hard exit if graceful shutdown stalls
  const forceExit = setTimeout(() => {
    console.error("cortex: shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref(); // don't keep the process alive just for this timer

  loop
    .stop()
    .catch((err: unknown) => {
      console.error("cortex: error during loop shutdown:", err);
    })
    .then(() => {
      httpServer.stop(true);
      clearTimeout(forceExit);
      console.log("cortex: stopped");
      process.exit(0);
    });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
