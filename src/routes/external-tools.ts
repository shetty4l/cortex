/**
 * External tool registration HTTP handlers.
 *
 * Routes:
 *   POST   /tools/external/register           — Register/update an external tool provider
 *   DELETE /tools/external/unregister/:id     — Unregister a provider by ID
 *   POST   /tools/external/heartbeat/:id      — Update provider heartbeat timestamp
 */

import { jsonOk } from "@shetty4l/core/http";
import type { StateLoader } from "@shetty4l/core/state";
import {
  createProvider,
  deleteProvider,
  getProvider,
  updateHeartbeat,
  updateProvider,
} from "../tools/external-provider";

// --- Request body types ---

interface RegisterRequestBody {
  providerId?: unknown;
  callbackUrl?: unknown;
  authHeader?: unknown;
  tools?: unknown;
}

// --- Validation helpers ---

function validateRegisterBody(body: RegisterRequestBody): string[] {
  const details: string[] = [];

  if (body.providerId === undefined || body.providerId === null) {
    details.push("providerId is required");
  } else if (
    typeof body.providerId !== "string" ||
    body.providerId.length === 0
  ) {
    details.push("providerId must be a non-empty string");
  }

  if (body.callbackUrl === undefined || body.callbackUrl === null) {
    details.push("callbackUrl is required");
  } else if (
    typeof body.callbackUrl !== "string" ||
    body.callbackUrl.length === 0
  ) {
    details.push("callbackUrl must be a non-empty string");
  } else {
    try {
      new URL(body.callbackUrl);
    } catch {
      details.push("callbackUrl must be a valid URL");
    }
  }

  if (
    body.authHeader !== undefined &&
    body.authHeader !== null &&
    typeof body.authHeader !== "string"
  ) {
    details.push("authHeader must be a string");
  }

  if (body.tools === undefined || body.tools === null) {
    details.push("tools is required");
  } else if (!Array.isArray(body.tools)) {
    details.push("tools must be an array");
  } else {
    for (let i = 0; i < body.tools.length; i++) {
      const tool = body.tools[i];
      if (typeof tool !== "object" || tool === null) {
        details.push(`tools[${i}] must be an object`);
        continue;
      }
      if (typeof tool.name !== "string" || tool.name.length === 0) {
        details.push(`tools[${i}].name must be a non-empty string`);
      }
    }
  }

  return details;
}

// --- Route handlers ---

/**
 * POST /tools/external/register
 *
 * Registers or updates an external tool provider. Idempotent by providerId.
 */
export async function handleRegister(
  req: Request,
  stateLoader: StateLoader,
): Promise<Response> {
  let body: RegisterRequestBody;
  try {
    body = (await req.json()) as RegisterRequestBody;
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

  const details = validateRegisterBody(body);
  if (details.length > 0) {
    return jsonOk({ error: "invalid_request", details }, 400);
  }

  const providerId = body.providerId as string;
  const callbackUrl = body.callbackUrl as string;
  const authHeader = (body.authHeader as string | undefined) ?? null;
  const tools = body.tools as Array<{ name: string }>;
  const toolsJson = JSON.stringify(tools);

  // Check if provider already exists (idempotent update)
  const existing = getProvider(stateLoader, providerId);
  if (existing) {
    await updateProvider(stateLoader, providerId, {
      callbackUrl,
      authHeader,
      toolsJson,
    });
  } else {
    const provider = createProvider(stateLoader, {
      providerId,
      callbackUrl,
      authHeader: authHeader ?? undefined,
      toolsJson,
    });
    await provider.save();
  }

  return jsonOk({ success: true, toolCount: tools.length }, 200);
}

/**
 * DELETE /tools/external/unregister/:providerId
 *
 * Unregisters an external tool provider.
 */
export async function handleUnregister(
  providerId: string,
  stateLoader: StateLoader,
): Promise<Response> {
  const deleted = await deleteProvider(stateLoader, providerId);
  if (!deleted) {
    return jsonOk({ error: "not_found" }, 404);
  }

  return jsonOk({ success: true }, 200);
}

/**
 * POST /tools/external/heartbeat/:providerId
 *
 * Updates the heartbeat timestamp for a provider.
 */
export async function handleHeartbeat(
  providerId: string,
  stateLoader: StateLoader,
): Promise<Response> {
  const provider = await updateHeartbeat(stateLoader, providerId);
  if (!provider) {
    return jsonOk({ error: "not_found" }, 404);
  }

  return jsonOk({ success: true }, 200);
}

/**
 * Route external tools requests.
 *
 * Returns a Response if the request matches an external tools route,
 * or null if the request should be handled by other routes.
 */
export async function routeExternalTools(
  req: Request,
  url: URL,
  stateLoader: StateLoader,
): Promise<Response | null> {
  const path = url.pathname;

  // POST /tools/external/register
  if (req.method === "POST" && path === "/tools/external/register") {
    return handleRegister(req, stateLoader);
  }

  // DELETE /tools/external/unregister/:providerId
  if (
    req.method === "DELETE" &&
    path.startsWith("/tools/external/unregister/")
  ) {
    const providerId = path.slice("/tools/external/unregister/".length);
    if (!providerId) {
      return jsonOk(
        { error: "invalid_request", details: ["providerId is required"] },
        400,
      );
    }
    return handleUnregister(providerId, stateLoader);
  }

  // POST /tools/external/heartbeat/:providerId
  if (req.method === "POST" && path.startsWith("/tools/external/heartbeat/")) {
    const providerId = path.slice("/tools/external/heartbeat/".length);
    if (!providerId) {
      return jsonOk(
        { error: "invalid_request", details: ["providerId is required"] },
        400,
      );
    }
    return handleHeartbeat(providerId, stateLoader);
  }

  return null;
}
