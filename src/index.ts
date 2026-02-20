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
import type { CortexConfig } from "./config";
import { loadConfig } from "./config";
import { initDatabase } from "./db";
import { startProcessingLoop } from "./loop";
import { startServer } from "./server";
import { createEmptyRegistry, loadSkills, type SkillRegistry } from "./skills";
import {
  startTelegramDeliveryLoop,
  startTelegramIngestionLoop,
  type TelegramDeliveryLoop,
  type TelegramIngestionLoop,
} from "./telegram";

const VERSION = readVersion(join(import.meta.dir, ".."));

interface RuntimeDeps {
  startServer: typeof startServer;
  startProcessingLoop: typeof startProcessingLoop;
  startTelegramIngestionLoop: typeof startTelegramIngestionLoop;
  startTelegramDeliveryLoop: typeof startTelegramDeliveryLoop;
  log: (message: string) => void;
}

const DEFAULT_RUNTIME_DEPS: RuntimeDeps = {
  startServer,
  startProcessingLoop,
  startTelegramIngestionLoop,
  startTelegramDeliveryLoop,
  log: console.error,
};

export interface CortexRuntime {
  stop(): Promise<void>;
}

export async function startCortexRuntime(
  config: CortexConfig,
  registry: SkillRegistry,
  deps: RuntimeDeps = DEFAULT_RUNTIME_DEPS,
): Promise<CortexRuntime> {
  const server = deps.startServer(config);
  deps.log(`cortex: listening on http://${config.host}:${config.port}`);

  const loop = deps.startProcessingLoop(config, registry);
  deps.log("cortex: processing loop started");

  let telegramIngestion: TelegramIngestionLoop | null = null;
  let telegramDelivery: TelegramDeliveryLoop | null = null;

  if (config.telegramBotToken) {
    try {
      telegramIngestion = deps.startTelegramIngestionLoop(config);
      telegramDelivery = deps.startTelegramDeliveryLoop(config);
      deps.log("cortex: telegram adapter enabled (ingestion+delivery started)");
    } catch (startupError) {
      const cleanupErrors: unknown[] = [];

      if (telegramDelivery) {
        try {
          await telegramDelivery.stop();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }

      if (telegramIngestion) {
        try {
          await telegramIngestion.stop();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }

      try {
        await loop.stop();
      } catch (error) {
        cleanupErrors.push(error);
      }

      try {
        server.stop();
      } catch (error) {
        cleanupErrors.push(error);
      }

      if (cleanupErrors.length > 0) {
        deps.log(
          `cortex: startup cleanup encountered ${cleanupErrors.length} errors`,
        );
      }

      throw startupError;
    }
  } else {
    deps.log("cortex: telegram adapter disabled (no token configured)");
  }

  return {
    async stop() {
      if (telegramDelivery) {
        await telegramDelivery.stop();
      }
      if (telegramIngestion) {
        await telegramIngestion.stop();
      }
      await loop.stop();
      server.stop();
    },
  };
}

export async function run(): Promise<void> {
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

  const registryResult =
    config.skillDirs.length > 0
      ? await loadSkills(config.skillDirs, config.skillConfig)
      : ok(createEmptyRegistry());

  if (!registryResult.ok) {
    console.error(`cortex: fatal: ${registryResult.error}`);
    process.exit(1);
  }

  const registry = registryResult.value;
  console.error(
    `cortex: loaded ${registry.tools.length} tools from ${config.skillDirs.length} skill dirs`,
  );

  const runtime = await startCortexRuntime(config, registry);
  onShutdown(
    async () => {
      await runtime.stop();
    },
    { name: "cortex", timeoutMs: 35_000 },
  );
}

if (import.meta.main) {
  await run();
}
