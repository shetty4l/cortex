/**
 * Daemon management for Cortex.
 *
 * Handles starting/stopping the server as a background process.
 * PID and log files stored in ~/.config/cortex/
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { loadConfig } from "./config";

const DATA_DIR = join(homedir(), ".config", "cortex");
const PID_FILE = join(DATA_DIR, "cortex.pid");
const LOG_FILE = join(DATA_DIR, "cortex.log");

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  port?: number;
  uptime?: number;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | undefined {
  if (!existsSync(PID_FILE)) {
    return undefined;
  }
  try {
    const content = readFileSync(PID_FILE, "utf-8").trim();
    const pid = Number.parseInt(content, 10);
    return Number.isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

function writePid(pid: number): void {
  writeFileSync(PID_FILE, pid.toString(), "utf-8");
}

function removePidFile(): void {
  if (existsSync(PID_FILE)) {
    unlinkSync(PID_FILE);
  }
}

export async function getDaemonStatus(): Promise<DaemonStatus> {
  const pid = readPid();

  if (!pid) {
    return { running: false };
  }

  if (!isProcessRunning(pid)) {
    removePidFile();
    return { running: false };
  }

  let port: number;
  try {
    const config = loadConfig({ quiet: true });
    port = config.port;
  } catch {
    port = 7751;
  }

  try {
    const response = await fetch(`http://localhost:${port}/health`);
    if (response.ok) {
      const data = (await response.json()) as { uptime?: number };
      return { running: true, pid, port, uptime: data.uptime };
    }
  } catch {
    // Server might be starting up
  }

  return { running: true, pid, port };
}

export async function startDaemon(): Promise<boolean> {
  const status = await getDaemonStatus();

  if (status.running) {
    console.log(`cortex daemon already running (PID: ${status.pid})`);
    return false;
  }

  let port: number;
  try {
    const config = loadConfig({ quiet: true });
    port = config.port;
  } catch {
    port = 7751;
  }

  const cliPath = join(import.meta.dir, "cli.ts");

  const proc = Bun.spawn(["bun", "run", cliPath, "serve"], {
    stdout: Bun.file(LOG_FILE),
    stderr: Bun.file(LOG_FILE),
    stdin: "ignore",
  });

  writePid(proc.pid);

  await new Promise((resolve) => setTimeout(resolve, 500));

  const newStatus = await getDaemonStatus();
  if (newStatus.running) {
    console.log(`cortex daemon started (PID: ${proc.pid}, port: ${port})`);
    return true;
  }

  console.error("Failed to start cortex daemon. Check logs:", LOG_FILE);
  removePidFile();
  return false;
}

export async function stopDaemon(): Promise<boolean> {
  const status = await getDaemonStatus();

  if (!status.running || !status.pid) {
    console.log("cortex daemon is not running");
    return false;
  }

  try {
    process.kill(status.pid, "SIGTERM");

    const maxWait = 5000;
    const interval = 100;
    let waited = 0;

    while (waited < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      waited += interval;

      if (!isProcessRunning(status.pid)) {
        break;
      }
    }

    if (isProcessRunning(status.pid)) {
      process.kill(status.pid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    removePidFile();
    console.log(`cortex daemon stopped (was PID: ${status.pid})`);
    return true;
  } catch (error) {
    console.error("Error stopping daemon:", error);
    removePidFile();
    return false;
  }
}

export async function restartDaemon(): Promise<boolean> {
  await stopDaemon();
  return startDaemon();
}
