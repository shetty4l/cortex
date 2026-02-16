/**
 * HTTP server for Cortex.
 *
 * Routes:
 *   GET  /health      — health check for Wilson integration
 *   POST /ingest      — channel-agnostic event ingress
 *   POST /outbox/poll — connector delivery claim
 *   POST /outbox/ack  — connector delivery acknowledgement
 */

import { timingSafeEqual } from "crypto";
import type { CortexConfig } from "./config";
import {
  ackOutboxMessage,
  enqueueInboxMessage,
  findInboxDuplicate,
  pollOutboxMessages,
} from "./db";
import { VERSION } from "./version";

const startedAt = Date.now();

// --- Helpers ---

function jsonResponse(
  body: unknown,
  status: number,
  headers?: Record<string, string>,
): Response {
  return Response.json(body, { status, headers });
}

function requireAuth(req: Request, config: CortexConfig): Response | null {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const token = authHeader.slice("Bearer ".length);
  const expected = config.ingestApiKey;

  // Constant-time comparison to prevent timing attacks.
  // Buffer lengths may differ; check length first (leaks length, not content).
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.byteLength !== b.byteLength || !timingSafeEqual(a, b)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  return null;
}

// --- Route handlers ---

function handleHealth(): Response {
  const uptime = Math.floor((Date.now() - startedAt) / 1000);
  return jsonResponse({ status: "healthy", version: VERSION, uptime }, 200);
}

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
    return jsonResponse(
      {
        error: "invalid_request",
        details: ["Request body must be valid JSON"],
      },
      400,
    );
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonResponse(
      {
        error: "invalid_request",
        details: ["Request body must be a JSON object"],
      },
      400,
    );
  }

  const details = validateIngestBody(body);
  if (details.length > 0) {
    return jsonResponse({ error: "invalid_request", details }, 400);
  }

  // Dedup check (optimistic — avoids insert overhead in common case)
  const existingId = findInboxDuplicate(body.source!, body.externalMessageId!);
  if (existingId) {
    return jsonResponse(
      { eventId: existingId, status: "duplicate_ignored" },
      200,
    );
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
    return jsonResponse(
      { eventId: result.eventId, status: "duplicate_ignored" },
      200,
    );
  }

  return jsonResponse({ eventId: result.eventId, status: "queued" }, 202);
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
    return jsonResponse(
      {
        error: "invalid_request",
        details: ["Request body must be valid JSON"],
      },
      400,
    );
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonResponse(
      {
        error: "invalid_request",
        details: ["Request body must be a JSON object"],
      },
      400,
    );
  }

  const details = validatePollBody(body);
  if (details.length > 0) {
    return jsonResponse({ error: "invalid_request", details }, 400);
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

  return jsonResponse({ messages }, 200);
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
    return jsonResponse(
      {
        error: "invalid_request",
        details: ["Request body must be valid JSON"],
      },
      400,
    );
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonResponse(
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
    return jsonResponse({ error: "invalid_request", details }, 400);
  }

  const result = ackOutboxMessage(body.messageId!, body.leaseToken!);

  switch (result) {
    case "delivered":
      return jsonResponse({ ok: true, status: "delivered" }, 200);
    case "already_delivered":
      return jsonResponse({ ok: true, status: "already_delivered" }, 200);
    case "not_found":
      return jsonResponse({ error: "not_found" }, 404);
    case "lease_conflict":
      return jsonResponse({ error: "lease_conflict" }, 409);
  }
}

// --- Server ---

export interface CortexServer {
  start(): ReturnType<typeof Bun.serve>;
  readonly config: CortexConfig;
}

export function createServer(config: CortexConfig): CortexServer {
  async function handleRequest(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/health") {
        return handleHealth();
      }

      if (req.method === "POST" && url.pathname === "/ingest") {
        return handleIngest(req, config);
      }

      if (req.method === "POST" && url.pathname === "/outbox/poll") {
        return handleOutboxPoll(req, config);
      }

      if (req.method === "POST" && url.pathname === "/outbox/ack") {
        return handleOutboxAck(req, config);
      }

      return jsonResponse({ error: "not_found" }, 404);
    } catch (err) {
      console.error("Unhandled error in request handler:", err);
      return jsonResponse({ error: "internal_error" }, 500);
    }
  }

  return {
    config,
    start() {
      const server = Bun.serve({
        hostname: config.host,
        port: config.port,
        fetch: handleRequest,
      });

      console.log(`Cortex listening on http://${config.host}:${server.port}`);

      return server;
    },
  };
}
