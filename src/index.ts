/**
 * Cortex — Channel-agnostic life assistant runtime.
 *
 * Entry point. Loads config, initializes the database,
 * loads skills, starts the HTTP server, and runs the processing loop.
 */

import { createLogger } from "@shetty4l/core/log";
import { ok } from "@shetty4l/core/result";
import { onShutdown } from "@shetty4l/core/signals";
import { TelegramChannel } from "./channels/telegram";
import type { CortexConfig } from "./config";
import { loadConfig } from "./config";
import { initDatabase } from "./db";
import { startProcessingLoop } from "./loop";
import { startServer } from "./server";
import { createEmptyRegistry, loadSkills, type SkillRegistry } from "./skills";
import { VERSION } from "./version";

const log = createLogger("cortex");

interface RuntimeDeps {
  startServer: typeof startServer;
  startProcessingLoop: typeof startProcessingLoop;
  createTelegramChannel: (config: CortexConfig) => TelegramChannel | null;
  log: (message: string) => void;
}

function defaultCreateTelegramChannel(
  config: CortexConfig,
): TelegramChannel | null {
  if (!config.telegramBotToken) return null;
  return new TelegramChannel(config);
}

const DEFAULT_RUNTIME_DEPS: RuntimeDeps = {
  startServer,
  startProcessingLoop,
  createTelegramChannel: defaultCreateTelegramChannel,
  log,
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
  deps.log(`listening on http://${config.host}:${config.port}`);

  const loop = deps.startProcessingLoop(config, registry);
  deps.log("processing loop started");

  const telegramChannel = deps.createTelegramChannel(config);

  if (telegramChannel) {
    const allowedIds = config.telegramAllowedUserIds ?? [];
    if (allowedIds.length === 0) {
      deps.log(
        "telegram channel enabled with empty allowedUserIds — all messages will be rejected",
      );
    }
    try {
      await telegramChannel.start();
      if (allowedIds.length > 0) {
        deps.log("telegram channel enabled (ingestion+delivery started)");
      }
    } catch (startupError) {
      const cleanupErrors: unknown[] = [];

      try {
        await telegramChannel.stop();
      } catch (error) {
        cleanupErrors.push(error);
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
        const details = cleanupErrors
          .map((e) => (e instanceof Error ? e.message : String(e)))
          .join("; ");
        deps.log(
          `startup cleanup encountered ${cleanupErrors.length} errors: ${details}`,
        );
      }

      throw startupError;
    }
  } else {
    deps.log("telegram channel disabled (no token configured)");
  }

  return {
    async stop() {
      if (telegramChannel) {
        await telegramChannel.stop();
      }
      await loop.stop();
      server.stop();
    },
  };
}

export async function run(): Promise<void> {
  log(`v${VERSION}`);

  const configResult = loadConfig();
  if (!configResult.ok) {
    log(configResult.error);
    process.exit(1);
  }
  const config = configResult.value;

  const dbResult = initDatabase();
  if (!dbResult.ok) {
    log(dbResult.error);
    process.exit(1);
  }

  const registryResult =
    config.skillDirs.length > 0
      ? await loadSkills(config.skillDirs, config.skillConfig)
      : ok(createEmptyRegistry());

  if (!registryResult.ok) {
    log(`fatal: ${registryResult.error}`);
    process.exit(1);
  }

  const registry = registryResult.value;
  log(
    `loaded ${registry.tools.length} tools from ${config.skillDirs.length} skill dirs`,
  );

  const runtime = await startCortexRuntime(config, registry);
  onShutdown(
    async () => {
      log("shutting down...");
      await runtime.stop();
      log("shutdown complete");
    },
    { name: "cortex", timeoutMs: 35_000 },
  );
}

if (import.meta.main) {
  await run();
}
