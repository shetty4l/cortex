import { createLogger } from "@shetty4l/core/log";
import { StateLoader } from "@shetty4l/core/state";
import { getDatabase } from "../db";
import { enqueueInboxMessage } from "../inbox";
import {
  deleteProcessedBuffers,
  getUnprocessedBuffers,
  insertReceptorBuffer,
} from "../receptor-buffers";
import {
  type StateLoader as IStateLoader,
  ReceptorCursorState,
  ThalamusState,
} from "../state";
import { chat } from "../synapse";
import { getOrCreateTopicByKey, listTopics } from "../topics";
import { formatChannelData } from "./formatters";
import {
  buildTriageUserPrompt,
  type ParseResult,
  parseSyncOutput,
  THALAMUS_RETRY_PROMPT,
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
  thalamusModels: string[];
  thalamusExtractionModel?: string;
  synapseTimeoutMs: number;
  syncIntervalMs: number;
  stateLoader: IStateLoader;
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

export interface SyncResult {
  ok: boolean;
  groups: number;
  buffers: number;
  error?: string;
}

// --- Thalamus ---

export class Thalamus {
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private stateLoader: IStateLoader | null = null;
  private thalamusState: ThalamusState | null = null;

  constructor(private config?: ThalamusConfig) {
    if (config?.stateLoader) {
      this.stateLoader = config.stateLoader;
      this.thalamusState = config.stateLoader.load(ThalamusState, "singleton");
    }
  }

  /**
   * Get or create a StateLoader for backward compatibility.
   * Uses the configured stateLoader if available, otherwise creates one from getDatabase().
   */
  private getStateLoaderOrFallback(): IStateLoader {
    if (this.stateLoader) {
      return this.stateLoader;
    }
    // Fallback for backward compatibility when no config provided
    return new StateLoader(getDatabase());
  }

  /** Returns the timestamp of the last syncAll() run, or null if never run. */
  getLastSyncAt(): number | null {
    return this.thalamusState?.lastSyncAt?.getTime() ?? null;
  }

  async start(): Promise<void> {
    if (!this.config) {
      log("thalamus started (no config — sync disabled)");
      return;
    }
    log(`thalamus started (sync interval: ${this.config.syncIntervalMs}ms)`);

    // Immediate sync on startup to process any pending buffers
    void this.syncAll();

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

  async syncAll(): Promise<SyncResult> {
    // Update persistent timestamp
    if (this.thalamusState) {
      this.thalamusState.lastSyncAt = new Date();
    }

    if (!this.config) {
      log("thalamus syncAll: no config, skipping");
      return { ok: true, groups: 0, buffers: 0 };
    }

    try {
      const buffers = getUnprocessedBuffers(this.stateLoader!);
      if (buffers.length === 0) {
        log("thalamus syncAll: no buffered data");
        return { ok: true, groups: 0, buffers: 0 };
      }

      const groups = await this.processBuffers(buffers);
      return { ok: true, groups, buffers: buffers.length };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log(`thalamus syncAll error: ${error}`);
      return { ok: false, groups: 0, buffers: 0, error };
    }
  }

  async syncChannel(channelName: string): Promise<SyncResult> {
    if (!this.config) {
      log(`thalamus syncChannel(${channelName}): no config, skipping`);
      return { ok: true, groups: 0, buffers: 0 };
    }

    try {
      const buffers = getUnprocessedBuffers(this.stateLoader!, {
        channel: channelName,
      });
      if (buffers.length === 0) {
        log(`thalamus syncChannel(${channelName}): no buffered data`);
        return { ok: true, groups: 0, buffers: 0 };
      }

      const groups = await this.processBuffers(buffers);
      return { ok: true, groups, buffers: buffers.length };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log(`thalamus syncChannel(${channelName}) error: ${error}`);
      return { ok: false, groups: 0, buffers: 0, error };
    }
  }

  private async processBuffers(
    buffers: Array<{
      id: string;
      channel: string;
      content: string;
      occurred_at: number;
    }>,
  ): Promise<number> {
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
        occurredAt: buf.occurred_at,
      });
      grouped.set(buf.channel, items);
    }

    // Get existing topics for routing
    const topics = listTopics(this.stateLoader!);
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

    // Use extraction model if configured, otherwise fall back to thalamus models
    const models = config.thalamusExtractionModel
      ? [config.thalamusExtractionModel]
      : config.thalamusModels;

    // Call Synapse via shared chat() — gets model fallback for free
    const chatResult = await chat(
      [
        { role: "system", content: THALAMUS_TRIAGE_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      models,
      config.synapseUrl,
      { temperature: 0.1, timeoutMs: config.synapseTimeoutMs },
    );

    if (!chatResult.ok) {
      throw new Error(chatResult.error);
    }

    let messageContent = chatResult.value.content;
    let parseResult: ParseResult = parseSyncOutput(messageContent);

    // Retry with correction prompt if parse failed (not just empty items)
    if (!parseResult.ok && buffers.length > 0) {
      log("thalamus sync: parse failed, retrying with correction prompt");

      const retryResult = await chat(
        [
          { role: "system", content: THALAMUS_TRIAGE_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
          { role: "assistant", content: messageContent },
          { role: "user", content: THALAMUS_RETRY_PROMPT },
        ],
        models,
        config.synapseUrl,
        { temperature: 0.1, timeoutMs: config.synapseTimeoutMs },
      );

      if (retryResult.ok) {
        messageContent = retryResult.value.content;
        parseResult = parseSyncOutput(messageContent);
      } else {
        log(`thalamus sync: retry failed: ${retryResult.error}`);
      }
    }

    // Prevent data loss: only delete buffers if parsing succeeded
    if (!parseResult.ok && buffers.length > 0) {
      log(
        `thalamus sync: all attempts failed, preserving ${buffers.length} buffers for next sync`,
      );
      return 0;
    }

    const items = parseResult.items;

    // Create inbox messages for each triaged group
    for (const item of items) {
      // Create topic if topicKey is non-null (null = General thread, no Topic record)
      if (item.topicKey !== null) {
        // Use topicName from LLM if provided, otherwise default to key
        const topicName = item.topicName || item.topicKey;
        getOrCreateTopicByKey(this.stateLoader!, item.topicKey, topicName);
      }

      const idempotencyHash = [...item.rawBufferIds].sort().join(",");
      const idempotencyKey = `thalamus-sync:${item.topicKey}:${idempotencyHash}`;

      enqueueInboxMessage(this.stateLoader!, {
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
    if (this.stateLoader) {
      for (const channel of grouped.keys()) {
        const cursorState = this.stateLoader.load(ReceptorCursorState, channel);
        cursorState.cursorValue = String(Date.now());
        cursorState.lastSyncedAt = new Date();
      }
    }

    // Delete processed buffers
    const allIds = buffers.map((b) => b.id);
    deleteProcessedBuffers(this.stateLoader!, allIds);

    log(
      `thalamus sync complete: ${items.length} groups created from ${buffers.length} buffers`,
    );

    return items.length;
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

    // Use configured stateLoader or create fallback for backward compatibility
    const loader = this.getStateLoaderOrFallback();

    // Buffered mode: write to receptor_buffers, skip inbox
    if (mode === "buffered") {
      const text = formatChannelData(channel, data);
      const result = insertReceptorBuffer(loader, {
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

    // Extract topicKey from data if present
    // null means General thread (no Topic record), undefined falls back to channel
    const dataObj =
      data !== null && typeof data === "object"
        ? (data as Record<string, unknown>)
        : null;

    const hasExplicitTopicKey =
      dataObj !== null &&
      "topicKey" in dataObj &&
      (typeof dataObj.topicKey === "string" || dataObj.topicKey === null);

    const topicKey = hasExplicitTopicKey
      ? (dataObj!.topicKey as string | null)
      : channel;

    // Extract topicName from data if present (for creating new topics)
    const topicName =
      dataObj !== null &&
      "topicName" in dataObj &&
      typeof dataObj.topicName === "string"
        ? dataObj.topicName
        : undefined;

    // Create topic if topicKey is non-null (null = General thread, no Topic record)
    if (topicKey !== null) {
      getOrCreateTopicByKey(loader, topicKey, topicName ?? topicKey);
    }

    // Extract userId from data if present, otherwise use "system"
    const userId =
      dataObj !== null &&
      "userId" in dataObj &&
      typeof dataObj.userId === "string"
        ? dataObj.userId
        : "system";

    const occurredAtMs = new Date(occurredAt).getTime();

    const result = enqueueInboxMessage(loader, {
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

    return { eventId: result.id, duplicate: result.duplicate };
  }
}
