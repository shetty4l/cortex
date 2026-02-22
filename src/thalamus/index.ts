import { createLogger } from "@shetty4l/core/log";

const log = createLogger("cortex");

export class Thalamus {
  async start(): Promise<void> {
    log("thalamus started (stub)");
  }

  async stop(): Promise<void> {
    log("thalamus stopped (stub)");
  }

  async syncAll(): Promise<void> {
    log("thalamus syncAll (stub — no-op)");
  }

  async syncChannel(channelName: string): Promise<void> {
    log(`thalamus syncChannel(${channelName}) (stub — no-op)`);
  }
}
