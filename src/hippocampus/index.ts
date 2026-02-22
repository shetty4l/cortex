import { createLogger } from "@shetty4l/core/log";

const log = createLogger("cortex");

export class Hippocampus {
  async start(): Promise<void> {
    log("hippocampus started (stub)");
  }

  async stop(): Promise<void> {
    log("hippocampus stopped (stub)");
  }

  async consolidate(): Promise<void> {
    log("hippocampus consolidate (stub — no-op)");
  }
}
