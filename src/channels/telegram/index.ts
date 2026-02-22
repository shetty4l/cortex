import { createLogger } from "@shetty4l/core/log";
import type { CortexConfig } from "../../config";
import {
  ackOutboxMessage,
  getReceptorCursor,
  pollOutboxMessages,
  upsertReceptorCursor,
} from "../../db";
import type { Thalamus } from "../../thalamus";
import type { Channel } from "../index";
import {
  getUpdates,
  parseTelegramTopicKey,
  sendMessage,
  TelegramApiError,
  type TelegramTopic,
} from "./api";
import { chunkMarkdownV2 } from "./chunker";
import { formatForTelegram } from "./format";

export type {
  SendMessageOptions,
  TelegramMessage,
  TelegramTopic,
  TelegramUpdate,
} from "./api";
export {
  getUpdates,
  parseTelegramTopicKey,
  sendMessage,
  TelegramApiError,
} from "./api";
export { chunkMarkdownV2 } from "./chunker";
export { formatForTelegram } from "./format";

const log = createLogger("cortex");

export interface TelegramChannelOptions {
  ingestionOnErrorDelayMs?: number;
  ingestionOnEmptyDelayMs?: number;
  deliveryMaxBatch?: number;
  deliveryLeaseSeconds?: number;
  deliveryMaxAttempts?: number;
  deliveryOnErrorDelayMs?: number;
  deliveryOnEmptyDelayMs?: number;
}

async function sendChunk(
  botToken: string,
  topic: TelegramTopic,
  chunk: string,
  parseMode?: string,
): Promise<void> {
  await sendMessage(botToken, topic.chatId, chunk, {
    threadId: topic.threadId,
    parseMode: parseMode,
  });
}

export class TelegramChannel implements Channel {
  readonly name = "telegram";
  readonly canReceive = true;
  readonly canDeliver = true;
  readonly mode = "realtime" as const;
  readonly priority = 0;

  private running = false;
  private ingestionDone: Promise<void> | null = null;
  private deliveryDone: Promise<void> | null = null;
  private abortController: AbortController | null = null;

  constructor(
    private config: CortexConfig,
    private options: TelegramChannelOptions = {},
    private thalamus?: Thalamus,
  ) {}

  async start(): Promise<void> {
    if (!this.config.telegramBotToken) {
      throw new Error("telegramBotToken is required for Telegram channel");
    }
    this.running = true;
    this.abortController = new AbortController();
    this.ingestionDone = this.runIngestion();
    this.deliveryDone = this.runDelivery();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    await Promise.all([this.deliveryDone, this.ingestionDone]);
    this.ingestionDone = null;
    this.deliveryDone = null;
    this.abortController = null;
  }

  async sync(): Promise<void> {
    // No-op for realtime channels
  }

  private async runIngestion(): Promise<void> {
    const botToken = this.config.telegramBotToken!;
    const allowedUserIds = new Set(this.config.telegramAllowedUserIds ?? []);
    const onErrorDelayMs = this.options.ingestionOnErrorDelayMs ?? 1000;
    const onEmptyDelayMs = this.options.ingestionOnEmptyDelayMs ?? 250;

    const cursorRow = getReceptorCursor("telegram");
    let offset: number | undefined = cursorRow
      ? Number(cursorRow.cursorValue)
      : undefined;
    if (offset !== undefined && !Number.isSafeInteger(offset)) {
      offset = undefined;
    }

    while (this.running) {
      try {
        const updates = await getUpdates(
          botToken,
          offset,
          20,
          this.abortController!.signal,
        );
        if (updates.length > 0) {
          log(`getUpdates: ${updates.length} updates`);
        }
        if (updates.length === 0) {
          if (this.running && onEmptyDelayMs > 0) {
            await Bun.sleep(onEmptyDelayMs);
          }
          continue;
        }

        let maxHandledUpdateId = -1;

        for (const update of updates) {
          let handledForCursor = true;

          const message = update.message;
          if (!message) {
            maxHandledUpdateId = update.update_id;
            continue;
          }

          const text = message.text;
          const fromId = message.from?.id;
          const chatId = message.chat?.id;
          if (
            typeof text !== "string" ||
            typeof fromId !== "number" ||
            typeof chatId !== "number"
          ) {
            maxHandledUpdateId = update.update_id;
            continue;
          }

          if (!allowedUserIds.has(fromId)) {
            log(`dropped message from unauthorized user ${fromId}`);
            maxHandledUpdateId = update.update_id;
            continue;
          }

          const externalMessageId = `${update.update_id}:${message.message_id}`;
          const topicKey =
            typeof message.message_thread_id === "number"
              ? `${chatId}:${message.message_thread_id}`
              : String(chatId);

          try {
            if (this.thalamus) {
              this.thalamus.receive({
                channel: "telegram",
                externalId: externalMessageId,
                data: {
                  text,
                  topicKey,
                  userId: String(fromId),
                  messageId: message.message_id,
                  chatId,
                },
                occurredAt: new Date(message.date * 1000).toISOString(),
              });
            } else {
              // Fallback: direct enqueue (should not happen in production)
              const { enqueueInboxMessage } = await import("../../db");
              enqueueInboxMessage({
                channel: "telegram",
                externalMessageId,
                topicKey,
                userId: String(fromId),
                text,
                occurredAt: message.date * 1000,
                idempotencyKey: externalMessageId,
              });
            }

            const preview = text.length > 60 ? `${text.slice(0, 57)}...` : text;
            log(`enqueued inbox [${topicKey}]: ${preview}`);
          } catch (enqueueErr) {
            handledForCursor = false;
            log(
              `failed to enqueue update ${update.update_id} (msg ${message.message_id}): ${enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)}`,
            );
          }

          if (!handledForCursor) {
            break;
          }

          maxHandledUpdateId = update.update_id;
        }

        if (maxHandledUpdateId >= 0) {
          offset = maxHandledUpdateId + 1;
          upsertReceptorCursor("telegram", String(offset));
        }
      } catch (err) {
        const isExpectedStopCancellation =
          !this.running &&
          err instanceof TelegramApiError &&
          err.message.includes("request canceled");
        if (isExpectedStopCancellation) {
          continue;
        }

        log(
          `telegram ingestion loop error: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (this.running && onErrorDelayMs > 0) {
          await Bun.sleep(onErrorDelayMs);
        }
      }
    }
  }

  private async runDelivery(): Promise<void> {
    const botToken = this.config.telegramBotToken!;
    const maxBatch =
      this.options.deliveryMaxBatch ?? this.config.outboxPollDefaultBatch;
    const leaseSeconds =
      this.options.deliveryLeaseSeconds ?? this.config.outboxLeaseSeconds;
    const maxAttempts =
      this.options.deliveryMaxAttempts ?? this.config.outboxMaxAttempts;
    const onErrorDelayMs = this.options.deliveryOnErrorDelayMs ?? 1000;
    const onEmptyDelayMs = this.options.deliveryOnEmptyDelayMs ?? 250;

    while (this.running) {
      try {
        const messages = pollOutboxMessages(
          "telegram",
          maxBatch,
          leaseSeconds,
          maxAttempts,
        );

        if (messages.length === 0) {
          if (this.running && onEmptyDelayMs > 0) {
            await Bun.sleep(onEmptyDelayMs);
          }
          continue;
        }

        for (const message of messages) {
          try {
            const topic = parseTelegramTopicKey(message.topicKey);
            if (!topic) {
              throw new Error(
                `Invalid telegram topic key: ${message.topicKey}`,
              );
            }

            const convertedText = formatForTelegram(message.text);
            const chunks = chunkMarkdownV2(convertedText);
            for (const chunk of chunks) {
              await sendChunk(botToken, topic, chunk, "MarkdownV2");
            }

            const ackResult = ackOutboxMessage(
              message.messageId,
              message.leaseToken,
            );
            if (
              ackResult === "delivered" ||
              ackResult === "already_delivered"
            ) {
              log(`delivered [${message.topicKey}] (${chunks.length} chunks)`);
            } else if (ackResult === "lease_conflict") {
              log(
                `ack lease_conflict for [${message.topicKey}] (messageId=${message.messageId}) — lease may have expired during slow delivery`,
              );
            } else if (ackResult === "not_found") {
              log(
                `ack not_found for [${message.topicKey}] (messageId=${message.messageId}) — message disappeared during delivery`,
              );
            }
          } catch (err) {
            log(
              `telegram delivery message failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } catch (err) {
        log(
          `telegram delivery loop error: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (this.running && onErrorDelayMs > 0) {
          await Bun.sleep(onErrorDelayMs);
        }
      }
    }
  }
}
