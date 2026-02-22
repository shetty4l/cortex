import { createLogger } from "@shetty4l/core/log";
import {
  deleteProcessedBuffers,
  type EnqueueResult,
  enqueueInboxMessage,
  getUnprocessedBuffers,
  insertReceptorBuffer,
  upsertReceptorCursor,
} from "../db";
import { listTopics } from "../topics";
import { formatChannelData } from "./formatters";
import {
  buildTriageUserPrompt,
  parseSyncOutput,
  THALAMUS_TRIAGE_SYSTEM_PROMPT,
} from "./prompts";

const log = createLogger("cortex");

// --- Types ---

export interface ReceivePayload {
  channel: string;
  externalId: string;
  data: unknown;
  occurredAt: string;
  metadata?: Record<string, unknown>;
  mode?: "realtime" | "buffered";
}

export interface ReceiveResult {
  eventId: string;
  duplicate: boolean;
}

export interface ThalamusConfig {
  synapseUrl: string;
  thalamusModel: string;
  synapseTimeoutMs: number;
  syncIntervalMs: number;
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
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private config?: ThalamusConfig) {}

  async start(): Promise<void> {
    if (!this.config) {
      log("thalamus started (no config — sync disabled)");
      return;
    }
    log(`thalamus started (sync interval: ${this.config.syncIntervalMs}ms)`);
    this.syncTimer = setInterval(
      () => void this.syncAll(),
      this.config.syncIntervalMs,
    );
  }

  async stop(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    log("thalamus stopped");
  }

  async syncAll(): Promise<void> {
    if (!this.config) {
      log("thalamus syncAll: no config, skipping");
      return;
    }

    try {
      const buffers = getUnprocessedBuffers();
      if (buffers.length === 0) {
        log("thalamus syncAll: no buffered data");
        return;
      }

      await this.processBuffers(buffers);
    } catch (e) {
      log(
        `thalamus syncAll error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async syncChannel(channelName: string): Promise<void> {
    if (!this.config) {
      log(`thalamus syncChannel(${channelName}): no config, skipping`);
      return;
    }

    try {
      const buffers = getUnprocessedBuffers({ channel: channelName });
      if (buffers.length === 0) {
        log(`thalamus syncChannel(${channelName}): no buffered data`);
        return;
      }

      await this.processBuffers(buffers);
    } catch (e) {
      log(
        `thalamus syncChannel(${channelName}) error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async processBuffers(
    buffers: ReturnType<typeof getUnprocessedBuffers>,
  ): Promise<void> {
    const config = this.config!;

    // Group buffers by channel
    const grouped = new Map<
      string,
      { id: string; content: string; occurredAt: number }[]
    >();
    for (const buf of buffers) {
      const items = grouped.get(buf.channel) ?? [];
      items.push({
        id: buf.id,
        content: buf.content,
        occurredAt: buf.occurredAt,
      });
      grouped.set(buf.channel, items);
    }

    // Get existing topics for routing
    const topics = listTopics();
    const existingTopics = topics.map((t) => ({
      key: t.id,
      name: t.name,
      status: t.status,
    }));

    // Build triage prompt
    const channelBuffers = Array.from(grouped.entries()).map(
      ([channel, items]) => ({
        channel,
        items,
      }),
    );
    const userPrompt = buildTriageUserPrompt(channelBuffers, existingTopics);

    // Call Synapse directly (not through agent loop)
    const response = await fetch(`${config.synapseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.thalamusModel,
        messages: [
          { role: "system", content: THALAMUS_TRIAGE_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(config.synapseTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(
        `Synapse returned ${response.status}: ${await response.text()}`,
      );
    }

    const body = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string | null };
      }>;
    };

    const messageContent = body.choices?.[0]?.message?.content ?? "";
    const items = parseSyncOutput(messageContent);

    // Create inbox messages for each triaged group
    for (const item of items) {
      const idempotencyHash = item.rawBufferIds.sort().join(",");
      const idempotencyKey = `thalamus-sync:${idempotencyHash}`;

      enqueueInboxMessage({
        channel: "thalamus",
        externalMessageId: idempotencyKey,
        topicKey: item.topicKey,
        userId: "system",
        text: item.summary,
        occurredAt: Date.now(),
        idempotencyKey,
        metadata: {
          rawBufferIds: item.rawBufferIds,
          source: "thalamus-sync",
        },
        priority: item.priority,
      });
    }

    // Update receptor cursors per channel
    for (const channel of grouped.keys()) {
      upsertReceptorCursor(channel, String(Date.now()));
    }

    // Delete processed buffers
    const allIds = buffers.map((b) => b.id);
    deleteProcessedBuffers(allIds);

    log(
      `thalamus sync complete: ${items.length} groups created from ${buffers.length} buffers`,
    );
  }

  /**
   * Receive external input and enqueue it to the inbox.
   *
   * Pass-through implementation: formats data to text, assigns priority
   * from a static channel map, and enqueues directly to the inbox.
   * Will be replaced by real LLM reasoning when cortex#65 ships.
   */
  receive(payload: ReceivePayload): ReceiveResult {
    const { channel, externalId, data, occurredAt, metadata, mode } = payload;

    // Buffered mode: write to receptor_buffers, skip inbox
    if (mode === "buffered") {
      const text = formatChannelData(channel, data);
      const result = insertReceptorBuffer({
        channel,
        externalId,
        content: text,
        metadataJson: metadata ? JSON.stringify(metadata) : null,
        occurredAt: new Date(occurredAt).getTime(),
      });
      return { eventId: result.id, duplicate: result.duplicate };
    }

    // Realtime mode (default): existing inbox path
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
