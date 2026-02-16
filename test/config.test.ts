import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig } from "../src/config";

describe("config", () => {
  const originalEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "CORTEX_PORT",
    "CORTEX_HOST",
    "CORTEX_CONFIG_PATH",
    "CORTEX_INGEST_API_KEY",
    "CORTEX_MODEL",
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
    const config = loadConfig({ quiet: true, skipRequiredChecks: true });

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
    expect(config.ingestApiKey).toBeUndefined();
    expect(config.model).toBeUndefined();
    expect(config.extractionModel).toBeUndefined();
  });

  test("loads config from file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    const configPath = join(tmpDir, "config.json");

    writeFileSync(
      configPath,
      JSON.stringify({
        port: 9999,
        host: "0.0.0.0",
        model: "qwen2.5:14b",
        skillDirs: ["/opt/skills"],
      }),
    );

    process.env.CORTEX_CONFIG_PATH = configPath;
    const config = loadConfig({ quiet: true, skipRequiredChecks: true });

    expect(config.port).toBe(9999);
    expect(config.host).toBe("0.0.0.0");
    expect(config.model).toBe("qwen2.5:14b");
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
      JSON.stringify({ port: 9999, model: "file-model" }),
    );

    process.env.CORTEX_CONFIG_PATH = configPath;
    process.env.CORTEX_PORT = "8888";
    process.env.CORTEX_HOST = "0.0.0.0";
    process.env.CORTEX_INGEST_API_KEY = "test-key";
    process.env.CORTEX_MODEL = "env-model";

    const config = loadConfig({ quiet: true });

    expect(config.port).toBe(8888);
    expect(config.host).toBe("0.0.0.0");
    expect(config.ingestApiKey).toBe("test-key");
    expect(config.model).toBe("env-model");

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
    const config = loadConfig({ quiet: true, skipRequiredChecks: true });

    expect(config.synapseUrl).toBe("http://remote:7750");

    delete process.env.MY_SYNAPSE_URL;
    rmSync(tmpDir, { recursive: true });
  });

  test("throws on invalid port in env var", () => {
    process.env.CORTEX_CONFIG_PATH = "/nonexistent/config.json";
    process.env.CORTEX_PORT = "99999";

    expect(() => loadConfig({ quiet: true, skipRequiredChecks: true })).toThrow(
      "not a valid port number",
    );
  });

  test("throws on invalid port in config file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    const configPath = join(tmpDir, "config.json");

    writeFileSync(configPath, JSON.stringify({ port: -1 }));
    process.env.CORTEX_CONFIG_PATH = configPath;

    expect(() => loadConfig({ quiet: true, skipRequiredChecks: true })).toThrow(
      "not a valid port number",
    );

    rmSync(tmpDir, { recursive: true });
  });

  test("throws on invalid JSON in config file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    const configPath = join(tmpDir, "config.json");

    writeFileSync(configPath, "not json");
    process.env.CORTEX_CONFIG_PATH = configPath;

    expect(() => loadConfig({ quiet: true, skipRequiredChecks: true })).toThrow(
      "invalid JSON",
    );

    rmSync(tmpDir, { recursive: true });
  });

  test("validates numeric field ranges", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    const configPath = join(tmpDir, "config.json");

    writeFileSync(configPath, JSON.stringify({ outboxLeaseSeconds: 5 }));
    process.env.CORTEX_CONFIG_PATH = configPath;

    expect(() => loadConfig({ quiet: true, skipRequiredChecks: true })).toThrow(
      "must be >= 10",
    );

    rmSync(tmpDir, { recursive: true });
  });

  test("throws when ingestApiKey is missing", () => {
    process.env.CORTEX_CONFIG_PATH = "/nonexistent/config.json";

    expect(() => loadConfig({ quiet: true })).toThrow(
      "ingestApiKey is required",
    );
  });

  test("throws when model is missing", () => {
    process.env.CORTEX_CONFIG_PATH = "/nonexistent/config.json";
    process.env.CORTEX_INGEST_API_KEY = "test-key";

    expect(() => loadConfig({ quiet: true })).toThrow("model is required");
  });

  test("throws on empty model string in config file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    const configPath = join(tmpDir, "config.json");

    writeFileSync(configPath, JSON.stringify({ model: "" }));
    process.env.CORTEX_CONFIG_PATH = configPath;

    expect(() => loadConfig({ quiet: true, skipRequiredChecks: true })).toThrow(
      "model: must be a non-empty string",
    );

    rmSync(tmpDir, { recursive: true });
  });
});
