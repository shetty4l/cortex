/**
 * Debug logger for pipeline tracing.
 *
 * Writes structured JSONL events to ~/.config/cortex/logs/pipeline.jsonl.
 * Features:
 *   - Lazy file creation (only on first write)
 *   - Automatic directory creation
 *   - Rotation at 100MB OR daily at midnight
 *   - Retention: 5 rotated files + current
 *
 * Disabled by default — only logs when config.debugPipeline is true.
 */

import { getConfigDir } from "@shetty4l/core/config";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "fs";
import { join } from "path";

// --- Constants ---

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB
const MAX_ROTATED_FILES = 5;
const LOG_FILENAME = "pipeline.jsonl";

// --- Types ---

export interface DebugEvent {
  type: string;
  traceId: string;
  timestamp: string;
  [key: string]: unknown;
}

// --- Logger ---

export class DebugLogger {
  private enabled: boolean;
  private debugPrompt: boolean;
  private logsDir: string;
  private logFile: string;
  private lastRotationDate: string | null = null;

  constructor(opts: { debugPipeline?: boolean; debugPrompt?: boolean }) {
    this.enabled = opts.debugPipeline ?? false;
    this.debugPrompt = opts.debugPrompt ?? false;
    const configDir = getConfigDir("cortex");
    this.logsDir = join(configDir, "logs");
    this.logFile = join(this.logsDir, LOG_FILENAME);
  }

  /** Check if pipeline debug logging is enabled. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Check if prompt logging is enabled (requires debugPipeline + debugPrompt). */
  isPromptEnabled(): boolean {
    return this.enabled && this.debugPrompt;
  }

  /** Get the path to the current log file (for CLI). */
  getLogFilePath(): string {
    return this.logFile;
  }

  /** Get the logs directory path (for CLI). */
  getLogsDir(): string {
    return this.logsDir;
  }

  /** List available log files (current + rotated). */
  listLogFiles(): string[] {
    if (!existsSync(this.logsDir)) return [];

    const files = readdirSync(this.logsDir)
      .filter((f) => f.startsWith("pipeline.") && f.endsWith(".jsonl"))
      .sort()
      .reverse(); // newest first

    return files;
  }

  /**
   * Log a debug event.
   *
   * Events are only written if debugPipeline is enabled.
   * For prompt events, debugPrompt must also be enabled.
   */
  log(event: DebugEvent): void {
    if (!this.enabled) return;

    // Check rotation before write
    this.maybeRotate();

    // Ensure directory exists
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true });
    }

    // Write JSONL line
    const line = JSON.stringify(event) + "\n";
    appendFileSync(this.logFile, line);
  }

  /**
   * Check if rotation is needed and perform it.
   *
   * Rotates on:
   * 1. File size exceeds 100MB
   * 2. Date changed since last rotation check
   * 3. On first write after restart, if existing file is from a previous day
   */
  private maybeRotate(): void {
    const today = new Date().toISOString().slice(0, 10);

    // On first call after startup, check if existing file is from a previous day
    if (this.lastRotationDate === null && existsSync(this.logFile)) {
      try {
        const stats = statSync(this.logFile);
        const fileDate = new Date(stats.mtime).toISOString().slice(0, 10);
        if (fileDate !== today) {
          this.rotate();
        }
      } catch {
        // File may have been deleted, ignore
      }
    }

    // Check daily rotation (for long-running processes across midnight)
    if (this.lastRotationDate !== null && this.lastRotationDate !== today) {
      this.rotate();
      this.lastRotationDate = today;
      return;
    }

    this.lastRotationDate = today;

    // Check size rotation
    if (existsSync(this.logFile)) {
      try {
        const stats = statSync(this.logFile);
        if (stats.size >= MAX_FILE_SIZE_BYTES) {
          this.rotate();
        }
      } catch {
        // File may have been deleted between check and stat
      }
    }
  }

  /**
   * Rotate the current log file.
   *
   * Renames pipeline.jsonl to pipeline.YYYY-MM-DDTHH-mm-ss.jsonl
   * and cleans up old files beyond retention limit.
   */
  private rotate(): void {
    if (!existsSync(this.logFile)) return;

    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const rotatedName = `pipeline.${timestamp}.jsonl`;
    const rotatedPath = join(this.logsDir, rotatedName);

    try {
      // Rename current file
      renameSync(this.logFile, rotatedPath);

      // Cleanup old files
      this.cleanupOldFiles();
    } catch {
      // Rotation failure is non-fatal — continue writing to current file
    }
  }

  /**
   * Remove old rotated files beyond retention limit.
   */
  private cleanupOldFiles(): void {
    const files = this.listLogFiles().filter((f) => f !== LOG_FILENAME);

    // Keep only MAX_ROTATED_FILES
    if (files.length > MAX_ROTATED_FILES) {
      const toDelete = files.slice(MAX_ROTATED_FILES);
      for (const file of toDelete) {
        try {
          unlinkSync(join(this.logsDir, file));
        } catch {
          // Ignore deletion failures
        }
      }
    }
  }
}

// --- Singleton ---

let debugLoggerInstance: DebugLogger | null = null;

/**
 * Initialize the debug logger singleton.
 * Called once at startup with config values.
 */
export function initDebugLogger(opts: {
  debugPipeline?: boolean;
  debugPrompt?: boolean;
}): DebugLogger {
  debugLoggerInstance = new DebugLogger(opts);
  return debugLoggerInstance;
}

/**
 * Get the debug logger singleton.
 * Returns a no-op logger if not initialized.
 */
export function getDebugLogger(): DebugLogger {
  if (!debugLoggerInstance) {
    // Return disabled logger if not initialized
    return new DebugLogger({});
  }
  return debugLoggerInstance;
}
