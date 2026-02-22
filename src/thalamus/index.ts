import { createLogger } from "@shetty4l/core/log";
import { type EnqueueResult, enqueueInboxMessage } from "../db";
import { formatChannelData } from "./formatters";

const log = createLogger("cortex");

// --- Types ---

export interface ReceivePayload {
  channel: string;
  externalId: string;
  data: unknown;
  occurredAt: string;
  metadata?: Record<string, unknown>;
}

export interface ReceiveResult {
  eventId: string;
  duplicate: boolean;
}

// --- Static channel priority map ---

const CHANNEL_PRIORITY: Record<string, number> = {
  telegram: 0,
  cli: 0,
  calendar: 2,
  email: 3,
};

const DEFAULT_PRIORITY = 5;

function getChannelPriority(channel: string): number {
  return CHANNEL_PRIORITY[channel] ?? DEFAULT_PRIORITY;
}

// --- Thalamus ---

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

  /**
   * Receive external input and enqueue it to the inbox.
   *
   * Pass-through implementation: formats data to text, assigns priority
   * from a static channel map, and enqueues directly to the inbox.
   * Will be replaced by real LLM reasoning when cortex#65 ships.
   */
  receive(payload: ReceivePayload): ReceiveResult {
    const { channel, externalId, data, occurredAt, metadata } = payload;

    const priority = getChannelPriority(channel);
    const text = formatChannelData(channel, data);
    const idempotencyKey = `${channel}:${externalId}`;

    // Extract topicKey from data if present, otherwise use channel name
    const topicKey =
      data !== null &&
      typeof data === "object" &&
      "topicKey" in (data as Record<string, unknown>) &&
      typeof (data as Record<string, unknown>).topicKey === "string"
        ? ((data as Record<string, unknown>).topicKey as string)
        : channel;

    // Extract userId from data if present, otherwise use "system"
    const userId =
      data !== null &&
      typeof data === "object" &&
      "userId" in (data as Record<string, unknown>) &&
      typeof (data as Record<string, unknown>).userId === "string"
        ? ((data as Record<string, unknown>).userId as string)
        : "system";

    const occurredAtMs = new Date(occurredAt).getTime();

    const result: EnqueueResult = enqueueInboxMessage({
      channel,
      externalMessageId: externalId,
      topicKey,
      userId,
      text,
      occurredAt: occurredAtMs,
      idempotencyKey,
      metadata,
      priority,
    });

    return { eventId: result.eventId, duplicate: result.duplicate };
  }
}
