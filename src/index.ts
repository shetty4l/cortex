/**
 * Cortex — Channel-agnostic life assistant runtime.
 *
 * Entry point. Loads config, initializes the database,
 * loads skills, starts the HTTP server, and runs the processing loop.
 */

import { createLogger } from "@shetty4l/core/log";
import { ok } from "@shetty4l/core/result";
import { onShutdown } from "@shetty4l/core/signals";
import { Cerebellum } from "./cerebellum";
import { ChannelRegistry } from "./channels";
import { SilentChannel } from "./channels/silent";
import type { CortexConfig } from "./config";
import { loadConfig } from "./config";
import {
  type ConnectionPool,
  createConnectionPool,
  getDatabase,
  initDatabase,
} from "./db";
import { initDebugLogger } from "./debug-logger";
import { Hippocampus } from "./hippocampus";
import { type EnqueueInboxInput, enqueueInboxMessage } from "./inbox";
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
import { createTopicTools } from "./tools/topics";
import { VERSION } from "./version";

const log = createLogger("cortex");

interface RuntimeDeps {
  startServer: (
    config: CortexConfig,
    thalamus?: Thalamus,
    stateLoader?: StateLoader,
  ) => ReturnType<typeof startServer>;
  startProcessingLoop: typeof startProcessingLoop;
  createChannelRegistry: (
    config: CortexConfig,
    thalamus?: Thalamus,
    channelLoader?: StateLoader,
  ) => ChannelRegistry;
  log: (message: string) => void;
}

function defaultCreateChannelRegistry(
  _config: CortexConfig,
  _thalamus?: Thalamus,
  channelLoader?: StateLoader,
): ChannelRegistry {
  const registry = new ChannelRegistry();
  const silentChannel = new SilentChannel();
  if (channelLoader) {
    silentChannel.init(channelLoader);
  }
  registry.register(silentChannel);
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

export interface StartCortexRuntimeOptions {
  /** Optional separate loader for channels to avoid transaction conflicts. */
  channelLoader?: StateLoader;
  /** Optional connection pool for cleanup. */
  pool?: ConnectionPool;
}

export async function startCortexRuntime(
  config: CortexConfig,
  registry: SkillRegistry,
  stateLoader: StateLoader,
  deps: RuntimeDeps = DEFAULT_RUNTIME_DEPS,
  options?: StartCortexRuntimeOptions,
): Promise<CortexRuntime> {
  // Use separate channelLoader if provided, otherwise fall back to main stateLoader
  const channelLoader = options?.channelLoader ?? stateLoader;
  const pool = options?.pool;

  const thalamus = new Thalamus({
    synapseUrl: config.synapseUrl,
    thalamusModels: config.thalamusModels,
    synapseTimeoutMs: config.synapseTimeoutMs,
    syncIntervalMs: config.thalamusSyncIntervalMs,
    stateLoader,
  });

  const server = deps.startServer(config, thalamus, stateLoader);
  deps.log(`listening on http://${config.host}:${config.port}`);

  // Create channel registry with separate channelLoader to avoid transaction conflicts
  const channels = deps.createChannelRegistry(config, thalamus, channelLoader);

  // Create built-in tools with mutable per-message context
  const builtinCtx: BuiltinToolContext = { topicKey: "" };
  const builtinTools = [
    createSendMessageTool(channels, stateLoader),
    ...createTaskTools(stateLoader),
    ...createTopicTools(stateLoader),
  ];
  const combinedRegistry = createCombinedRegistry(
    builtinTools,
    registry,
    () => builtinCtx,
    { stateLoader },
  );

  const loop = deps.startProcessingLoop(config, combinedRegistry, {
    builtinContext: builtinCtx,
    stateLoader,
  });
  deps.log("processing loop started");

  await channels.startAll();

  await thalamus.start();

  const tick = new Tick();
  tick.init({
    config,
    enqueueInboxMessage: (input: EnqueueInboxInput) =>
      enqueueInboxMessage(stateLoader, input),
    stateLoader,
  });
  await tick.start();

  const hippocampus = new Hippocampus();
  const ras = new RAS();

  const cerebellum = new Cerebellum(config.cerebellum, stateLoader);
  cerebellum.start();

  return {
    async stop() {
      await ras.stop();
      await hippocampus.stop();
      cerebellum.stop();
      await tick.stop();
      await thalamus.stop();
      await channels.stopAll();
      await loop.stop();
      server.stop();
      await stateLoader.flush();
      await channelLoader.flush();
      pool?.closeAll();
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

  try {
    initDatabase();
  } catch (e) {
    log(
      `Failed to initialize database: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }

  // Create connection pool for concurrent transaction support
  // Use the same db path that initDatabase() uses
  const dbPath = getDatabase().filename;
  const pool = createConnectionPool(dbPath);
  const mainLoader = pool.getLoader("main");
  const channelLoader = pool.getLoader("channels");

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

  const runtime = await startCortexRuntime(
    config,
    registry,
    mainLoader,
    DEFAULT_RUNTIME_DEPS,
    { channelLoader, pool },
  );
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
