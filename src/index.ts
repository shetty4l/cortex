/**
 * Cortex — Channel-agnostic life assistant runtime.
 *
 * Entry point. Loads config, initializes the database,
 * starts the HTTP server, and runs the processing loop.
 */

import { onShutdown } from "@shetty4l/core/signals";
import { readVersion } from "@shetty4l/core/version";
import { join } from "path";
import { loadConfig } from "./config";
import { initDatabase } from "./db";
import { startProcessingLoop } from "./loop";
import { startServer } from "./server";

const VERSION = readVersion(join(import.meta.dir, ".."));
console.error(`cortex v${VERSION}`);

const configResult = loadConfig();
if (!configResult.ok) {
  console.error(`cortex: ${configResult.error}`);
  process.exit(1);
}
const config = configResult.value;

const dbResult = initDatabase();
if (!dbResult.ok) {
  console.error(`cortex: ${dbResult.error}`);
  process.exit(1);
}

const server = startServer(config);
const loop = startProcessingLoop(config);
console.error("cortex: processing loop started");

onShutdown(
  async () => {
    await loop.stop();
    server.stop();
  },
  { name: "cortex", timeoutMs: 35_000 },
);
