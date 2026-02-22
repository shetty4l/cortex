import { createLogger } from "@shetty4l/core/log";
import { ackOutboxMessage, pollOutboxMessages } from "../../db";
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
        const messages = pollOutboxMessages("silent", 10, 30, 3);
        for (const msg of messages) {
          ackOutboxMessage(msg.messageId, msg.leaseToken);
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
