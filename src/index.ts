/**
 * Cortex — Channel-agnostic life assistant runtime.
 *
 * Entry point. Loads config, initializes the database,
 * loads skills, starts the HTTP server, and runs the processing loop.
 */

import { createLogger } from "@shetty4l/core/log";
import { ok } from "@shetty4l/core/result";
import { onShutdown } from "@shetty4l/core/signals";
import { ChannelRegistry } from "./channels";
import { SilentChannel } from "./channels/silent";
import type { CortexConfig } from "./config";
import { loadConfig } from "./config";
import { getDatabase, initDatabase } from "./db";
import { initDebugLogger } from "./debug-logger";
import { Hippocampus } from "./hippocampus";
import { startProcessingLoop } from "./loop";
import { RAS } from "./ras";
import { startServer } from "./server";
import { createEmptyRegistry, loadSkills, type SkillRegistry } from "./skills";
import { StateLoader } from "./state";
import { Thalamus } from "./thalamus";
import { Tick } from "./tick";
import { type BuiltinToolContext, createCombinedRegistry } from "./tools";
import { createSendMessageTool } from "./tools/send-message";
import { createTaskTools } from "./tools/tasks";
import { VERSION } from "./version";

const log = createLogger("cortex");

interface RuntimeDeps {
  startServer: typeof startServer;
  startProcessingLoop: typeof startProcessingLoop;
  createChannelRegistry: (
    config: CortexConfig,
    thalamus?: Thalamus,
  ) => ChannelRegistry;
  log: (message: string) => void;
}

function defaultCreateChannelRegistry(
  _config: CortexConfig,
  _thalamus?: Thalamus,
): ChannelRegistry {
  const registry = new ChannelRegistry();
  registry.register(new SilentChannel());
  return registry;
}

const DEFAULT_RUNTIME_DEPS: RuntimeDeps = {
  startServer,
  startProcessingLoop,
  createChannelRegistry: defaultCreateChannelRegistry,
  log,
};

export interface CortexRuntime {
  stop(): Promise<void>;
}

export async function startCortexRuntime(
  config: CortexConfig,
  registry: SkillRegistry,
  stateLoader: StateLoader,
  deps: RuntimeDeps = DEFAULT_RUNTIME_DEPS,
): Promise<CortexRuntime> {
  const thalamus = new Thalamus({
    synapseUrl: config.synapseUrl,
    thalamusModels: config.thalamusModels,
    synapseTimeoutMs: config.synapseTimeoutMs,
    syncIntervalMs: config.thalamusSyncIntervalMs,
  });

  // Set stateLoader for thalamus to persist sync timestamps
  thalamus.setStateLoader(stateLoader);

  const server = deps.startServer(config, thalamus);
  deps.log(`listening on http://${config.host}:${config.port}`);

  // Create channel registry (needed by built-in tools)
  const channels = deps.createChannelRegistry(config, thalamus);

  // Create built-in tools with mutable per-message context
  const builtinCtx: BuiltinToolContext = { topicKey: "" };
  const builtinTools = [createSendMessageTool(channels), ...createTaskTools()];
  const combinedRegistry = createCombinedRegistry(
    builtinTools,
    registry,
    () => builtinCtx,
  );

  const loop = deps.startProcessingLoop(config, combinedRegistry, {
    builtinContext: builtinCtx,
    stateLoader,
  });
  deps.log("processing loop started");

  await channels.startAll();

  await thalamus.start();

  const tick = new Tick();
  const hippocampus = new Hippocampus();
  const ras = new RAS();

  return {
    async stop() {
      await ras.stop();
      await hippocampus.stop();
      await tick.stop();
      await thalamus.stop();
      await channels.stopAll();
      await loop.stop();
      server.stop();
      await stateLoader.flush();
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

  // Initialize debug logger (must happen before any processing)
  initDebugLogger({
    debugPipeline: config.debugPipeline,
    debugPrompt: config.debugPrompt,
  });

  const dbResult = initDatabase();
  if (!dbResult.ok) {
    log(dbResult.error);
    process.exit(1);
  }

  // Initialize state loader for persisted state classes
  const stateLoader = new StateLoader(getDatabase());

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

  const runtime = await startCortexRuntime(config, registry, stateLoader);
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
