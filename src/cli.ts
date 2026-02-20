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
 *   cortex send "msg" --topic ID  Send on a fixed topic (multi-turn)
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
import {
  createDaemonCommands,
  createHealthCommand,
  createLogsCommand,
  runCli,
} from "@shetty4l/core/cli";
import { getConfigDir } from "@shetty4l/core/config";
import { createDaemonManager } from "@shetty4l/core/daemon";
import { join } from "path";
import { loadConfig } from "./config";
import {
  initDatabase,
  listInboxMessages,
  listOutboxMessages,
  purgeMessages,
} from "./db";
import { run } from "./index";
import { sendMessage } from "./send";
import { VERSION } from "./version";

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
  --topic ID            Use a fixed topic key for send (enables multi-turn)
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

async function cmdServe(): Promise<void> {
  await run();
}

const daemonCmds = createDaemonCommands({ name: "cortex", getDaemon });

const cmdHealth = createHealthCommand({
  name: "cortex",
  getHealthUrl: () => {
    const configResult = loadConfig({ quiet: true, skipRequiredChecks: true });
    const port = configResult.ok ? configResult.value.port : 7751;
    return `http://localhost:${port}/health`;
  },
});

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

  const LABELS: Record<string, string> = {
    host: "Host",
    port: "Port",
    ingestApiKey: "Ingest API key",
    synapseUrl: "Synapse",
    engramUrl: "Engram",
    model: "Model",
    extractionModel: "Extraction model",
    activeWindowSize: "Active window",
    extractionInterval: "Extraction interval",
    turnTtlDays: "Turn TTL",
    schedulerTickSeconds: "Scheduler tick",
    schedulerTimezone: "Scheduler timezone",
    telegramBotToken: "Telegram token",
    telegramAllowedUserIds: "Telegram allowed users",
    outboxPollDefaultBatch: "Outbox batch",
    outboxLeaseSeconds: "Outbox lease",
    outboxMaxAttempts: "Outbox max attempts",
    systemPromptFile: "System prompt",
    skillDirs: "Skill dirs",
    skillConfig: "Skill config",
    toolTimeoutMs: "Tool timeout",
    maxToolRounds: "Max tool rounds",
  };

  const UNITS: Record<string, string> = {
    activeWindowSize: "turns",
    extractionInterval: "turns",
    turnTtlDays: "days",
    schedulerTickSeconds: "s",
    outboxLeaseSeconds: "s",
    toolTimeoutMs: "ms",
  };

  const MASK = new Set(["ingestApiKey", "telegramBotToken"]);

  console.log("");
  for (const [key, value] of Object.entries(config)) {
    const label = LABELS[key] ?? key;
    const unit = UNITS[key] ? ` ${UNITS[key]}` : "";
    let display: string;

    if (MASK.has(key)) {
      display = value ? "***" : "(not set)";
    } else if (value == null) {
      display = "(not set)";
    } else if (Array.isArray(value)) {
      display = value.length > 0 ? value.join(", ") : "(none)";
    } else if (typeof value === "object") {
      const keys = Object.keys(value as Record<string, unknown>);
      display = keys.length > 0 ? keys.join(", ") : "(none)";
    } else {
      display = String(value);
    }

    console.log(`${label}: ${display}${unit}`);
  }
  console.log("");
  return 0;
}

const cmdLogs = createLogsCommand({
  logFile: LOG_FILE,
  emptyMessage: "No logs found.",
});

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
    const raw = msg.text.replace(/\n/g, " ");
    const text = raw.length > 28 ? `${raw.slice(0, 25)}...` : raw;
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
    const raw = msg.text.replace(/\n/g, " ");
    const text = raw.length > 28 ? `${raw.slice(0, 25)}...` : raw;
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
  // Extract --topic <value> from args
  let topicKey: string | undefined;
  const filtered: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--topic") {
      topicKey = args[++i];
      if (!topicKey) {
        console.error("Error: --topic requires a value.");
        return 1;
      }
    } else {
      filtered.push(args[i]);
    }
  }

  const text = filtered[0];
  if (!text || text.length === 0) {
    console.error(
      'Error: message text is required.\n\nUsage: cortex send "your message" [--topic ID]',
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

  const result = await sendMessage(text, { baseUrl, apiKey, topicKey });

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
    ...daemonCmds,
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
