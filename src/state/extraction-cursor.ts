/**
 * Extraction cursor state.
 *
 * Tracks extraction progress per topic: which turns have been processed
 * and how many turns have occurred since the last extraction.
 */

import { Field, Persisted } from "@shetty4l/core/state";

@Persisted("extraction_cursors")
export class ExtractionCursorState {
  @Field("number") lastExtractedRowid: number = 0;
  @Field("number") turnsSinceExtraction: number = 0;
}
