/**
 * Configuration for Cortex.
 *
 * Load order:
 *   1. Defaults (hardcoded)
 *   2. Config file (~/.config/cortex/config.json)
 *   3. Environment variables (CORTEX_PORT, CORTEX_HOST, CORTEX_MODEL, CORTEX_CONFIG_PATH, CORTEX_INGEST_API_KEY, CORTEX_MAX_TOOL_ROUNDS, CORTEX_TELEGRAM_BOT_TOKEN, CORTEX_TELEGRAM_ALLOWED_USER_IDS)
 *
 * String values in the config file support ${ENV_VAR} interpolation.
 */

import { expandPath, loadJsonConfig, parsePort } from "@shetty4l/core/config";
import { createLogger } from "@shetty4l/core/log";
import type { Result } from "@shetty4l/core/result";
import { err, ok } from "@shetty4l/core/result";

const log = createLogger("cortex");

// --- Types ---

export interface CortexConfig {
  // Server
  host: string;
  port: number;

  // Auth
  ingestApiKey: string;

  // Services
  synapseUrl: string;
  engramUrl: string;

  // Models
  model: string;
  extractionModel?: string;

  // History
  activeWindowSize: number;
  extractionInterval: number;
  turnTtlDays: number;

  // Scheduler
  schedulerTickSeconds: number;
  schedulerTimezone: string;

  // Telegram
  telegramBotToken?: string;
  telegramAllowedUserIds?: number[];

  // Outbox
  outboxPollDefaultBatch: number;
  outboxLeaseSeconds: number;
  outboxMaxAttempts: number;

  // System prompt
  systemPromptFile?: string;

  // Skills
  skillDirs: string[];
  skillConfig: Record<string, Record<string, unknown>>;
  toolTimeoutMs: number;
  maxToolRounds: number;
}

// --- Defaults ---

const DEFAULTS: Omit<
  CortexConfig,
  "ingestApiKey" | "model" | "extractionModel"
> = {
  host: "127.0.0.1",
  port: 7751,
  synapseUrl: "http://localhost:7750",
  engramUrl: "http://localhost:7749",
  activeWindowSize: 10,
  extractionInterval: 3,
  turnTtlDays: 30,
  schedulerTickSeconds: 30,
  schedulerTimezone: "UTC",
  telegramBotToken: undefined,
  telegramAllowedUserIds: [],
  outboxPollDefaultBatch: 20,
  outboxLeaseSeconds: 60,
  outboxMaxAttempts: 10,
  skillDirs: [],
  skillConfig: {},
  toolTimeoutMs: 20000,
  maxToolRounds: 8,
};

// --- Validation ---

function requireNonEmptyEnv(envName: string, value: string): Result<string> {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return err(`${envName}: must be a non-empty string`);
  }
  return ok(trimmed);
}

function parseTelegramAllowedUserIdsEnv(
  envName: string,
  value: string,
): Result<number[]> {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return ok([]);
  }

  const userIds: number[] = [];
  for (const rawEntry of trimmed.split(",")) {
    const entry = rawEntry.trim();
    if (!/^-?\d+$/.test(entry)) {
      return err(
        `${envName}: invalid user ID "${entry}" (must be comma-separated integers)`,
      );
    }
    userIds.push(Number(entry));
  }

  return ok(userIds);
}

function validateConfig(raw: unknown): Result<Partial<CortexConfig>> {
  if (typeof raw !== "object" || raw === null) {
    return err("Config must be a JSON object");
  }

  const obj = raw as Record<string, unknown>;
  const result: Partial<CortexConfig> = {};

  // String fields
  const stringFields: Array<{ key: keyof CortexConfig; label: string }> = [
    { key: "host", label: "host" },
    { key: "ingestApiKey", label: "ingestApiKey" },
    { key: "synapseUrl", label: "synapseUrl" },
    { key: "engramUrl", label: "engramUrl" },
    { key: "model", label: "model" },
    { key: "extractionModel", label: "extractionModel" },
    { key: "telegramBotToken", label: "telegramBotToken" },
    { key: "systemPromptFile", label: "systemPromptFile" },
  ];

  for (const field of stringFields) {
    if (obj[field.key] !== undefined) {
      if (typeof obj[field.key] !== "string") {
        return err(`${field.label}: must be a non-empty string`);
      }

      const value = obj[field.key] as string;
      if (field.key === "telegramBotToken") {
        const trimmed = value.trim();
        if (trimmed.length === 0) {
          return err(`${field.label}: must be a non-empty string`);
        }
        result.telegramBotToken = trimmed;
      } else {
        if (value.length === 0) {
          return err(`${field.label}: must be a non-empty string`);
        }
        // biome-ignore lint: dynamic field assignment
        (result as Record<string, unknown>)[field.key] = value;
      }
    }
  }

  if (obj.port !== undefined) {
    if (
      typeof obj.port !== "number" ||
      !Number.isInteger(obj.port) ||
      obj.port < 1 ||
      obj.port > 65535
    ) {
      return err(
        `port: ${obj.port} is not a valid port number (must be an integer 1-65535)`,
      );
    }
    result.port = obj.port;
  }

  // Numeric fields with positive-integer validation
  const numericFields: Array<{
    key: keyof CortexConfig;
    min?: number;
    max?: number;
  }> = [
    { key: "activeWindowSize", min: 1 },
    { key: "extractionInterval", min: 1 },
    { key: "turnTtlDays", min: 1 },
    { key: "schedulerTickSeconds", min: 1 },
    { key: "outboxPollDefaultBatch", min: 1, max: 100 },
    { key: "outboxLeaseSeconds", min: 10, max: 300 },
    { key: "outboxMaxAttempts", min: 1 },
    { key: "toolTimeoutMs", min: 1000 },
    { key: "maxToolRounds", min: 1, max: 20 },
  ];

  for (const field of numericFields) {
    if (obj[field.key] !== undefined) {
      const val = obj[field.key];
      if (typeof val !== "number" || !Number.isInteger(val)) {
        return err(`${field.key}: must be an integer`);
      }
      if (field.min !== undefined && val < field.min) {
        return err(`${field.key}: must be >= ${field.min}`);
      }
      if (field.max !== undefined && val > field.max) {
        return err(`${field.key}: must be <= ${field.max}`);
      }
      // biome-ignore lint: dynamic field assignment
      (result as Record<string, unknown>)[field.key] = val;
    }
  }

  if (obj.schedulerTimezone !== undefined) {
    if (typeof obj.schedulerTimezone !== "string") {
      return err("schedulerTimezone: must be a string");
    }
    result.schedulerTimezone = obj.schedulerTimezone;
  }

  if (obj.telegramAllowedUserIds !== undefined) {
    if (
      !Array.isArray(obj.telegramAllowedUserIds) ||
      !obj.telegramAllowedUserIds.every(
        (id) => typeof id === "number" && Number.isInteger(id),
      )
    ) {
      return err("telegramAllowedUserIds: must be an array of integers");
    }
    result.telegramAllowedUserIds = obj.telegramAllowedUserIds as number[];
  }

  if (obj.skillDirs !== undefined) {
    if (
      !Array.isArray(obj.skillDirs) ||
      !obj.skillDirs.every((d) => typeof d === "string")
    ) {
      return err("skillDirs: must be an array of strings");
    }
    result.skillDirs = obj.skillDirs as string[];
  }

  if (obj.skillConfig !== undefined) {
    if (
      typeof obj.skillConfig !== "object" ||
      obj.skillConfig === null ||
      Array.isArray(obj.skillConfig)
    ) {
      return err("skillConfig: must be an object");
    }
    for (const [key, val] of Object.entries(
      obj.skillConfig as Record<string, unknown>,
    )) {
      if (typeof val !== "object" || val === null || Array.isArray(val)) {
        return err(`skillConfig.${key}: must be an object`);
      }
    }
    result.skillConfig = obj.skillConfig as Record<
      string,
      Record<string, unknown>
    >;
  }

  return ok(result);
}

// --- Load ---

interface LoadConfigOptions {
  configPath?: string;
  quiet?: boolean;
  skipRequiredChecks?: boolean;
}

/** Config with relaxed required fields — returned when skipRequiredChecks is true. */
export type PartialCortexConfig = Omit<
  CortexConfig,
  "ingestApiKey" | "model"
> & {
  ingestApiKey?: string;
  model?: string;
};

export function loadConfig(
  options: LoadConfigOptions & { skipRequiredChecks: true },
): Result<PartialCortexConfig>;
export function loadConfig(options?: LoadConfigOptions): Result<CortexConfig>;
export function loadConfig(
  options?: LoadConfigOptions,
): Result<CortexConfig | PartialCortexConfig> {
  const configPath =
    options?.configPath ?? process.env.CORTEX_CONFIG_PATH ?? undefined;
  const quiet = options?.quiet ?? false;

  // Load file config via core
  const loaded = loadJsonConfig({
    name: "cortex",
    defaults: DEFAULTS as Record<string, unknown>,
    configPath,
  });

  if (!loaded.ok) return loaded;

  // Validate the merged config (catches type/range errors from file values)
  const validated = validateConfig(loaded.value.config);
  if (!validated.ok) return validated as Result<never>;

  if (!quiet) {
    if (loaded.value.source === "file") {
      log(`loaded config from ${loaded.value.path}`);
    } else {
      log(`no config at ${loaded.value.path}, using defaults`);
    }
  }

  // Merge: defaults <- validated file config <- env overrides
  const config: Omit<CortexConfig, "ingestApiKey" | "model"> &
    Partial<Pick<CortexConfig, "ingestApiKey" | "model">> & {
      extractionModel?: string;
    } = {
    ...DEFAULTS,
    ...validated.value,
  };

  // Env overrides
  if (process.env.CORTEX_PORT) {
    const portResult = parsePort(process.env.CORTEX_PORT, "CORTEX_PORT");
    if (!portResult.ok) return portResult as Result<never>;
    config.port = portResult.value;
  }
  if (process.env.CORTEX_HOST) {
    const hostResult = requireNonEmptyEnv(
      "CORTEX_HOST",
      process.env.CORTEX_HOST,
    );
    if (!hostResult.ok) return hostResult as Result<never>;
    config.host = hostResult.value;
  }
  if (process.env.CORTEX_INGEST_API_KEY) {
    const keyResult = requireNonEmptyEnv(
      "CORTEX_INGEST_API_KEY",
      process.env.CORTEX_INGEST_API_KEY,
    );
    if (!keyResult.ok) return keyResult as Result<never>;
    config.ingestApiKey = keyResult.value;
  }
  if (process.env.CORTEX_MODEL) {
    const modelResult = requireNonEmptyEnv(
      "CORTEX_MODEL",
      process.env.CORTEX_MODEL,
    );
    if (!modelResult.ok) return modelResult as Result<never>;
    config.model = modelResult.value;
  }
  if (process.env.CORTEX_TELEGRAM_BOT_TOKEN !== undefined) {
    const tokenResult = requireNonEmptyEnv(
      "CORTEX_TELEGRAM_BOT_TOKEN",
      process.env.CORTEX_TELEGRAM_BOT_TOKEN,
    );
    if (!tokenResult.ok) return tokenResult as Result<never>;
    config.telegramBotToken = tokenResult.value;
  }
  if (process.env.CORTEX_TELEGRAM_ALLOWED_USER_IDS !== undefined) {
    const userIdsResult = parseTelegramAllowedUserIdsEnv(
      "CORTEX_TELEGRAM_ALLOWED_USER_IDS",
      process.env.CORTEX_TELEGRAM_ALLOWED_USER_IDS,
    );
    if (!userIdsResult.ok) return userIdsResult as Result<never>;
    config.telegramAllowedUserIds = userIdsResult.value;
  }
  if (process.env.CORTEX_MAX_TOOL_ROUNDS) {
    const raw = process.env.CORTEX_MAX_TOOL_ROUNDS;
    const val = Number(raw);
    if (!Number.isInteger(val) || val < 1 || val > 20) {
      return err(
        `CORTEX_MAX_TOOL_ROUNDS: ${raw} is not valid (must be an integer 1-20)`,
      );
    }
    config.maxToolRounds = val;
  }

  // Path expansion (resolve ~ to home directory)
  if (config.systemPromptFile) {
    config.systemPromptFile = expandPath(config.systemPromptFile);
  }

  // Required field validation
  if (!options?.skipRequiredChecks) {
    if (!config.ingestApiKey) {
      return err(
        "ingestApiKey is required. Set it in config.json or via CORTEX_INGEST_API_KEY env var.",
      );
    }
    if (!config.model) {
      return err(
        "model is required. Set it in config.json or via CORTEX_MODEL env var.",
      );
    }
  }

  return ok(config as CortexConfig);
}
