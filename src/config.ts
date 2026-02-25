/**
 * Configuration for Cortex.
 *
 * Load order:
 *   1. Defaults (hardcoded)
 *   2. Config file (~/.config/cortex/config.json)
 *   3. Environment variables (CORTEX_PORT, CORTEX_HOST, CORTEX_MODELS, CORTEX_CONFIG_PATH, CORTEX_INGEST_API_KEY, CORTEX_MAX_TOOL_ROUNDS)
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
  models: string[];
  extractionModels?: string[];

  // History
  activeWindowSize: number;
  extractionInterval: number;
  turnTtlDays: number;

  // Scheduler
  schedulerTickSeconds: number;
  schedulerTimezone: string;

  // Outbox
  outboxPollDefaultBatch: number;
  outboxLeaseSeconds: number;
  outboxMaxAttempts: number;

  // Inbox
  inboxMaxAttempts: number;

  // System prompt
  systemPromptFile?: string;

  // Skills
  skillDirs: string[];
  skillConfig: Record<string, Record<string, unknown>>;
  toolTimeoutMs: number;
  maxToolRounds: number;

  // Synapse
  synapseTimeoutMs: number;

  // Thalamus
  thalamusModels: string[];
  thalamusSyncIntervalMs: number;

  // Output routing
  silentChannelAlias?: string;

  // Debug logging
  debugPipeline?: boolean;
  debugPrompt?: boolean;

  // Wilson (external tool provider)
  wilson?: {
    url: string;
    apiKey?: string;
  };
}

// --- Defaults ---

const DEFAULTS: Omit<
  CortexConfig,
  "ingestApiKey" | "models" | "extractionModels" | "wilson"
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
  outboxPollDefaultBatch: 20,
  outboxLeaseSeconds: 60,
  outboxMaxAttempts: 10,
  inboxMaxAttempts: 5,
  skillDirs: [],
  skillConfig: {},
  toolTimeoutMs: 20000,
  maxToolRounds: 8,
  synapseTimeoutMs: 60_000,
  thalamusModels: ["gpt-oss:20b"],
  thalamusSyncIntervalMs: 21_600_000,
};

// --- Validation ---

function requireNonEmptyEnv(envName: string, value: string): Result<string> {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return err(`${envName}: must be a non-empty string`);
  }
  return ok(trimmed);
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
    { key: "systemPromptFile", label: "systemPromptFile" },
    { key: "silentChannelAlias", label: "silentChannelAlias" },
  ];

  for (const field of stringFields) {
    if (obj[field.key] !== undefined) {
      if (typeof obj[field.key] !== "string") {
        return err(`${field.label}: must be a non-empty string`);
      }

      const value = obj[field.key] as string;
      if (value.length === 0) {
        return err(`${field.label}: must be a non-empty string`);
      }
      // biome-ignore lint: dynamic field assignment
      (result as Record<string, unknown>)[field.key] = value;
    }
  }

  // Model array fields — non-empty array of non-empty strings
  const modelArrayFields: Array<{
    key: keyof CortexConfig;
    label: string;
    required: boolean;
  }> = [
    { key: "models", label: "models", required: true },
    { key: "extractionModels", label: "extractionModels", required: false },
    { key: "thalamusModels", label: "thalamusModels", required: false },
  ];

  for (const field of modelArrayFields) {
    if (obj[field.key] !== undefined) {
      const val = obj[field.key];
      if (!Array.isArray(val)) {
        return err(`${field.label}: must be an array of strings`);
      }
      if (val.length === 0) {
        return err(`${field.label}: must be a non-empty array`);
      }
      for (let i = 0; i < val.length; i++) {
        if (typeof val[i] !== "string" || (val[i] as string).length === 0) {
          return err(`${field.label}[${i}]: must be a non-empty string`);
        }
      }
      // biome-ignore lint: dynamic field assignment
      (result as Record<string, unknown>)[field.key] = val;
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
    { key: "inboxMaxAttempts", min: 1 },
    { key: "toolTimeoutMs", min: 1000 },
    { key: "maxToolRounds", min: 1, max: 20 },
    { key: "synapseTimeoutMs", min: 5_000 },
    { key: "thalamusSyncIntervalMs", min: 60_000 },
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

  // Boolean fields
  const booleanFields: Array<keyof CortexConfig> = [
    "debugPipeline",
    "debugPrompt",
  ];

  for (const field of booleanFields) {
    if (obj[field] !== undefined) {
      if (typeof obj[field] !== "boolean") {
        return err(`${field}: must be a boolean`);
      }
      // biome-ignore lint: dynamic field assignment
      (result as Record<string, unknown>)[field] = obj[field];
    }
  }

  // Wilson config (optional)
  if (obj.wilson !== undefined) {
    if (
      typeof obj.wilson !== "object" ||
      obj.wilson === null ||
      Array.isArray(obj.wilson)
    ) {
      return err("wilson: must be an object");
    }
    const wilson = obj.wilson as Record<string, unknown>;

    // wilson.url is required if wilson is present
    if (wilson.url === undefined) {
      return err("wilson.url: is required when wilson config is present");
    }
    if (typeof wilson.url !== "string" || wilson.url.length === 0) {
      return err("wilson.url: must be a non-empty string");
    }
    // Validate URL format
    try {
      new URL(wilson.url);
    } catch {
      return err(`wilson.url: "${wilson.url}" is not a valid URL`);
    }

    // wilson.apiKey is optional
    if (wilson.apiKey !== undefined) {
      if (typeof wilson.apiKey !== "string" || wilson.apiKey.length === 0) {
        return err("wilson.apiKey: must be a non-empty string if provided");
      }
    }

    result.wilson = {
      url: wilson.url,
      ...(wilson.apiKey !== undefined && { apiKey: wilson.apiKey as string }),
    };
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
  "ingestApiKey" | "models"
> & {
  ingestApiKey?: string;
  models?: string[];
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
  const config: Omit<CortexConfig, "ingestApiKey" | "models"> &
    Partial<Pick<CortexConfig, "ingestApiKey" | "models">> & {
      extractionModels?: string[];
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
  if (process.env.CORTEX_MODELS) {
    const raw = process.env.CORTEX_MODELS.trim();
    if (raw.length === 0) {
      return err("CORTEX_MODELS: must be a non-empty comma-separated list");
    }
    const models = raw.split(",").map((m) => m.trim());
    for (let i = 0; i < models.length; i++) {
      if (models[i].length === 0) {
        return err(`CORTEX_MODELS: entry ${i} is empty`);
      }
    }
    config.models = models;
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

  // Debug logging env overrides (env overrides config)
  if (process.env.CORTEX_DEBUG_PIPELINE !== undefined) {
    config.debugPipeline = process.env.CORTEX_DEBUG_PIPELINE === "1";
  }
  if (process.env.CORTEX_DEBUG_PROMPT !== undefined) {
    config.debugPrompt = process.env.CORTEX_DEBUG_PROMPT === "1";
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
    if (!config.models || config.models.length === 0) {
      return err(
        "models is required. Set it in config.json or via CORTEX_MODELS env var.",
      );
    }
  }

  return ok(config as CortexConfig);
}
