/**
 * HTTP server for Cortex.
 *
 * Routes:
 *   GET  /health      — health check (handled by core)
 *   POST /ingest      — DEPRECATED (returns 410 Gone)
 *   POST /receive     — thalamus-gated event ingress
 *   POST /outbox/poll — connector delivery claim
 *   POST /outbox/ack  — connector delivery acknowledgement
 */

import {
  createServer,
  type HttpServer,
  jsonError,
  jsonOk,
} from "@shetty4l/core/http";
import { createLogger } from "@shetty4l/core/log";
import { timingSafeEqual } from "crypto";
import type { CortexConfig } from "./config";
import { ackOutboxMessage, pollOutboxMessages } from "./db";
import type { Thalamus } from "./thalamus";
import { VERSION } from "./version";

const log = createLogger("cortex");

// --- Helpers ---

function requireAuth(req: Request, config: CortexConfig): Response | null {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonError(401, "unauthorized");
  }

  const token = authHeader.slice("Bearer ".length);
  const expected = config.ingestApiKey;

  // Constant-time comparison to prevent timing attacks.
  // Buffer lengths may differ; check length first (leaks length, not content).
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.byteLength !== b.byteLength || !timingSafeEqual(a, b)) {
    return jsonError(401, "unauthorized");
  }

  return null;
}

// --- Route handlers ---

// --- POST /ingest (DEPRECATED) ---

function handleIngestDeprecated(): Response {
  return jsonOk(
    {
      error: "POST /ingest has been removed. Use POST /receive instead.",
    },
    410,
  );
}

// --- POST /receive handler ---

interface ReceiveRequestBody {
  channel?: unknown;
  externalId?: unknown;
  data?: unknown;
  occurredAt?: unknown;
  metadata?: unknown;
}

function validateReceiveBody(body: ReceiveRequestBody): string[] {
  const details: string[] = [];

  if (body.channel === undefined || body.channel === null) {
    details.push("channel is required");
  } else if (typeof body.channel !== "string" || body.channel.length === 0) {
    details.push("channel must be a non-empty string");
  }

  if (body.externalId === undefined || body.externalId === null) {
    details.push("externalId is required");
  } else if (
    typeof body.externalId !== "string" ||
    body.externalId.length === 0
  ) {
    details.push("externalId must be a non-empty string");
  }

  if (body.data === undefined || body.data === null) {
    details.push("data is required");
  }

  if (body.occurredAt === undefined || body.occurredAt === null) {
    details.push("occurredAt is required");
  } else if (
    typeof body.occurredAt !== "string" ||
    body.occurredAt.length === 0
  ) {
    details.push("occurredAt must be a non-empty string");
  } else {
    const ts = new Date(body.occurredAt).getTime();
    if (Number.isNaN(ts)) {
      details.push("occurredAt must be a valid ISO 8601 date string");
    }
  }

  if (
    body.metadata !== undefined &&
    body.metadata !== null &&
    (typeof body.metadata !== "object" || Array.isArray(body.metadata))
  ) {
    details.push("metadata must be an object");
  }

  return details;
}

async function handleReceive(
  req: Request,
  config: CortexConfig,
  thalamus: Thalamus,
): Promise<Response> {
  const authError = requireAuth(req, config);
  if (authError) return authError;

  let body: ReceiveRequestBody;
  try {
    body = (await req.json()) as ReceiveRequestBody;
  } catch {
    return jsonOk(
      {
        error: "invalid_request",
        details: ["Request body must be valid JSON"],
      },
      400,
    );
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonOk(
      {
        error: "invalid_request",
        details: ["Request body must be a JSON object"],
      },
      400,
    );
  }

  const details = validateReceiveBody(body);
  if (details.length > 0) {
    return jsonOk({ error: "invalid_request", details }, 400);
  }

  const result = thalamus.receive({
    channel: body.channel as string,
    externalId: body.externalId as string,
    data: body.data,
    occurredAt: body.occurredAt as string,
    metadata: body.metadata as Record<string, unknown> | undefined,
  });

  if (result.duplicate) {
    return jsonOk(
      { eventId: result.eventId, status: "duplicate_ignored" },
      200,
    );
  }

  return jsonOk({ eventId: result.eventId, status: "queued" }, 202);
}

// --- Outbox poll/ack handlers ---

interface PollRequestBody {
  channel?: string;
  topicKey?: string;
  max?: number;
  leaseSeconds?: number;
}

function validatePollBody(body: PollRequestBody): string[] {
  const details: string[] = [];

  if (body.channel === undefined || body.channel === null) {
    details.push("channel is required");
  } else if (typeof body.channel !== "string" || body.channel.length === 0) {
    details.push("channel must be a non-empty string");
  }

  if (
    body.topicKey !== undefined &&
    body.topicKey !== null &&
    (typeof body.topicKey !== "string" || body.topicKey.length === 0)
  ) {
    details.push("topicKey must be a non-empty string");
  }

  if (body.max !== undefined && body.max !== null) {
    if (typeof body.max !== "number" || !Number.isInteger(body.max)) {
      details.push("max must be an integer");
    } else if (body.max < 1 || body.max > 100) {
      details.push("max must be between 1 and 100");
    }
  }

  if (body.leaseSeconds !== undefined && body.leaseSeconds !== null) {
    if (
      typeof body.leaseSeconds !== "number" ||
      !Number.isInteger(body.leaseSeconds)
    ) {
      details.push("leaseSeconds must be an integer");
    } else if (body.leaseSeconds < 10 || body.leaseSeconds > 300) {
      details.push("leaseSeconds must be between 10 and 300");
    }
  }

  return details;
}

async function handleOutboxPoll(
  req: Request,
  config: CortexConfig,
): Promise<Response> {
  const authError = requireAuth(req, config);
  if (authError) return authError;

  let body: PollRequestBody;
  try {
    body = (await req.json()) as PollRequestBody;
  } catch {
    return jsonOk(
      {
        error: "invalid_request",
        details: ["Request body must be valid JSON"],
      },
      400,
    );
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonOk(
      {
        error: "invalid_request",
        details: ["Request body must be a JSON object"],
      },
      400,
    );
  }

  const details = validatePollBody(body);
  if (details.length > 0) {
    return jsonOk({ error: "invalid_request", details }, 400);
  }

  const max = body.max ?? config.outboxPollDefaultBatch;
  const leaseSeconds = body.leaseSeconds ?? config.outboxLeaseSeconds;

  const messages = pollOutboxMessages(
    body.channel!,
    max,
    leaseSeconds,
    config.outboxMaxAttempts,
    body.topicKey ?? undefined,
  );

  return jsonOk({ messages }, 200);
}

interface AckRequestBody {
  messageId?: string;
  leaseToken?: string;
}

async function handleOutboxAck(
  req: Request,
  config: CortexConfig,
): Promise<Response> {
  const authError = requireAuth(req, config);
  if (authError) return authError;

  let body: AckRequestBody;
  try {
    body = (await req.json()) as AckRequestBody;
  } catch {
    return jsonOk(
      {
        error: "invalid_request",
        details: ["Request body must be valid JSON"],
      },
      400,
    );
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonOk(
      {
        error: "invalid_request",
        details: ["Request body must be a JSON object"],
      },
      400,
    );
  }

  const details: string[] = [];
  if (
    body.messageId === undefined ||
    body.messageId === null ||
    typeof body.messageId !== "string" ||
    body.messageId.length === 0
  ) {
    details.push("messageId is required");
  }
  if (
    body.leaseToken === undefined ||
    body.leaseToken === null ||
    typeof body.leaseToken !== "string" ||
    body.leaseToken.length === 0
  ) {
    details.push("leaseToken is required");
  }
  if (details.length > 0) {
    return jsonOk({ error: "invalid_request", details }, 400);
  }

  const result = ackOutboxMessage(body.messageId!, body.leaseToken!);

  switch (result) {
    case "delivered":
      return jsonOk({ ok: true, status: "delivered" }, 200);
    case "already_delivered":
      return jsonOk({ ok: true, status: "already_delivered" }, 200);
    case "not_found":
      return jsonOk({ error: "not_found" }, 404);
    case "lease_conflict":
      return jsonOk({ error: "lease_conflict" }, 409);
  }
}

// --- Server ---

export function startServer(
  config: CortexConfig,
  thalamus?: Thalamus,
): HttpServer {
  return createServer({
    name: "cortex",
    port: config.port,
    host: config.host,
    version: VERSION,
    onRequest: async (req: Request, url: URL) => {
      const start = performance.now();
      let response: Response | null = null;

      if (req.method === "POST" && url.pathname === "/ingest") {
        response = handleIngestDeprecated();
      } else if (req.method === "POST" && url.pathname === "/receive") {
        if (!thalamus) {
          response = jsonError(503, "Thalamus not initialized");
        } else {
          response = await handleReceive(req, config, thalamus);
        }
      } else if (req.method === "POST" && url.pathname === "/outbox/poll") {
        response = await handleOutboxPoll(req, config);
      } else if (req.method === "POST" && url.pathname === "/outbox/ack") {
        response = await handleOutboxAck(req, config);
      }

      if (response) {
        const latency = (performance.now() - start).toFixed(0);
        log(`${req.method} ${url.pathname} ${response.status} ${latency}ms`);
      }

      return response;
    },
  });
}
