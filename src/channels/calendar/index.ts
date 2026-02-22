import { createLogger } from "@shetty4l/core/log";
import type { Channel } from "../index";

const log = createLogger("cortex");

export class CalendarChannel implements Channel {
  readonly name = "calendar";
  readonly canReceive = true;
  readonly canDeliver = false;
  readonly mode = "buffered" as const;
  readonly priority = 2;

  async start(): Promise<void> {
    log("calendar channel started (stub)");
  }

  async stop(): Promise<void> {
    log("calendar channel stopped (stub)");
  }

  async sync(): Promise<void> {
    log("calendar sync (stub — no-op)");
  }
}
