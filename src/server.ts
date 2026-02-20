/**
 * HTTP server for Cortex.
 *
 * Routes:
 *   GET  /health      — health check (handled by core)
 *   POST /ingest      — channel-agnostic event ingress
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
import { readVersion } from "@shetty4l/core/version";
import { timingSafeEqual } from "crypto";
import { join } from "path";
import type { CortexConfig } from "./config";
import {
  ackOutboxMessage,
  enqueueInboxMessage,
  findInboxDuplicate,
  pollOutboxMessages,
} from "./db";

const VERSION = readVersion(join(import.meta.dir, ".."));
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

interface IngestRequestBody {
  source?: string;
  externalMessageId?: string;
  idempotencyKey?: string;
  topicKey?: string;
  userId?: string;
  text?: string;
  occurredAt?: string;
  metadata?: Record<string, unknown>;
}

function validateIngestBody(body: IngestRequestBody): string[] {
  const details: string[] = [];
  const requiredStringFields: Array<{
    key: keyof IngestRequestBody;
    label: string;
  }> = [
    { key: "source", label: "source" },
    { key: "externalMessageId", label: "externalMessageId" },
    { key: "idempotencyKey", label: "idempotencyKey" },
    { key: "topicKey", label: "topicKey" },
    { key: "userId", label: "userId" },
    { key: "text", label: "text" },
    { key: "occurredAt", label: "occurredAt" },
  ];

  for (const field of requiredStringFields) {
    const val = body[field.key];
    if (val === undefined || val === null) {
      details.push(`${field.label} is required`);
    } else if (typeof val !== "string" || val.length === 0) {
      details.push(`${field.label} must be a non-empty string`);
    }
  }

  if (
    body.occurredAt &&
    typeof body.occurredAt === "string" &&
    body.occurredAt.length > 0
  ) {
    const ts = new Date(body.occurredAt).getTime();
    if (Number.isNaN(ts)) {
      details.push("occurredAt must be a valid ISO 8601 date string");
    }
  }

  return details;
}

async function handleIngest(
  req: Request,
  config: CortexConfig,
): Promise<Response> {
  const authError = requireAuth(req, config);
  if (authError) return authError;

  let body: IngestRequestBody;
  try {
    body = (await req.json()) as IngestRequestBody;
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

  const details = validateIngestBody(body);
  if (details.length > 0) {
    return jsonOk({ error: "invalid_request", details }, 400);
  }

  // Dedup check (optimistic — avoids insert overhead in common case)
  const existingId = findInboxDuplicate(body.source!, body.externalMessageId!);
  if (existingId) {
    return jsonOk({ eventId: existingId, status: "duplicate_ignored" }, 200);
  }

  // Enqueue (catches UNIQUE constraint race if concurrent duplicate slips past)
  const result = enqueueInboxMessage({
    source: body.source!,
    externalMessageId: body.externalMessageId!,
    topicKey: body.topicKey!,
    userId: body.userId!,
    text: body.text!,
    occurredAt: new Date(body.occurredAt!).getTime(),
    idempotencyKey: body.idempotencyKey!,
    metadata: body.metadata,
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
  source?: string;
  topicKey?: string;
  max?: number;
  leaseSeconds?: number;
}

function validatePollBody(body: PollRequestBody): string[] {
  const details: string[] = [];

  if (body.source === undefined || body.source === null) {
    details.push("source is required");
  } else if (typeof body.source !== "string" || body.source.length === 0) {
    details.push("source must be a non-empty string");
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
    body.source!,
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

export function startServer(config: CortexConfig): HttpServer {
  return createServer({
    name: "cortex",
    port: config.port,
    host: config.host,
    version: VERSION,
    onRequest: async (req: Request, url: URL) => {
      const start = performance.now();
      let response: Response | null = null;

      if (req.method === "POST" && url.pathname === "/ingest") {
        response = await handleIngest(req, config);
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
