/**
 * Receptor cursor state.
 *
 * Tracks the sync cursor for each receptor channel. Used to record when
 * a channel was last synced during thalamus processing.
 */

import { Field, Persisted } from "@shetty4l/core/state";

@Persisted("receptor_cursors")
export class ReceptorCursorState {
  @Field("string") cursorValue: string | null = null;
  @Field("date") lastSyncedAt: Date | null = null;
}
