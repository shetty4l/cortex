/**
 * Configuration for Cortex.
 *
 * Load order:
 *   1. Defaults (hardcoded)
 *   2. Config file (~/.config/cortex/config.json)
 *   3. Environment variables (CORTEX_PORT, CORTEX_HOST, CORTEX_MODEL, CORTEX_CONFIG_PATH, CORTEX_INGEST_API_KEY)
 *
 * String values in the config file support ${ENV_VAR} interpolation.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

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

  // Outbox
  outboxPollDefaultBatch: number;
  outboxLeaseSeconds: number;
  outboxMaxAttempts: number;

  // Skills
  skillDirs: string[];
  toolTimeoutMs: number;
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
  outboxPollDefaultBatch: 20,
  outboxLeaseSeconds: 60,
  outboxMaxAttempts: 10,
  skillDirs: [],
  toolTimeoutMs: 20000,
};

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "cortex", "config.json");

// --- Port validation ---

function parsePort(value: string, source: string): number {
  const port = Number.parseInt(value, 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new Error(
      `${source}: "${value}" is not a valid port number (must be 1-65535)`,
    );
  }
  return port;
}

// --- Env var interpolation ---

export function interpolateEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new Error(
        `Config references \${${varName}} but it is not set in the environment`,
      );
    }
    return envValue;
  });
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function interpolateDeep(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return interpolateEnvVars(value);
  }
  if (Array.isArray(value)) {
    return value.map(interpolateDeep);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = interpolateDeep(v);
    }
    return result;
  }
  return value;
}

// --- Validation ---

function validateConfig(raw: unknown): Partial<CortexConfig> {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Config must be a JSON object");
  }

  const obj = raw as Record<string, unknown>;
  const result: Partial<CortexConfig> = {};

  if (obj.host !== undefined) {
    if (typeof obj.host !== "string" || obj.host.length === 0) {
      throw new Error("host: must be a non-empty string");
    }
    result.host = obj.host;
  }

  if (obj.port !== undefined) {
    if (
      typeof obj.port !== "number" ||
      !Number.isInteger(obj.port) ||
      obj.port < 1 ||
      obj.port > 65535
    ) {
      throw new Error(
        `port: ${obj.port} is not a valid port number (must be an integer 1-65535)`,
      );
    }
    result.port = obj.port;
  }

  if (obj.ingestApiKey !== undefined) {
    if (typeof obj.ingestApiKey !== "string") {
      throw new Error("ingestApiKey: must be a string");
    }
    result.ingestApiKey = obj.ingestApiKey;
  }

  if (obj.synapseUrl !== undefined) {
    if (typeof obj.synapseUrl !== "string" || obj.synapseUrl.length === 0) {
      throw new Error("synapseUrl: must be a non-empty string");
    }
    result.synapseUrl = obj.synapseUrl;
  }

  if (obj.engramUrl !== undefined) {
    if (typeof obj.engramUrl !== "string" || obj.engramUrl.length === 0) {
      throw new Error("engramUrl: must be a non-empty string");
    }
    result.engramUrl = obj.engramUrl;
  }

  if (obj.model !== undefined) {
    if (typeof obj.model !== "string" || obj.model.length === 0) {
      throw new Error("model: must be a non-empty string");
    }
    result.model = obj.model;
  }

  if (obj.extractionModel !== undefined) {
    if (typeof obj.extractionModel !== "string") {
      throw new Error("extractionModel: must be a string");
    }
    result.extractionModel = obj.extractionModel;
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
  ];

  for (const field of numericFields) {
    if (obj[field.key] !== undefined) {
      const val = obj[field.key];
      if (typeof val !== "number" || !Number.isInteger(val)) {
        throw new Error(`${field.key}: must be an integer`);
      }
      if (field.min !== undefined && val < field.min) {
        throw new Error(`${field.key}: must be >= ${field.min}`);
      }
      if (field.max !== undefined && val > field.max) {
        throw new Error(`${field.key}: must be <= ${field.max}`);
      }
      // biome-ignore lint: dynamic field assignment
      (result as Record<string, unknown>)[field.key] = val;
    }
  }

  if (obj.schedulerTimezone !== undefined) {
    if (typeof obj.schedulerTimezone !== "string") {
      throw new Error("schedulerTimezone: must be a string");
    }
    result.schedulerTimezone = obj.schedulerTimezone;
  }

  if (obj.skillDirs !== undefined) {
    if (
      !Array.isArray(obj.skillDirs) ||
      !obj.skillDirs.every((d) => typeof d === "string")
    ) {
      throw new Error("skillDirs: must be an array of strings");
    }
    result.skillDirs = obj.skillDirs as string[];
  }

  return result;
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
): PartialCortexConfig;
export function loadConfig(options?: LoadConfigOptions): CortexConfig;
export function loadConfig(
  options?: LoadConfigOptions,
): CortexConfig | PartialCortexConfig {
  const filePath =
    options?.configPath ??
    process.env.CORTEX_CONFIG_PATH ??
    DEFAULT_CONFIG_PATH;
  const quiet = options?.quiet ?? false;

  let fileConfig: Partial<CortexConfig> = {};

  if (existsSync(filePath)) {
    const rawText = readFileSync(filePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new Error(`Failed to parse config file ${filePath}: invalid JSON`);
    }

    const interpolated = interpolateDeep(parsed as JsonValue);
    fileConfig = validateConfig(interpolated);

    if (!quiet) {
      console.log(`cortex: loaded config from ${filePath}`);
    }
  } else if (!quiet) {
    console.log(`cortex: no config at ${filePath}, using defaults`);
  }

  // Merge: defaults <- file config <- env overrides
  // Use a partial type until required fields are validated below.
  const config: Omit<CortexConfig, "ingestApiKey" | "model"> &
    Partial<Pick<CortexConfig, "ingestApiKey" | "model">> & {
      extractionModel?: string;
    } = {
    ...DEFAULTS,
    ...fileConfig,
  };

  // Env overrides
  if (process.env.CORTEX_PORT) {
    config.port = parsePort(process.env.CORTEX_PORT, "CORTEX_PORT");
  }
  if (process.env.CORTEX_HOST) {
    config.host = process.env.CORTEX_HOST;
  }
  if (process.env.CORTEX_INGEST_API_KEY) {
    config.ingestApiKey = process.env.CORTEX_INGEST_API_KEY;
  }
  if (process.env.CORTEX_MODEL) {
    config.model = process.env.CORTEX_MODEL;
  }

  // Required field validation
  if (!options?.skipRequiredChecks) {
    if (!config.ingestApiKey) {
      throw new Error(
        "ingestApiKey is required. Set it in config.json or via CORTEX_INGEST_API_KEY env var.",
      );
    }
    if (!config.model) {
      throw new Error(
        "model is required. Set it in config.json or via CORTEX_MODEL env var.",
      );
    }
  }

  return config as CortexConfig;
}
