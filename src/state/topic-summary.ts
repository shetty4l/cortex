/**
 * Topic summary state.
 *
 * Caches the rolling summary for a topic. The summary is also stored in
 * Engram as the source of truth, but this local cache provides fast reads
 * at prompt time without network calls.
 */

import { Field, Persisted } from "@shetty4l/core/state";

@Persisted("topic_summaries")
export class TopicSummaryState {
  @Field("string") summary: string | null = null;
}
