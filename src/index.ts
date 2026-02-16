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
function shutdown() {
  console.log("cortex: shutting down...");
  loop.stop().then(() => {
    httpServer.stop(true);
    console.log("cortex: stopped");
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
