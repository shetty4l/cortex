/**
 * External tool provider storage model.
 *
 * Stores registrations from external services that provide tools to Cortex.
 * Each provider has a unique providerId and registers a set of tools as JSON.
 * Tools from registered providers are namespaced as {providerId}.{toolName}.
 */

import {
  CollectionEntity,
  CollectionField as Field,
  Id,
  Index,
  PersistedCollection,
  type StateLoader,
} from "@shetty4l/core/state";

/**
 * External tool provider entity persisted to SQLite via StateLoader.
 *
 * Uses @PersistedCollection for multi-row table storage with explicit save().
 */
@PersistedCollection("external_tool_providers")
export class ExternalToolProvider extends CollectionEntity {
  @Id() providerId: string = "";
  @Field("string") @Index() callbackUrl: string = "";
  @Field("string") authHeader: string | null = null;
  @Field("string") toolsJson: string = "[]";
  @Field("number") registeredAt: number = 0;
  @Field("number") lastHeartbeatAt: number | null = null;

  async save(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }

  async delete(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }
}

export interface CreateProviderInput {
  providerId: string;
  callbackUrl: string;
  authHeader?: string;
  toolsJson: string;
}

/**
 * Create a new external tool provider.
 */
export function createProvider(
  stateLoader: StateLoader,
  input: CreateProviderInput,
): ExternalToolProvider {
  return stateLoader.create(ExternalToolProvider, {
    providerId: input.providerId,
    callbackUrl: input.callbackUrl,
    authHeader: input.authHeader ?? null,
    toolsJson: input.toolsJson,
    registeredAt: Date.now(),
    lastHeartbeatAt: null,
  });
}

/**
 * Get a provider by its unique ID.
 */
export function getProvider(
  stateLoader: StateLoader,
  providerId: string,
): ExternalToolProvider | null {
  return stateLoader.get(ExternalToolProvider, providerId);
}

/**
 * List all registered providers.
 */
export function listProviders(
  stateLoader: StateLoader,
): ExternalToolProvider[] {
  return stateLoader.find(ExternalToolProvider, {
    orderBy: { registeredAt: "desc" },
  });
}

/**
 * Update a provider's registration (tools, callback URL, auth).
 */
export async function updateProvider(
  stateLoader: StateLoader,
  providerId: string,
  updates: Partial<
    Pick<ExternalToolProvider, "callbackUrl" | "authHeader" | "toolsJson">
  >,
): Promise<ExternalToolProvider | null> {
  const provider = stateLoader.get(ExternalToolProvider, providerId);
  if (!provider) return null;

  if (updates.callbackUrl !== undefined)
    provider.callbackUrl = updates.callbackUrl;
  if (updates.authHeader !== undefined)
    provider.authHeader = updates.authHeader;
  if (updates.toolsJson !== undefined) provider.toolsJson = updates.toolsJson;
  provider.registeredAt = Date.now();

  await provider.save();
  return provider;
}

/**
 * Update the heartbeat timestamp for a provider.
 */
export async function updateHeartbeat(
  stateLoader: StateLoader,
  providerId: string,
): Promise<ExternalToolProvider | null> {
  const provider = stateLoader.get(ExternalToolProvider, providerId);
  if (!provider) return null;

  provider.lastHeartbeatAt = Date.now();
  await provider.save();
  return provider;
}

/**
 * Delete a provider registration.
 */
export async function deleteProvider(
  stateLoader: StateLoader,
  providerId: string,
): Promise<boolean> {
  const provider = stateLoader.get(ExternalToolProvider, providerId);
  if (!provider) return false;

  await provider.delete();
  return true;
}
