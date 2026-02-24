/**
 * Thalamus state.
 *
 * Tracks the last sync timestamp for the thalamus sync loop.
 * Persists across restarts so the stats API can report accurate timestamps.
 */

import { Field, Persisted } from "@shetty4l/core/state";

@Persisted("thalamus_state")
export class ThalamusState {
  @Field("date") lastSyncAt: Date | null = null;
}
