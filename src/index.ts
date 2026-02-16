/**
 * Cortex — Channel-agnostic life assistant runtime.
 *
 * Entry point. Loads config and starts the HTTP server.
 */

import { loadConfig } from "./config";
import { createServer } from "./server";
import { VERSION } from "./version";

console.log(`cortex v${VERSION}`);

const config = loadConfig();
const server = createServer(config);
server.start();
