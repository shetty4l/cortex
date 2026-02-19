/**
 * Runtime skill loader for Cortex.
 *
 * Discovers and loads skill packages from trusted local directories at startup.
 * Each skill is a subdirectory containing a skill.json manifest and a main.ts
 * entry point that default-exports a SkillModule.
 *
 * Design:
 * - Startup-load only (no hot-reload)
 * - One level of subdirectories per skill dir
 * - Tools are namespaced: "skillId.toolName"
 * - Fails startup on invalid API version or duplicate tool names
 * - Registry is immutable after construction
 */

import type { Result } from "@shetty4l/core/result";
import { err, ok } from "@shetty4l/core/result";
import { existsSync, readdirSync } from "fs";
import { join } from "path";

// --- Constants ---

/** Current runtime API version. Skills must declare this to load. */
export const CURRENT_RUNTIME_API_VERSION = "1";

// --- Types ---

/** Skill manifest loaded from skill.json. */
export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  runtimeApiVersion: string;
  main: string;
}

/** Tool definition exposed to the LLM via the Synapse tools parameter. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  mutatesState: boolean;
}

/** Runtime context passed to skill tool execution. */
export interface SkillRuntimeContext {
  nowIso: string;
  config: Record<string, unknown>;
  db: { query: Function; run: Function };
  http: { fetch: typeof fetch };
}

/** Tool call request passed to skill execution. */
export interface SkillToolCall {
  name: string;
  argumentsJson: string;
}

/** Tool execution result. */
export interface SkillToolResult {
  content: string;
  metadata?: Record<string, unknown>;
}

/** Contract that skill main.ts must default-export. */
export interface SkillModule {
  listTools(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    mutatesState?: boolean;
  }>;
  execute(
    call: SkillToolCall,
    ctx: SkillRuntimeContext,
  ): Promise<SkillToolResult>;
}

/** Immutable skill registry created at startup. */
export interface SkillRegistry {
  readonly tools: ReadonlyArray<ToolDefinition>;
  executeTool(
    name: string,
    argumentsJson: string,
    ctx: SkillRuntimeContext,
  ): Promise<Result<SkillToolResult>>;
  isMutating(name: string): boolean;
}

// --- Registry construction ---

interface ToolEntry {
  module: SkillModule;
  def: ToolDefinition;
  config: Record<string, unknown>;
}

function createRegistry(toolMap: Map<string, ToolEntry>): SkillRegistry {
  const tools = Array.from(toolMap.values()).map((e) => e.def);

  return {
    tools,

    async executeTool(
      name: string,
      argumentsJson: string,
      ctx: SkillRuntimeContext,
    ): Promise<Result<SkillToolResult>> {
      const entry = toolMap.get(name);
      if (!entry) return err(`unknown tool: ${name}`);

      // Inject per-skill config into the context
      const skillCtx: SkillRuntimeContext = { ...ctx, config: entry.config };

      try {
        const result = await entry.module.execute(
          { name, argumentsJson },
          skillCtx,
        );
        return ok(result);
      } catch (e) {
        return err(
          `tool ${name} threw: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },

    isMutating(name: string): boolean {
      return toolMap.get(name)?.def.mutatesState ?? false;
    },
  };
}

/** Create an empty registry for when no skill dirs are configured. */
export function createEmptyRegistry(): SkillRegistry {
  return createRegistry(new Map());
}

// --- Manifest validation ---

function validateManifest(
  raw: unknown,
  skillPath: string,
): Result<SkillManifest> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return err(`invalid skill.json in ${skillPath}: must be a JSON object`);
  }

  const obj = raw as Record<string, unknown>;
  const required = ["id", "name", "version", "runtimeApiVersion", "main"];

  for (const field of required) {
    if (typeof obj[field] !== "string" || (obj[field] as string).length === 0) {
      return err(
        `invalid skill.json in ${skillPath}: "${field}" must be a non-empty string`,
      );
    }
  }

  return ok(obj as unknown as SkillManifest);
}

// --- Loader ---

/**
 * Load skills from configured directories and build the tool registry.
 *
 * Each directory is expected to contain subdirectories, one per skill,
 * each with a skill.json manifest and a main entry point.
 *
 * Returns Err on:
 * - Skill directory does not exist
 * - Manifest is missing, invalid, or missing required fields
 * - runtimeApiVersion mismatch
 * - Module doesn't export the required SkillModule interface
 * - Duplicate fully-qualified tool names
 */
export async function loadSkills(
  skillDirs: string[],
  skillConfig: Record<string, Record<string, unknown>> = {},
): Promise<Result<SkillRegistry>> {
  const toolMap = new Map<string, ToolEntry>();

  for (const dir of skillDirs) {
    if (!existsSync(dir)) {
      return err(`skill directory does not exist: ${dir}`);
    }

    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillPath = join(dir, entry.name);
      const result = await loadSingleSkill(skillPath, skillConfig, toolMap);
      if (!result.ok) return result;
    }
  }

  return ok(createRegistry(toolMap));
}

/**
 * Load a single skill from a directory. Registers its tools into toolMap.
 */
async function loadSingleSkill(
  skillPath: string,
  skillConfig: Record<string, Record<string, unknown>>,
  toolMap: Map<string, ToolEntry>,
): Promise<Result<void>> {
  // Load manifest
  const manifestPath = join(skillPath, "skill.json");
  const manifestFile = Bun.file(manifestPath);

  if (!(await manifestFile.exists())) {
    return err(`missing skill.json in ${skillPath}`);
  }

  let rawManifest: unknown;
  try {
    rawManifest = await manifestFile.json();
  } catch (e) {
    return err(
      `invalid skill.json in ${skillPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const validated = validateManifest(rawManifest, skillPath);
  if (!validated.ok) return validated as Result<never>;
  const manifest = validated.value;

  // Check API version
  if (manifest.runtimeApiVersion !== CURRENT_RUNTIME_API_VERSION) {
    return err(
      `skill ${manifest.id}: unsupported runtimeApiVersion "${manifest.runtimeApiVersion}" (expected "${CURRENT_RUNTIME_API_VERSION}")`,
    );
  }

  // Load module via dynamic import
  const modulePath = join(skillPath, manifest.main);
  let mod: SkillModule;
  try {
    const imported = await import(modulePath);
    mod = imported.default;
  } catch (e) {
    return err(
      `skill ${manifest.id}: failed to load ${manifest.main}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Validate module interface
  if (
    !mod ||
    typeof mod.listTools !== "function" ||
    typeof mod.execute !== "function"
  ) {
    return err(
      `skill ${manifest.id}: module must default-export { listTools(), execute() }`,
    );
  }

  // Get tool definitions
  let rawTools: ReturnType<SkillModule["listTools"]>;
  try {
    rawTools = mod.listTools();
  } catch (e) {
    return err(
      `skill ${manifest.id}: listTools() threw: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Namespace and register tools
  const perSkillConfig = skillConfig[manifest.id] ?? {};
  for (const tool of rawTools) {
    const qualifiedName = `${manifest.id}.${tool.name}`;
    if (toolMap.has(qualifiedName)) {
      return err(`duplicate tool name: ${qualifiedName}`);
    }

    toolMap.set(qualifiedName, {
      module: mod,
      def: {
        name: qualifiedName,
        description: tool.description,
        inputSchema: tool.inputSchema,
        mutatesState: tool.mutatesState ?? false,
      },
      config: perSkillConfig,
    });
  }

  console.error(
    `cortex: loaded skill ${manifest.id} v${manifest.version} (${rawTools.length} tools)`,
  );

  return ok(undefined);
}
