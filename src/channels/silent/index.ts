import { createLogger } from "@shetty4l/core/log";
import type { StateLoader } from "@shetty4l/core/state";
import { ackOutboxMessage, pollOutboxMessages } from "../../outbox";
import type { Channel } from "../index";

const log = createLogger("cortex");

export class SilentChannel implements Channel {
  readonly name = "silent";
  readonly canReceive = false;
  readonly canDeliver = true;
  readonly mode = "realtime" as const;
  readonly priority = 99;

  private running = false;
  private done: Promise<void> | null = null;
  private stateLoader: StateLoader | null = null;

  /** Initialize the channel with stateLoader for database operations. */
  init(stateLoader: StateLoader): void {
    this.stateLoader = stateLoader;
  }

  async start(): Promise<void> {
    this.running = true;
    this.done = this.runDelivery();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.done;
    this.done = null;
  }

  async sync(): Promise<void> {}

  private async runDelivery(): Promise<void> {
    while (this.running) {
      try {
        if (!this.stateLoader) {
          log("silent channel: stateLoader not initialized");
          if (this.running) await Bun.sleep(2000);
          continue;
        }

        const messages = await pollOutboxMessages(
          this.stateLoader,
          "silent",
          10,
          30,
          3,
        );
        for (const msg of messages) {
          await ackOutboxMessage(
            this.stateLoader,
            msg.messageId,
            msg.leaseToken,
          );
        }
        if (messages.length === 0 && this.running) {
          await Bun.sleep(2000);
        }
      } catch (err) {
        log(
          `silent channel error: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (this.running) await Bun.sleep(1000);
      }
    }
  }
}
