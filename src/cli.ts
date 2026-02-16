#!/usr/bin/env bun

/**
 * Cortex CLI
 *
 * Usage:
 *   cortex start          Start the server (background daemon)
 *   cortex stop           Stop the daemon
 *   cortex status         Show daemon status
 *   cortex restart        Restart the daemon
 *   cortex serve          Start the server (foreground)
 *   cortex health         Check health of running instance
 *   cortex config         Print resolved configuration
 *   cortex logs [n]       Show last n log lines (default: 20)
 *   cortex version        Show version
 *
 * Options:
 *   --json                Machine-readable JSON output
 *   --help, -h            Show help
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { loadConfig } from "./config";
import {
  getDaemonStatus,
  restartDaemon,
  startDaemon,
  stopDaemon,
} from "./daemon";
import { initDatabase } from "./db";
import { startProcessingLoop } from "./loop";
import { createServer } from "./server";
import { VERSION } from "./version";

const HELP = `
Cortex CLI — Channel-agnostic life assistant runtime

Usage:
  cortex start          Start the server (background daemon)
  cortex stop           Stop the daemon
  cortex status         Show daemon status
  cortex restart        Restart the daemon
  cortex serve          Start the server (foreground)
  cortex health         Check health of running instance
  cortex config         Print resolved configuration
  cortex logs [n]       Show last n log lines (default: 20)
  cortex version        Show version

Options:
  --json                Machine-readable JSON output
  --version, -v         Show version
  --help, -h            Show help
`;

const LOG_FILE = join(homedir(), ".config", "cortex", "cortex.log");

// --- Arg parsing ---

function parseArgs(args: string[]): {
  command: string;
  args: string[];
  json: boolean;
} {
  const filtered = args.filter((a) => a !== "--json");
  const json = args.includes("--json");
  const [command = "help", ...rest] = filtered;
  return { command, args: rest, json };
}

// --- Commands ---

function cmdServe(): void {
  const config = loadConfig();
  initDatabase();
  const server = createServer(config);
  const instance = server.start();
  const loop = startProcessingLoop(config);
  console.log("cortex: processing loop started");

  const SHUTDOWN_TIMEOUT_MS = 35_000;
  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log("\ncortex: shutting down...");

    const forceExit = setTimeout(() => {
      console.error("cortex: shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    loop
      .stop()
      .catch((err: unknown) => {
        console.error("cortex: error during loop shutdown:", err);
      })
      .then(() => {
        instance.stop(true);
        clearTimeout(forceExit);
        console.log("cortex: stopped");
        process.exit(0);
      });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function cmdStart(): Promise<void> {
  const started = await startDaemon();
  process.exit(started ? 0 : 1);
}

async function cmdStop(): Promise<void> {
  const stopped = await stopDaemon();
  process.exit(stopped ? 0 : 1);
}

async function cmdStatus(json: boolean): Promise<void> {
  const status = await getDaemonStatus();

  if (json) {
    console.log(JSON.stringify(status, null, 2));
    process.exit(status.running ? 0 : 1);
  }

  if (!status.running) {
    console.log("cortex is not running");
    process.exit(1);
  }

  const uptimeStr = status.uptime ? formatUptime(status.uptime) : "unknown";
  console.log(
    `cortex is running (PID: ${status.pid}, port: ${status.port}, uptime: ${uptimeStr})`,
  );
  process.exit(0);
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

async function cmdRestart(): Promise<void> {
  const restarted = await restartDaemon();
  process.exit(restarted ? 0 : 1);
}

async function cmdHealth(json: boolean): Promise<void> {
  let port: number;
  try {
    const config = loadConfig({ quiet: true });
    port = config.port;
  } catch {
    port = 7751;
  }

  let response: Response;
  try {
    response = await fetch(`http://localhost:${port}/health`);
  } catch {
    if (json) {
      console.log(JSON.stringify({ error: "Server not reachable", port }));
    } else {
      console.error(`cortex is not running on port ${port}`);
    }
    process.exit(1);
  }

  const data = (await response.json()) as {
    status: string;
    version: string;
    uptime: number;
  };

  if (json) {
    console.log(JSON.stringify(data, null, 2));
    process.exit(data.status === "healthy" ? 0 : 1);
  }

  console.log(
    `\nStatus:  ${data.status === "healthy" ? "healthy" : "degraded"}`,
  );
  console.log(`Version: ${data.version}`);
  console.log(`Uptime:  ${formatUptime(data.uptime)}\n`);

  process.exit(data.status === "healthy" ? 0 : 1);
}

function cmdConfig(json: boolean): void {
  const config = loadConfig();

  if (json) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  console.log(`\nHost: ${config.host}`);
  console.log(`Port: ${config.port}`);
  console.log(`Synapse: ${config.synapseUrl}`);
  console.log(`Engram: ${config.engramUrl}`);
  console.log(`Model: ${config.model ?? "(not set)"}`);
  console.log(`Extraction model: ${config.extractionModel ?? "(not set)"}`);
  console.log(`Ingest API key: ${config.ingestApiKey ? "***" : "(not set)"}`);
  console.log(`Active window: ${config.activeWindowSize} turns`);
  console.log(`Extraction interval: ${config.extractionInterval} turns`);
  console.log(`Turn TTL: ${config.turnTtlDays} days`);
  console.log(`Scheduler tick: ${config.schedulerTickSeconds}s`);
  console.log(`Scheduler timezone: ${config.schedulerTimezone}`);
  console.log(`Outbox batch: ${config.outboxPollDefaultBatch}`);
  console.log(`Outbox lease: ${config.outboxLeaseSeconds}s`);
  console.log(`Outbox max attempts: ${config.outboxMaxAttempts}`);
  console.log(
    `Skill dirs: ${config.skillDirs.length > 0 ? config.skillDirs.join(", ") : "(none)"}`,
  );
  console.log(`Tool timeout: ${config.toolTimeoutMs}ms\n`);
}

function cmdLogs(countStr: string | undefined, json: boolean): void {
  const count = countStr ? Number.parseInt(countStr, 10) : 20;

  if (Number.isNaN(count) || count < 1) {
    console.error("Error: count must be a positive number");
    process.exit(1);
  }

  if (!existsSync(LOG_FILE)) {
    if (json) {
      console.log(JSON.stringify({ lines: [], count: 0 }));
    } else {
      console.log("No logs found.");
    }
    return;
  }

  const content = readFileSync(LOG_FILE, "utf-8").trimEnd();
  if (content.length === 0) {
    if (json) {
      console.log(JSON.stringify({ lines: [], count: 0 }));
    } else {
      console.log("No logs found.");
    }
    return;
  }

  const lines = content.split("\n");
  const tail = lines.slice(-count);

  if (json) {
    console.log(JSON.stringify({ lines: tail, count: tail.length }, null, 2));
    return;
  }

  for (const line of tail) {
    console.log(line);
  }

  console.log(`\nShowing ${tail.length} of ${lines.length} lines`);
}

// --- Main ---

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (
    rawArgs.includes("--help") ||
    rawArgs.includes("-h") ||
    rawArgs.length === 0
  ) {
    console.log(HELP);
    process.exit(0);
  }

  if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
  }

  const { command, args, json } = parseArgs(rawArgs);

  switch (command) {
    case "start":
      await cmdStart();
      return;
    case "stop":
      await cmdStop();
      return;
    case "status":
      await cmdStatus(json);
      return;
    case "restart":
      await cmdRestart();
      return;
    case "serve":
      cmdServe();
      return;
    case "health":
      await cmdHealth(json);
      return;
    case "config":
      cmdConfig(json);
      return;
    case "logs":
      cmdLogs(args[0], json);
      return;
    case "version":
      console.log(VERSION);
      return;
    case "help":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main();
