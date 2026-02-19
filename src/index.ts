/**
 * Cortex — Channel-agnostic life assistant runtime.
 *
 * Entry point. Loads config, initializes the database,
 * loads skills, starts the HTTP server, and runs the processing loop.
 */

import { ok } from "@shetty4l/core/result";
import { onShutdown } from "@shetty4l/core/signals";
import { readVersion } from "@shetty4l/core/version";
import { join } from "path";
import { loadConfig } from "./config";
import { initDatabase } from "./db";
import { startProcessingLoop } from "./loop";
import { startServer } from "./server";
import { createEmptyRegistry, loadSkills } from "./skills";

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

// Load skills from configured directories (empty registry if none configured)
const registryResult =
  config.skillDirs.length > 0
    ? await loadSkills(config.skillDirs, config.skillConfig)
    : ok(createEmptyRegistry());

if (!registryResult.ok) {
  console.error(`cortex: fatal: ${registryResult.error}`);
  process.exit(1);
}

const _registry = registryResult.value;
console.error(
  `cortex: loaded ${_registry.tools.length} tools from ${config.skillDirs.length} skill dirs`,
);

const server = startServer(config);
console.error(`cortex: listening on http://${config.host}:${config.port}`);
const loop = startProcessingLoop(config, _registry);
console.error("cortex: processing loop started");

onShutdown(
  async () => {
    await loop.stop();
    server.stop();
  },
  { name: "cortex", timeoutMs: 35_000 },
);
