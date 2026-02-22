import { createLogger } from "@shetty4l/core/log";

const log = createLogger("cortex");

export class Tick {
  async start(): Promise<void> {
    log("tick started (stub)");
  }

  async stop(): Promise<void> {
    log("tick stopped (stub)");
  }

  async fire(): Promise<void> {
    log("tick fire (stub — no-op)");
  }
}
