/**
 * HTTP server for Cortex.
 *
 * Currently serves:
 *   GET /health — health check for Wilson integration
 *
 * Future slices add:
 *   POST /ingest — channel-agnostic event ingress
 *   POST /outbox/poll — connector delivery claim
 *   POST /outbox/ack — connector delivery acknowledgement
 */

import type { CortexConfig } from "./config";
import { VERSION } from "./version";

const startedAt = Date.now();

function healthResponse(): Response {
  const uptime = Math.floor((Date.now() - startedAt) / 1000);
  return Response.json({
    status: "healthy",
    version: VERSION,
    uptime,
  });
}

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

function handleRequest(req: Request): Response {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/health") {
    return healthResponse();
  }

  return notFound();
}

export interface CortexServer {
  start(): ReturnType<typeof Bun.serve>;
  readonly config: CortexConfig;
}

export function createServer(config: CortexConfig): CortexServer {
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
