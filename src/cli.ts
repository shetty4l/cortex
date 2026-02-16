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
 *   cortex send "msg"     Send a message and wait for response
 *   cortex inbox          Show recent inbox messages
 *   cortex outbox         Show recent outbox messages
 *   cortex purge          Purge all inbox and outbox messages
 *   cortex version        Show version
 *
 * Options:
 *   --json                Machine-readable JSON output
 *   --confirm             Required for destructive operations (purge)
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
import {
  closeDatabase,
  initDatabase,
  listInboxMessages,
  listOutboxMessages,
  purgeMessages,
} from "./db";
import { startProcessingLoop } from "./loop";
import { sendMessage } from "./send";
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
  cortex send "msg"     Send a message and wait for response
  cortex inbox          Show recent inbox messages
  cortex outbox         Show recent outbox messages
  cortex purge          Purge all inbox and outbox messages
  cortex version        Show version

Options:
  --json                Machine-readable JSON output
  --confirm             Required for destructive operations (purge)
  --version, -v         Show version
  --help, -h            Show help
`;

const LOG_FILE = join(homedir(), ".config", "cortex", "cortex.log");

// --- Arg parsing ---

function parseArgs(args: string[]): {
  command: string;
  args: string[];
  json: boolean;
  confirm: boolean;
} {
  const filtered = args.filter((a) => a !== "--json" && a !== "--confirm");
  const json = args.includes("--json");
  const confirm = args.includes("--confirm");
  const [command = "help", ...rest] = filtered;
  return { command, args: rest, json, confirm };
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

// --- Inbox/outbox/purge/send commands ---

function cmdInbox(json: boolean): void {
  loadConfig({ quiet: true, skipRequiredChecks: true });
  initDatabase();

  try {
    const messages = listInboxMessages(20);

    if (json) {
      console.log(JSON.stringify(messages, null, 2));
      return;
    }

    if (messages.length === 0) {
      console.log("No inbox messages.");
      return;
    }

    console.log(
      `\n${"STATUS".padEnd(12)}${"SOURCE".padEnd(14)}${"TOPIC".padEnd(28)}${"TEXT".padEnd(32)}TIMESTAMP`,
    );
    console.log("-".repeat(100));

    for (const msg of messages) {
      const text =
        msg.text.length > 28 ? `${msg.text.slice(0, 25)}...` : msg.text;
      const topic =
        msg.topic_key.length > 24
          ? `${msg.topic_key.slice(0, 21)}...`
          : msg.topic_key;
      const time = new Date(msg.created_at).toISOString().slice(0, 19);
      console.log(
        `${msg.status.padEnd(12)}${msg.source.padEnd(14)}${topic.padEnd(28)}${text.padEnd(32)}${time}`,
      );
    }

    console.log(`\n${messages.length} messages\n`);
  } finally {
    closeDatabase();
  }
}

function cmdOutbox(json: boolean): void {
  loadConfig({ quiet: true, skipRequiredChecks: true });
  initDatabase();

  try {
    const messages = listOutboxMessages(20);

    if (json) {
      console.log(JSON.stringify(messages, null, 2));
      return;
    }

    if (messages.length === 0) {
      console.log("No outbox messages.");
      return;
    }

    console.log(
      `\n${"STATUS".padEnd(12)}${"SOURCE".padEnd(14)}${"TOPIC".padEnd(28)}${"TEXT".padEnd(32)}${"ATT".padEnd(5)}ERROR`,
    );
    console.log("-".repeat(110));

    for (const msg of messages) {
      const text =
        msg.text.length > 28 ? `${msg.text.slice(0, 25)}...` : msg.text;
      const topic =
        msg.topic_key.length > 24
          ? `${msg.topic_key.slice(0, 21)}...`
          : msg.topic_key;
      const error = msg.last_error
        ? msg.last_error.length > 20
          ? `${msg.last_error.slice(0, 17)}...`
          : msg.last_error
        : "-";
      console.log(
        `${msg.status.padEnd(12)}${msg.source.padEnd(14)}${topic.padEnd(28)}${text.padEnd(32)}${String(msg.attempts).padEnd(5)}${error}`,
      );
    }

    console.log(`\n${messages.length} messages\n`);
  } finally {
    closeDatabase();
  }
}

function cmdPurge(json: boolean, confirm: boolean): void {
  if (!confirm) {
    console.error(
      "Error: --confirm flag is required to purge data.\n\nUsage: cortex purge --confirm",
    );
    process.exit(1);
  }

  loadConfig({ quiet: true, skipRequiredChecks: true });
  initDatabase();

  try {
    const counts = purgeMessages();

    if (json) {
      console.log(JSON.stringify(counts, null, 2));
    } else {
      console.log(
        `Purged ${counts.inbox} inbox and ${counts.outbox} outbox messages.`,
      );
    }
  } finally {
    closeDatabase();
  }
}

async function cmdSend(text: string | undefined, json: boolean): Promise<void> {
  if (!text || text.length === 0) {
    console.error(
      'Error: message text is required.\n\nUsage: cortex send "your message"',
    );
    process.exit(1);
  }

  let config: { port: number; ingestApiKey: string };
  try {
    const full = loadConfig({ quiet: true });
    config = { port: full.port, ingestApiKey: full.ingestApiKey };
  } catch {
    console.error("Error: could not load config (is ingestApiKey set?)");
    process.exit(1);
    return;
  }

  const baseUrl = `http://localhost:${config.port}`;
  const apiKey = config.ingestApiKey;

  try {
    const response = await sendMessage(text, { baseUrl, apiKey });

    if (json) {
      console.log(JSON.stringify({ text: response }));
    } else {
      console.log(response);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      console.log(JSON.stringify({ error: message }));
    } else {
      console.error(`Error: ${message}`);
    }
    process.exit(1);
  }
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

  const { command, args, json, confirm } = parseArgs(rawArgs);

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
    case "send":
      await cmdSend(args[0], json);
      return;
    case "inbox":
      cmdInbox(json);
      return;
    case "outbox":
      cmdOutbox(json);
      return;
    case "purge":
      cmdPurge(json, confirm);
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
