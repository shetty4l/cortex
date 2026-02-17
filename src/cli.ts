#!/usr/bin/env bun

/**
 * Cortex CLI — channel-agnostic life assistant runtime
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

import type { CommandHandler } from "@shetty4l/core/cli";
import { formatUptime, runCli } from "@shetty4l/core/cli";
import { getConfigDir } from "@shetty4l/core/config";
import { createDaemonManager } from "@shetty4l/core/daemon";
import { onShutdown } from "@shetty4l/core/signals";
import { readVersion } from "@shetty4l/core/version";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { loadConfig } from "./config";
import {
  initDatabase,
  listInboxMessages,
  listOutboxMessages,
  purgeMessages,
} from "./db";
import { startProcessingLoop } from "./loop";
import { sendMessage } from "./send";
import { startServer } from "./server";

const VERSION = readVersion(join(import.meta.dir, ".."));

const HELP = `
Cortex CLI \u2014 channel-agnostic life assistant runtime

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

Options:
  --json                Machine-readable JSON output
  --confirm             Required for destructive operations (purge)
  --version, -v         Show version
  --help, -h            Show help
`;

const CONFIG_DIR = getConfigDir("cortex");
const LOG_FILE = join(CONFIG_DIR, "cortex.log");

// --- Daemon manager (lazy — needs port from config for health URL) ---

function getDaemon() {
  const configResult = loadConfig({ quiet: true, skipRequiredChecks: true });
  const port = configResult.ok ? configResult.value.port : 7751;

  return createDaemonManager({
    name: "cortex",
    configDir: CONFIG_DIR,
    cliPath: join(import.meta.dir, "cli.ts"),
    healthUrl: `http://localhost:${port}/health`,
  });
}

// --- Helpers ---

/** Wrap a command handler so initDatabase() is called before dispatch. */
function withDb(fn: CommandHandler): CommandHandler {
  return (args, json) => {
    const dbResult = initDatabase();
    if (!dbResult.ok) {
      console.error(`cortex: ${dbResult.error}`);
      return 1;
    }
    return fn(args, json);
  };
}

// --- Commands ---

function cmdServe(): void {
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
}

async function cmdStart(): Promise<number> {
  const daemon = getDaemon();
  const result = await daemon.start();
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }
  console.log(
    `cortex daemon started (PID: ${result.value.pid}, port: ${result.value.port ?? 7751})`,
  );
  return 0;
}

async function cmdStop(): Promise<number> {
  const daemon = getDaemon();
  const result = await daemon.stop();
  if (!result.ok) {
    console.log(result.error);
    return 1;
  }
  console.log(`cortex daemon stopped (was PID: ${result.value.pid})`);
  return 0;
}

async function cmdStatus(_args: string[], json: boolean): Promise<number> {
  const daemon = getDaemon();
  const status = await daemon.status();

  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return status.running ? 0 : 1;
  }

  if (!status.running) {
    console.log("cortex is not running");
    return 1;
  }

  const uptimeStr = status.uptime ? formatUptime(status.uptime) : "unknown";
  console.log(
    `cortex is running (PID: ${status.pid}, port: ${status.port}, uptime: ${uptimeStr})`,
  );
  return 0;
}

async function cmdRestart(): Promise<number> {
  const daemon = getDaemon();
  const result = await daemon.restart();
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }
  console.log(`cortex daemon restarted (PID: ${result.value.pid})`);
  return 0;
}

async function cmdHealth(_args: string[], json: boolean): Promise<number> {
  const configResult = loadConfig({ quiet: true, skipRequiredChecks: true });
  const port = configResult.ok ? configResult.value.port : 7751;

  let response: Response;
  try {
    response = await fetch(`http://localhost:${port}/health`);
  } catch {
    if (json) {
      console.log(JSON.stringify({ error: "Server not reachable", port }));
    } else {
      console.error(`cortex is not running on port ${port}`);
    }
    return 1;
  }

  const data = (await response.json()) as {
    status: string;
    version: string;
    uptime: number;
  };

  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return data.status === "healthy" ? 0 : 1;
  }

  console.log(
    `\nStatus:  ${data.status === "healthy" ? "healthy" : "degraded"}`,
  );
  console.log(`Version: ${data.version}`);
  console.log(`Uptime:  ${formatUptime(data.uptime)}\n`);

  return data.status === "healthy" ? 0 : 1;
}

function cmdConfig(_args: string[], json: boolean): number {
  const configResult = loadConfig();
  if (!configResult.ok) {
    console.error(`cortex: ${configResult.error}`);
    return 1;
  }
  const config = configResult.value;

  if (json) {
    console.log(JSON.stringify(config, null, 2));
    return 0;
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
  return 0;
}

function cmdLogs(args: string[], json: boolean): number {
  const count = args[0] ? Number.parseInt(args[0], 10) : 20;

  if (Number.isNaN(count) || count < 1) {
    console.error("Error: count must be a positive number");
    return 1;
  }

  if (!existsSync(LOG_FILE)) {
    if (json) {
      console.log(JSON.stringify({ lines: [], count: 0 }));
    } else {
      console.log("No logs found.");
    }
    return 0;
  }

  const content = readFileSync(LOG_FILE, "utf-8").trimEnd();
  if (content.length === 0) {
    if (json) {
      console.log(JSON.stringify({ lines: [], count: 0 }));
    } else {
      console.log("No logs found.");
    }
    return 0;
  }

  const lines = content.split("\n");
  const tail = lines.slice(-count);

  if (json) {
    console.log(JSON.stringify({ lines: tail, count: tail.length }, null, 2));
    return 0;
  }

  for (const line of tail) {
    console.log(line);
  }

  console.log(`\nShowing ${tail.length} of ${lines.length} lines`);
  return 0;
}

// --- Inbox/outbox/purge/send commands ---

function cmdInbox(_args: string[], json: boolean): number {
  const messages = listInboxMessages(20);

  if (json) {
    console.log(JSON.stringify(messages, null, 2));
    return 0;
  }

  if (messages.length === 0) {
    console.log("No inbox messages.");
    return 0;
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
  return 0;
}

function cmdOutbox(_args: string[], json: boolean): number {
  const messages = listOutboxMessages(20);

  if (json) {
    console.log(JSON.stringify(messages, null, 2));
    return 0;
  }

  if (messages.length === 0) {
    console.log("No outbox messages.");
    return 0;
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
  return 0;
}

function cmdPurge(_args: string[], json: boolean): number {
  // --confirm is handled outside core's parseArgs (which only strips --json)
  if (!process.argv.includes("--confirm")) {
    console.error(
      "Error: --confirm flag is required to purge data.\n\nUsage: cortex purge --confirm",
    );
    return 1;
  }

  const counts = purgeMessages();

  if (json) {
    console.log(JSON.stringify(counts, null, 2));
  } else {
    console.log(
      `Purged ${counts.inbox} inbox and ${counts.outbox} outbox messages.`,
    );
  }
  return 0;
}

async function cmdSend(args: string[], json: boolean): Promise<number> {
  const text = args[0];
  if (!text || text.length === 0) {
    console.error(
      'Error: message text is required.\n\nUsage: cortex send "your message"',
    );
    return 1;
  }

  const configResult = loadConfig({ quiet: true });
  if (!configResult.ok) {
    console.error("Error: could not load config (is ingestApiKey set?)");
    return 1;
  }
  const config = configResult.value;

  const baseUrl = `http://localhost:${config.port}`;
  const apiKey = config.ingestApiKey;

  const result = await sendMessage(text, { baseUrl, apiKey });

  if (!result.ok) {
    if (json) {
      console.log(JSON.stringify({ error: result.error }));
    } else {
      console.error(`Error: ${result.error}`);
    }
    return 1;
  }

  if (json) {
    console.log(JSON.stringify({ text: result.value }));
  } else {
    console.log(result.value);
  }
  return 0;
}

// --- Main ---

runCli({
  name: "cortex",
  version: VERSION,
  help: HELP,
  commands: {
    start: () => cmdStart(),
    stop: () => cmdStop(),
    status: cmdStatus,
    restart: () => cmdRestart(),
    serve: () => cmdServe(),
    health: cmdHealth,
    config: cmdConfig,
    logs: cmdLogs,
    send: cmdSend,
    inbox: withDb(cmdInbox),
    outbox: withDb(cmdOutbox),
    purge: withDb(cmdPurge),
  },
});
