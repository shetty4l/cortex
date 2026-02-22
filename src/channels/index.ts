import { createLogger } from "@shetty4l/core/log";

const log = createLogger("cortex");

export interface Channel {
  readonly name: string;
  readonly canReceive: boolean;
  readonly canDeliver: boolean;
  readonly mode: "realtime" | "buffered";
  readonly priority: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  sync(): Promise<void>;
}

export class ChannelRegistry {
  private channels = new Map<string, Channel>();

  register(channel: Channel): void {
    if (this.channels.has(channel.name)) {
      throw new Error(`Channel '${channel.name}' already registered`);
    }
    this.channels.set(channel.name, channel);
    log(
      `registered channel: ${channel.name} (${channel.mode}, priority=${channel.priority})`,
    );
  }

  get(name: string): Channel | undefined {
    return this.channels.get(name);
  }

  getAll(): Channel[] {
    return Array.from(this.channels.values());
  }

  async startAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      await channel.start();
      log(`started channel: ${channel.name}`);
    }
  }

  async stopAll(): Promise<void> {
    const channels = Array.from(this.channels.values()).reverse();
    for (const channel of channels) {
      await channel.stop();
      log(`stopped channel: ${channel.name}`);
    }
  }
}
