import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { loadConfig } from "../src/config";

describe("config", () => {
  const originalEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "CORTEX_PORT",
    "CORTEX_HOST",
    "CORTEX_CONFIG_PATH",
    "CORTEX_INGEST_API_KEY",
    "CORTEX_MODELS",
    "CORTEX_MAX_TOOL_ROUNDS",
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (originalEnv[key] !== undefined) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  test("returns defaults when no config file exists", () => {
    process.env.CORTEX_CONFIG_PATH = "/nonexistent/config.json";
    const result = loadConfig({ quiet: true, skipRequiredChecks: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const config = result.value;

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(7751);
    expect(config.synapseUrl).toBe("http://localhost:7750");
    expect(config.engramUrl).toBe("http://localhost:7749");
    expect(config.activeWindowSize).toBe(10);
    expect(config.extractionInterval).toBe(3);
    expect(config.turnTtlDays).toBe(30);
    expect(config.schedulerTickSeconds).toBe(30);
    expect(config.schedulerTimezone).toBe("UTC");
    expect(config.outboxPollDefaultBatch).toBe(20);
    expect(config.outboxLeaseSeconds).toBe(60);
    expect(config.outboxMaxAttempts).toBe(10);
    expect(config.skillDirs).toEqual([]);
    expect(config.toolTimeoutMs).toBe(20000);
    expect(config.maxToolRounds).toBe(8);
    expect(config.synapseTimeoutMs).toBe(60_000);
    expect(config.ingestApiKey).toBeUndefined();
    expect(config.models).toBeUndefined();
    expect(config.extractionModels).toBeUndefined();
  });

  test("loads config from file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    const configPath = join(tmpDir, "config.json");

    writeFileSync(
      configPath,
      JSON.stringify({
        port: 9999,
        host: "0.0.0.0",
        models: ["qwen2.5:14b"],
        skillDirs: ["/opt/skills"],
      }),
    );

    process.env.CORTEX_CONFIG_PATH = configPath;
    const result = loadConfig({ quiet: true, skipRequiredChecks: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const config = result.value;

    expect(config.port).toBe(9999);
    expect(config.host).toBe("0.0.0.0");
    expect(config.models).toEqual(["qwen2.5:14b"]);
    expect(config.skillDirs).toEqual(["/opt/skills"]);
    // Defaults preserved for unset fields
    expect(config.synapseUrl).toBe("http://localhost:7750");

    rmSync(tmpDir, { recursive: true });
  });

  test("env vars override file config", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    const configPath = join(tmpDir, "config.json");

    writeFileSync(
      configPath,
      JSON.stringify({ port: 9999, models: ["file-model"] }),
    );

    process.env.CORTEX_CONFIG_PATH = configPath;
    process.env.CORTEX_PORT = "8888";
    process.env.CORTEX_HOST = "0.0.0.0";
    process.env.CORTEX_INGEST_API_KEY = "test-key";
    process.env.CORTEX_MODELS = "env-model";

    const result = loadConfig({ quiet: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const config = result.value;

    expect(config.port).toBe(8888);
    expect(config.host).toBe("0.0.0.0");
    expect(config.ingestApiKey).toBe("test-key");
    expect(config.models).toEqual(["env-model"]);

    rmSync(tmpDir, { recursive: true });
  });

  test("interpolates ${ENV_VAR} in config file strings", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    const configPath = join(tmpDir, "config.json");

    process.env.MY_SYNAPSE_URL = "http://remote:7750";
    writeFileSync(
      configPath,
      JSON.stringify({ synapseUrl: "${MY_SYNAPSE_URL}" }),
    );

    process.env.CORTEX_CONFIG_PATH = configPath;
    const result = loadConfig({ quiet: true, skipRequiredChecks: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.synapseUrl).toBe("http://remote:7750");

    delete process.env.MY_SYNAPSE_URL;
    rmSync(tmpDir, { recursive: true });
  });

  test("returns error on invalid port in env var", () => {
    process.env.CORTEX_CONFIG_PATH = "/nonexistent/config.json";
    process.env.CORTEX_PORT = "99999";

    const result = loadConfig({ quiet: true, skipRequiredChecks: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not a valid port number");
  });

  test("returns error on invalid port in config file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    const configPath = join(tmpDir, "config.json");

    writeFileSync(configPath, JSON.stringify({ port: -1 }));
    process.env.CORTEX_CONFIG_PATH = configPath;

    const result = loadConfig({ quiet: true, skipRequiredChecks: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not a valid port number");

    rmSync(tmpDir, { recursive: true });
  });

  test("returns error on invalid JSON in config file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    const configPath = join(tmpDir, "config.json");

    writeFileSync(configPath, "not json");
    process.env.CORTEX_CONFIG_PATH = configPath;

    const result = loadConfig({ quiet: true, skipRequiredChecks: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("invalid JSON");

    rmSync(tmpDir, { recursive: true });
  });

  test("validates numeric field ranges", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    const configPath = join(tmpDir, "config.json");

    writeFileSync(configPath, JSON.stringify({ outboxLeaseSeconds: 5 }));
    process.env.CORTEX_CONFIG_PATH = configPath;

    const result = loadConfig({ quiet: true, skipRequiredChecks: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("must be >= 10");

    rmSync(tmpDir, { recursive: true });
  });

  test("returns error when ingestApiKey is missing", () => {
    process.env.CORTEX_CONFIG_PATH = "/nonexistent/config.json";

    const result = loadConfig({ quiet: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ingestApiKey is required");
  });

  test("returns error when model is missing", () => {
    process.env.CORTEX_CONFIG_PATH = "/nonexistent/config.json";
    process.env.CORTEX_INGEST_API_KEY = "test-key";

    const result = loadConfig({ quiet: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("models is required");
  });

  test("returns error on empty models array in config file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    const configPath = join(tmpDir, "config.json");

    writeFileSync(configPath, JSON.stringify({ models: [] }));
    process.env.CORTEX_CONFIG_PATH = configPath;

    const result = loadConfig({ quiet: true, skipRequiredChecks: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("models: must be a non-empty array");

    rmSync(tmpDir, { recursive: true });
  });

  // --- maxToolRounds tests ---

  test("loads custom maxToolRounds from config file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    const configPath = join(tmpDir, "config.json");

    writeFileSync(configPath, JSON.stringify({ maxToolRounds: 12 }));
    process.env.CORTEX_CONFIG_PATH = configPath;

    const result = loadConfig({ quiet: true, skipRequiredChecks: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.maxToolRounds).toBe(12);

    rmSync(tmpDir, { recursive: true });
  });

  test("CORTEX_MAX_TOOL_ROUNDS env var overrides config file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    const configPath = join(tmpDir, "config.json");

    writeFileSync(configPath, JSON.stringify({ maxToolRounds: 5 }));
    process.env.CORTEX_CONFIG_PATH = configPath;
    process.env.CORTEX_MAX_TOOL_ROUNDS = "15";

    const result = loadConfig({ quiet: true, skipRequiredChecks: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.maxToolRounds).toBe(15);

    rmSync(tmpDir, { recursive: true });
  });

  test("returns error when maxToolRounds is below minimum (1)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    const configPath = join(tmpDir, "config.json");

    writeFileSync(configPath, JSON.stringify({ maxToolRounds: 0 }));
    process.env.CORTEX_CONFIG_PATH = configPath;

    const result = loadConfig({ quiet: true, skipRequiredChecks: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("must be >= 1");

    rmSync(tmpDir, { recursive: true });
  });

  test("returns error when maxToolRounds exceeds maximum (20)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    const configPath = join(tmpDir, "config.json");

    writeFileSync(configPath, JSON.stringify({ maxToolRounds: 25 }));
    process.env.CORTEX_CONFIG_PATH = configPath;

    const result = loadConfig({ quiet: true, skipRequiredChecks: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("must be <= 20");

    rmSync(tmpDir, { recursive: true });
  });

  test("returns error when maxToolRounds is not an integer", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    const configPath = join(tmpDir, "config.json");

    writeFileSync(configPath, JSON.stringify({ maxToolRounds: 3.5 }));
    process.env.CORTEX_CONFIG_PATH = configPath;

    const result = loadConfig({ quiet: true, skipRequiredChecks: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("must be an integer");

    rmSync(tmpDir, { recursive: true });
  });

  test("returns error when CORTEX_MAX_TOOL_ROUNDS env var is invalid", () => {
    process.env.CORTEX_CONFIG_PATH = "/nonexistent/config.json";
    process.env.CORTEX_MAX_TOOL_ROUNDS = "abc";

    const result = loadConfig({ quiet: true, skipRequiredChecks: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("CORTEX_MAX_TOOL_ROUNDS");
  });

  // --- systemPromptFile tests ---

  test("synapseTimeoutMs defaults to 60_000", () => {
    process.env.CORTEX_CONFIG_PATH = "/nonexistent/config.json";
    const result = loadConfig({ quiet: true, skipRequiredChecks: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.synapseTimeoutMs).toBe(60_000);
  });

  test("loads custom synapseTimeoutMs from config file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    const configPath = join(tmpDir, "config.json");

    writeFileSync(configPath, JSON.stringify({ synapseTimeoutMs: 90_000 }));
    process.env.CORTEX_CONFIG_PATH = configPath;

    const result = loadConfig({ quiet: true, skipRequiredChecks: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.synapseTimeoutMs).toBe(90_000);

    rmSync(tmpDir, { recursive: true });
  });

  test("returns error when synapseTimeoutMs is below minimum (5_000)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    const configPath = join(tmpDir, "config.json");

    writeFileSync(configPath, JSON.stringify({ synapseTimeoutMs: 3_000 }));
    process.env.CORTEX_CONFIG_PATH = configPath;

    const result = loadConfig({ quiet: true, skipRequiredChecks: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("must be >= 5000");

    rmSync(tmpDir, { recursive: true });
  });

  test("returns error when synapseTimeoutMs is not an integer", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    const configPath = join(tmpDir, "config.json");

    writeFileSync(configPath, JSON.stringify({ synapseTimeoutMs: 10000.5 }));
    process.env.CORTEX_CONFIG_PATH = configPath;

    const result = loadConfig({ quiet: true, skipRequiredChecks: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("must be an integer");

    rmSync(tmpDir, { recursive: true });
  });

  // --- systemPromptFile tests ---

  test("expands ~ in systemPromptFile to home directory", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    const configPath = join(tmpDir, "config.json");

    writeFileSync(
      configPath,
      JSON.stringify({ systemPromptFile: "~/prompts/prompt.md" }),
    );
    process.env.CORTEX_CONFIG_PATH = configPath;

    const result = loadConfig({ quiet: true, skipRequiredChecks: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.systemPromptFile).toBe(
      join(homedir(), "prompts/prompt.md"),
    );

    rmSync(tmpDir, { recursive: true });
  });

  test("leaves absolute systemPromptFile path unchanged", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    const configPath = join(tmpDir, "config.json");

    writeFileSync(
      configPath,
      JSON.stringify({ systemPromptFile: "/etc/cortex/prompt.md" }),
    );
    process.env.CORTEX_CONFIG_PATH = configPath;

    const result = loadConfig({ quiet: true, skipRequiredChecks: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.systemPromptFile).toBe("/etc/cortex/prompt.md");

    rmSync(tmpDir, { recursive: true });
  });
});
