import { afterEach, describe, expect, test } from "bun:test";
import { getUpdates, sendMessage, TelegramApiError } from "../src/telegram";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("telegram client", () => {
  test("getUpdates calls Telegram API with message-only updates", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = (async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedInit = init;
      return Response.json({ ok: true, result: [{ update_id: 11 }] });
    }) as unknown as typeof fetch;

    const result = await getUpdates("123:abc", 42, 15);

    expect(result).toEqual([{ update_id: 11 }]);
    expect(capturedUrl).toBe("https://api.telegram.org/bot123:abc/getUpdates");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toEqual({
      "Content-Type": "application/json",
    });
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(String(capturedInit?.body)) as Record<
      string,
      unknown
    >;
    expect(body.offset).toBe(42);
    expect(body.timeout).toBe(15);
    expect(body.allowed_updates).toEqual(["message"]);
  });

  test("getUpdates defaults timeout to 20 and omits offset", async () => {
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = (async (_url: any, init: any) => {
      capturedInit = init;
      return Response.json({ ok: true, result: [] });
    }) as unknown as typeof fetch;

    await getUpdates("123:abc");

    const body = JSON.parse(String(capturedInit?.body)) as Record<
      string,
      unknown
    >;
    expect(body.timeout).toBe(20);
    expect(body.allowed_updates).toEqual(["message"]);
    expect(body).not.toHaveProperty("offset");
  });

  test("sendMessage calls Telegram API with mapped optional fields", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = (async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedInit = init;
      return Response.json({
        ok: true,
        result: {
          message_id: 99,
          date: 123456,
          chat: { id: 555 },
          text: "hello",
          message_thread_id: 7,
        },
      });
    }) as unknown as typeof fetch;

    const result = await sendMessage("123:abc", 555, "hello", {
      threadId: 7,
      parseMode: "MarkdownV2",
    });

    expect(result.message_id).toBe(99);
    expect(capturedUrl).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(capturedInit?.method).toBe("POST");

    const body = JSON.parse(String(capturedInit?.body)) as Record<
      string,
      unknown
    >;
    expect(body.chat_id).toBe(555);
    expect(body.text).toBe("hello");
    expect(body.message_thread_id).toBe(7);
    expect(body.parse_mode).toBe("MarkdownV2");
  });

  test("throws TelegramApiError for non-2xx response", async () => {
    globalThis.fetch = (async () =>
      new Response("bad request details", {
        status: 400,
        statusText: "Bad",
      })) as unknown as typeof fetch;

    try {
      await sendMessage("123:abc", 555, "hello");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TelegramApiError);
      const err = e as TelegramApiError;
      expect(err.method).toBe("sendMessage");
      expect(err.statusCode).toBe(400);
      expect(err.message).toContain("sendMessage");
      expect(err.message).toContain("bad request details");
    }
  });

  test("throws TelegramApiError on timeout", async () => {
    globalThis.fetch = (async () => {
      throw new DOMException("Timed out", "TimeoutError");
    }) as unknown as typeof fetch;

    try {
      await getUpdates("123:abc", undefined, 1);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TelegramApiError);
      const err = e as TelegramApiError;
      expect(err.method).toBe("getUpdates");
      expect(err.statusCode).toBe(0);
      expect(err.message).toContain("timed out");
    }
  });
});
