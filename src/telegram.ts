import { createLogger } from "@shetty4l/core/log";
import type { CortexConfig } from "./config";
import {
  ackOutboxMessage,
  enqueueInboxMessage,
  getTelegramOffset,
  pollOutboxMessages,
  setTelegramOffset,
} from "./db";

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const log = createLogger("cortex");

type TelegramApiEnvelope<T> = {
  ok?: boolean;
  result?: T;
  description?: string;
  error_code?: number;
};

export interface TelegramMessage {
  message_id: number;
  date: number;
  from?: {
    id: number;
  };
  chat: {
    id: number;
  };
  text?: string;
  message_thread_id?: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface SendMessageOptions {
  threadId?: number;
  parseMode?: string;
}

export interface TelegramIngestionLoop {
  stop(): Promise<void>;
}

export interface TelegramIngestionLoopOptions {
  onErrorDelayMs?: number;
  onEmptyDelayMs?: number;
}

export interface TelegramDeliveryLoop {
  stop(): Promise<void>;
}

export interface TelegramDeliveryLoopOptions {
  maxBatch?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  onErrorDelayMs?: number;
  onEmptyDelayMs?: number;
}

export class TelegramApiError extends Error {
  readonly statusCode: number;
  readonly method: string;

  constructor(method: string, statusCode: number, message: string) {
    super(message);
    this.name = "TelegramApiError";
    this.method = method;
    this.statusCode = statusCode;
  }
}

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

export interface TelegramTopic {
  chatId: number;
  threadId?: number;
}

export function parseTelegramTopicKey(topicKey: string): TelegramTopic | null {
  const parts = topicKey.split(":");
  if (parts.length !== 1 && parts.length !== 2) {
    return null;
  }

  const parseInteger = (raw: string): number | null => {
    if (!/^-?\d+$/.test(raw)) {
      return null;
    }
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  };

  const chatId = parseInteger(parts[0]);
  if (chatId === null) {
    return null;
  }

  if (parts.length === 1) {
    return { chatId };
  }

  const threadId = parseInteger(parts[1]);
  if (threadId === null) {
    return null;
  }

  return { chatId, threadId };
}

function takeChunk(input: string, maxLength: number): string {
  if (input.length <= maxLength) {
    return input;
  }

  for (const boundary of ["\n\n", "\n", " "]) {
    const maxBoundaryStart = maxLength - boundary.length;
    if (maxBoundaryStart < 0) {
      continue;
    }

    const splitAt = input.lastIndexOf(boundary, maxBoundaryStart);
    if (splitAt > 0) {
      return input.slice(0, splitAt + boundary.length);
    }
  }

  return input.slice(0, maxLength);
}

export function splitTelegramMessageText(
  text: string,
  maxLength = TELEGRAM_MAX_MESSAGE_LENGTH,
): string[] {
  const chunkLimit =
    Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : 1;

  if (text.length <= chunkLimit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let chunk = takeChunk(remaining, chunkLimit);
    if (chunk.length === 0) {
      chunk = remaining.slice(0, chunkLimit);
    }
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  return chunks;
}

function summarizeBody(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return "(empty response body)";
  return compact.slice(0, 300);
}

async function callTelegramApi<T>(
  botToken: string,
  method: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  const url = `${TELEGRAM_API_BASE_URL}/bot${botToken}/${method}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const isTimeout =
      e instanceof Error &&
      (e.name === "TimeoutError" || e.name === "AbortError");
    if (isTimeout) {
      throw new TelegramApiError(
        method,
        0,
        `Telegram ${method} request timed out after ${timeoutMs}ms`,
      );
    }

    throw new TelegramApiError(
      method,
      0,
      `Telegram ${method} request failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (e) {
    throw new TelegramApiError(
      method,
      response.status,
      `Telegram ${method} response read failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!response.ok) {
    throw new TelegramApiError(
      method,
      response.status,
      `Telegram ${method} returned ${response.status}: ${summarizeBody(bodyText)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new TelegramApiError(
      method,
      response.status,
      `Telegram ${method} returned invalid JSON`,
    );
  }

  const envelope = parsed as TelegramApiEnvelope<T>;
  if (envelope.ok !== true) {
    const statusCode =
      typeof envelope.error_code === "number"
        ? envelope.error_code
        : response.status;
    const detail =
      typeof envelope.description === "string"
        ? envelope.description
        : "unknown Telegram API error";
    throw new TelegramApiError(
      method,
      statusCode,
      `Telegram ${method} error: ${detail}`,
    );
  }

  return envelope.result as T;
}

export async function getUpdates(
  botToken: string,
  offset?: number,
  timeoutSec = 20,
): Promise<TelegramUpdate[]> {
  const payload: Record<string, unknown> = {
    timeout: timeoutSec,
    allowed_updates: ["message"],
  };
  if (offset !== undefined) {
    payload.offset = offset;
  }

  const requestTimeoutMs = Math.max(5000, (timeoutSec + 10) * 1000);
  return callTelegramApi<TelegramUpdate[]>(
    botToken,
    "getUpdates",
    payload,
    requestTimeoutMs,
  );
}

export async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
  opts: SendMessageOptions = {},
): Promise<TelegramMessage> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
  };
  if (opts.threadId !== undefined) {
    payload.message_thread_id = opts.threadId;
  }
  if (opts.parseMode !== undefined) {
    payload.parse_mode = opts.parseMode;
  }

  return callTelegramApi<TelegramMessage>(
    botToken,
    "sendMessage",
    payload,
    15000,
  );
}

export function startTelegramIngestionLoop(
  config: CortexConfig,
  options?: TelegramIngestionLoopOptions,
): TelegramIngestionLoop {
  if (!config.telegramBotToken) {
    throw new Error("telegramBotToken is required for Telegram ingestion loop");
  }

  const botToken = config.telegramBotToken;
  const allowedUserIds = new Set(config.telegramAllowedUserIds ?? []);
  const onErrorDelayMs = options?.onErrorDelayMs ?? 1000;
  const onEmptyDelayMs = options?.onEmptyDelayMs ?? 250;

  let running = true;
  let offset = getTelegramOffset(botToken) ?? undefined;

  const done = (async () => {
    while (running) {
      try {
        const updates = await getUpdates(botToken, offset, 20);
        if (updates.length > 0) {
          log(`getUpdates: ${updates.length} updates`);
        }
        if (updates.length === 0) {
          if (running && onEmptyDelayMs > 0) {
            await Bun.sleep(onEmptyDelayMs);
          }
          continue;
        }

        let maxUpdateId = -1;

        for (const update of updates) {
          if (update.update_id > maxUpdateId) {
            maxUpdateId = update.update_id;
          }

          const message = update.message;
          if (!message) continue;

          const text = message.text;
          const fromId = message.from?.id;
          const chatId = message.chat?.id;
          if (
            typeof text !== "string" ||
            typeof fromId !== "number" ||
            typeof chatId !== "number"
          ) {
            continue;
          }

          if (!allowedUserIds.has(fromId)) {
            log(`dropped message from unauthorized user ${fromId}`);
            continue;
          }

          const externalMessageId = `${update.update_id}:${message.message_id}`;
          const topicKey =
            typeof message.message_thread_id === "number"
              ? `${chatId}:${message.message_thread_id}`
              : String(chatId);

          enqueueInboxMessage({
            source: "telegram",
            externalMessageId,
            topicKey,
            userId: String(fromId),
            text,
            occurredAt: message.date * 1000,
            idempotencyKey: externalMessageId,
          });

          const preview = text.length > 60 ? `${text.slice(0, 57)}...` : text;
          log(`enqueued inbox [${topicKey}]: ${preview}`);
        }

        if (maxUpdateId >= 0) {
          offset = maxUpdateId + 1;
          setTelegramOffset(offset, botToken);
        }
      } catch (err) {
        log(
          `telegram ingestion loop error: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (running && onErrorDelayMs > 0) {
          await Bun.sleep(onErrorDelayMs);
        }
      }
    }
  })();

  return {
    async stop() {
      running = false;
      await done;
    },
  };
}

async function sendChunk(
  botToken: string,
  topic: TelegramTopic,
  chunk: string,
): Promise<void> {
  await sendMessage(botToken, topic.chatId, chunk, {
    threadId: topic.threadId,
  });
}

export function startTelegramDeliveryLoop(
  config: CortexConfig,
  options?: TelegramDeliveryLoopOptions,
): TelegramDeliveryLoop {
  if (!config.telegramBotToken) {
    throw new Error("telegramBotToken is required for Telegram delivery loop");
  }

  const botToken = config.telegramBotToken;
  const maxBatch = options?.maxBatch ?? config.outboxPollDefaultBatch;
  const leaseSeconds = options?.leaseSeconds ?? config.outboxLeaseSeconds;
  const maxAttempts = options?.maxAttempts ?? config.outboxMaxAttempts;
  const onErrorDelayMs = options?.onErrorDelayMs ?? 1000;
  const onEmptyDelayMs = options?.onEmptyDelayMs ?? 250;

  let running = true;

  const done = (async () => {
    while (running) {
      try {
        const messages = pollOutboxMessages(
          "telegram",
          maxBatch,
          leaseSeconds,
          maxAttempts,
        );

        if (messages.length === 0) {
          if (running && onEmptyDelayMs > 0) {
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

            const chunks = splitTelegramMessageText(message.text);
            for (const chunk of chunks) {
              await sendChunk(botToken, topic, chunk);
            }

            ackOutboxMessage(message.messageId, message.leaseToken);
            log(`delivered [${message.topicKey}] (${chunks.length} chunks)`);
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
        if (running && onErrorDelayMs > 0) {
          await Bun.sleep(onErrorDelayMs);
        }
      }
    }
  })();

  return {
    async stop() {
      running = false;
      await done;
    },
  };
}
