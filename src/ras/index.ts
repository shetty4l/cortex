import { createLogger } from "@shetty4l/core/log";

const log = createLogger("cortex");

export class RAS {
  async start(): Promise<void> {
    log("ras started (stub)");
  }

  async stop(): Promise<void> {
    log("ras stopped (stub)");
  }

  async scan(): Promise<void> {
    log("ras scan (stub — no-op)");
  }
}
