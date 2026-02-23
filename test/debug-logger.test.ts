import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { type DebugEvent, DebugLogger } from "../src/debug-logger";

// Mock getConfigDir to use a temp directory
let mockConfigDir: string;
const originalGetConfigDir = await import("@shetty4l/core/config").then(
  (m) => m.getConfigDir,
);

describe("DebugLogger", () => {
  beforeEach(() => {
    mockConfigDir = mkdtempSync(join(tmpdir(), "cortex-debug-test-"));
  });

  afterEach(() => {
    if (mockConfigDir && existsSync(mockConfigDir)) {
      rmSync(mockConfigDir, { recursive: true });
    }
  });

  test("does not write when disabled", () => {
    const logsDir = join(mockConfigDir, "logs");
    const logFile = join(logsDir, "pipeline.jsonl");

    const logger = new DebugLogger({});

    logger.log({
      type: "test",
      traceId: "abc12345",
      timestamp: new Date().toISOString(),
      data: "should not appear",
    });

    expect(existsSync(logFile)).toBe(false);
  });

  test("isEnabled returns false when debugPipeline is false", () => {
    const logger = new DebugLogger({ debugPipeline: false });
    expect(logger.isEnabled()).toBe(false);
  });

  test("isEnabled returns true when debugPipeline is true", () => {
    const logger = new DebugLogger({ debugPipeline: true });
    expect(logger.isEnabled()).toBe(true);
  });

  test("isPromptEnabled returns false when only debugPipeline is true", () => {
    const logger = new DebugLogger({ debugPipeline: true, debugPrompt: false });
    expect(logger.isPromptEnabled()).toBe(false);
  });

  test("isPromptEnabled returns true when both debugPipeline and debugPrompt are true", () => {
    const logger = new DebugLogger({ debugPipeline: true, debugPrompt: true });
    expect(logger.isPromptEnabled()).toBe(true);
  });

  test("isPromptEnabled returns false when debugPipeline is false", () => {
    const logger = new DebugLogger({ debugPipeline: false, debugPrompt: true });
    expect(logger.isPromptEnabled()).toBe(false);
  });

  test("writes JSONL when enabled", () => {
    const logsDir = join(mockConfigDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, "pipeline.jsonl");

    // Create a logger with custom paths (test directly since we can't mock getConfigDir)
    const logger = new (class extends DebugLogger {
      constructor() {
        super({ debugPipeline: true });
        // Override private fields for testing
        (this as unknown as { logsDir: string }).logsDir = logsDir;
        (this as unknown as { logFile: string }).logFile = logFile;
      }
    })();

    const event: DebugEvent = {
      type: "test",
      traceId: "abc12345",
      timestamp: "2026-02-23T12:00:00.000Z",
      foo: "bar",
    };

    logger.log(event);

    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe("test");
    expect(parsed.traceId).toBe("abc12345");
    expect(parsed.foo).toBe("bar");
  });

  test("appends multiple events as separate lines", () => {
    const logsDir = join(mockConfigDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, "pipeline.jsonl");

    const logger = new (class extends DebugLogger {
      constructor() {
        super({ debugPipeline: true });
        (this as unknown as { logsDir: string }).logsDir = logsDir;
        (this as unknown as { logFile: string }).logFile = logFile;
      }
    })();

    logger.log({
      type: "event1",
      traceId: "trace1",
      timestamp: "2026-02-23T12:00:00.000Z",
    });
    logger.log({
      type: "event2",
      traceId: "trace2",
      timestamp: "2026-02-23T12:00:01.000Z",
    });

    const content = readFileSync(logFile, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);

    expect(JSON.parse(lines[0]).type).toBe("event1");
    expect(JSON.parse(lines[1]).type).toBe("event2");
  });

  test("listLogFiles returns empty array when directory does not exist", () => {
    const logger = new (class extends DebugLogger {
      constructor() {
        super({});
        (this as unknown as { logsDir: string }).logsDir = join(
          mockConfigDir,
          "nonexistent",
        );
      }
    })();

    expect(logger.listLogFiles()).toEqual([]);
  });

  test("listLogFiles returns sorted log files", () => {
    const logsDir = join(mockConfigDir, "logs");
    mkdirSync(logsDir, { recursive: true });

    // Create some mock log files
    writeFileSync(join(logsDir, "pipeline.jsonl"), "");
    writeFileSync(join(logsDir, "pipeline.2026-02-22T10-00-00.jsonl"), "");
    writeFileSync(join(logsDir, "pipeline.2026-02-23T10-00-00.jsonl"), "");
    writeFileSync(join(logsDir, "unrelated.log"), ""); // Should be ignored

    const logger = new (class extends DebugLogger {
      constructor() {
        super({});
        (this as unknown as { logsDir: string }).logsDir = logsDir;
      }
    })();

    const files = logger.listLogFiles();

    // Should be sorted newest first (reverse alphabetical for ISO timestamps)
    expect(files.length).toBe(3);
    expect(files[0]).toBe("pipeline.jsonl");
    expect(files[1]).toBe("pipeline.2026-02-23T10-00-00.jsonl");
    expect(files[2]).toBe("pipeline.2026-02-22T10-00-00.jsonl");
  });

  test("getLogFilePath returns correct path", () => {
    const logger = new DebugLogger({});
    const path = logger.getLogFilePath();
    expect(path).toContain("pipeline.jsonl");
  });

  test("getLogsDir returns correct path", () => {
    const logger = new DebugLogger({});
    const path = logger.getLogsDir();
    expect(path).toContain("logs");
  });

  test("rotates stale file on first write after restart", () => {
    const logsDir = join(mockConfigDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, "pipeline.jsonl");

    // Create a log file with yesterday's modification time
    writeFileSync(
      logFile,
      '{"type":"old","traceId":"old123","timestamp":"2026-02-22T12:00:00.000Z"}\n',
    );
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(logFile, yesterday, yesterday);

    // Create a new logger instance (simulating restart)
    const logger = new (class extends DebugLogger {
      constructor() {
        super({ debugPipeline: true });
        (this as unknown as { logsDir: string }).logsDir = logsDir;
        (this as unknown as { logFile: string }).logFile = logFile;
      }
    })();

    // Write a new event - should trigger rotation of the stale file
    logger.log({
      type: "new",
      traceId: "new123",
      timestamp: new Date().toISOString(),
    });

    // Check that the old file was rotated
    const files = readdirSync(logsDir).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBe(2); // pipeline.jsonl (new) + rotated file

    // Current file should only have the new event
    const currentContent = readFileSync(logFile, "utf-8");
    const currentLines = currentContent.trim().split("\n");
    expect(currentLines.length).toBe(1);
    expect(JSON.parse(currentLines[0]).type).toBe("new");

    // Rotated file should have the old event
    const rotatedFile = files.find((f) => f !== "pipeline.jsonl");
    expect(rotatedFile).toBeDefined();
    const rotatedContent = readFileSync(join(logsDir, rotatedFile!), "utf-8");
    expect(JSON.parse(rotatedContent.trim()).type).toBe("old");
  });

  test("does not rotate file from today on restart", () => {
    const logsDir = join(mockConfigDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, "pipeline.jsonl");

    // Create a log file with today's modification time (default)
    writeFileSync(
      logFile,
      '{"type":"today","traceId":"today123","timestamp":"2026-02-23T12:00:00.000Z"}\n',
    );

    // Create a new logger instance (simulating restart)
    const logger = new (class extends DebugLogger {
      constructor() {
        super({ debugPipeline: true });
        (this as unknown as { logsDir: string }).logsDir = logsDir;
        (this as unknown as { logFile: string }).logFile = logFile;
      }
    })();

    // Write a new event - should NOT trigger rotation
    logger.log({
      type: "new",
      traceId: "new123",
      timestamp: new Date().toISOString(),
    });

    // Check that no rotation occurred
    const files = readdirSync(logsDir).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBe(1); // Only pipeline.jsonl

    // File should have both events
    const content = readFileSync(logFile, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).type).toBe("today");
    expect(JSON.parse(lines[1]).type).toBe("new");
  });
});
