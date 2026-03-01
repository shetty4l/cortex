/**
 * Input abstraction for E2E tests.
 *
 * Injects test input via buffer insertion and triggers sync.
 */

import { insertBuffer, triggerSync } from "./cortex";

export interface InjectTestInputOptions {
  /** Unique test identifier (e.g., "TEST-abc12345") */
  testId: string;
  /** Content to inject */
  content: string;
  /** Channel for buffer insertion */
  channel: string;
  /** Metadata for buffer insertion */
  metadata?: Record<string, unknown>;
}

export interface InjectTestInputResult {
  /** The injected content */
  content: string;
  /** Event ID from buffer insertion */
  eventId: string;
}

/**
 * Inject test input via buffer insertion and trigger sync.
 */
export async function injectTestInput(
  opts: InjectTestInputOptions
): Promise<InjectTestInputResult> {
  const { testId, content, channel, metadata } = opts;

  const eventId = await insertBuffer({
    channel,
    externalId: `${testId}-${Date.now()}`,
    content,
    metadata,
  });

  await triggerSync(channel);

  return {
    content,
    eventId,
  };
}
