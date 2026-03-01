/**
 * Configuration loader for E2E tests.
 *
 * Loads config from mac-mini paths:
 * - Cortex config: ~/.config/cortex/config.json
 * - Wilson config: ~/.config/wilson/config.json
 * - Cortex DB: ~/.local/share/cortex/cortex.db
 * - Wilson DB: ~/.local/share/wilson/wilson.db
 * - .env file: e2e/.env
 */

import { homedir } from "os";
import { join } from "path";
import type { Config } from "./types";

function expandPath(path: string): string {
  if (path.startsWith("~")) {
    return join(homedir(), path.slice(1));
  }
  return path;
}

async function loadJsonFile<T>(path: string): Promise<T | null> {
  const file = Bun.file(expandPath(path));
  if (!file.size) return null;
  try {
    const text = await file.text();
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

interface CortexConfigFile {
  ingestApiKey?: string;
  synapseUrl?: string;
  engramUrl?: string;
}

interface WilsonConfigFile {
  channels?: {
    telegram?: {
      botToken?: string;
    };
  };
}

export async function loadConfig(): Promise<Config> {
  const cortexConfigPath = "~/.config/cortex/config.json";
  const wilsonConfigPath = "~/.config/wilson/config.json";
  const cortexDbPath = "~/.local/share/cortex/cortex.db";
  const wilsonDbPath = "~/.local/share/wilson/wilson.db";

  // Load cortex config
  const cortexConfig = await loadJsonFile<CortexConfigFile>(cortexConfigPath);
  if (!cortexConfig) {
    throw new Error(`Failed to load cortex config from ${cortexConfigPath}`);
  }

  // Load wilson config (optional - only needed for telegram tests)
  const wilsonConfig = await loadJsonFile<WilsonConfigFile>(wilsonConfigPath);

  // Load .env file
  const envPath = join(import.meta.dir, "../.env");
  const envFile = Bun.file(envPath);
  const envVars: Record<string, string> = {};
  if (envFile.size) {
    const content = await envFile.text();
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const [key, ...valueParts] = trimmed.split("=");
        if (key && valueParts.length > 0) {
          envVars[key.trim()] = valueParts.join("=").trim();
        }
      }
    }
  }

  const testUserId = envVars.TEST_USER_ID;
  const testSupergroupId = envVars.TEST_SUPERGROUP_ID;

  const apiKey = cortexConfig.ingestApiKey;
  if (!apiKey) {
    throw new Error("ingestApiKey not found in cortex config");
  }

  // Engram URL from cortex config or default
  const engramUrl = cortexConfig.engramUrl ?? "http://localhost:7752";

  // Telegram config is optional - only include if all values present
  const botToken = wilsonConfig?.channels?.telegram?.botToken;
  const telegram =
    botToken && testUserId && testSupergroupId
      ? { botToken, testUserId, testSupergroupId }
      : undefined;

  return {
    cortex: {
      url: "http://localhost:7751",
      apiKey,
    },
    engramUrl,
    telegram,
    db: {
      cortexPath: expandPath(cortexDbPath),
      wilsonPath: expandPath(wilsonDbPath),
    },
    timeouts: {
      llmResponse: 180000,
      delivery: 180000,
    },
  };
}

let _config: Config | null = null;

export async function getConfig(): Promise<Config> {
  if (!_config) {
    _config = await loadConfig();
  }
  return _config;
}
