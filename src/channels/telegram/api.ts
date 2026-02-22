import { createLogger } from "@shetty4l/core/log";

const log = createLogger("cortex");

export const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

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

function summarizeBody(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return "(empty response body)";
  return compact.slice(0, 300);
}

export async function callTelegramApi<T>(
  botToken: string,
  method: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const url = `${TELEGRAM_API_BASE_URL}/bot${botToken}/${method}`;

  let response: Response;
  try {
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (signal) {
      signals.push(signal);
    }
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.any(signals),
    });
  } catch (e) {
    if (
      e instanceof Error &&
      e.name === "AbortError" &&
      signal?.aborted === true
    ) {
      throw new TelegramApiError(
        method,
        0,
        `Telegram ${method} request canceled`,
      );
    }

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
  signal?: AbortSignal,
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
    signal,
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
