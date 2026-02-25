/**
 * Turn management using StateLoader collection persistence.
 *
 * Turns represent conversation messages (user, assistant, tool) for a topic.
 * Uses explicit seq field for cursor-based queries and portable ordering.
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
 * Turn entity persisted to SQLite via StateLoader.
 *
 * Uses @PersistedCollection for multi-row table storage with explicit save().
 * The seq field provides topic-scoped sequence numbers for cursor-based loading.
 */
@PersistedCollection("turns")
export class Turn extends CollectionEntity {
  @Id() id: string = "";
  @Field("string") @Index() topic_key: string = "";
  @Field("number") @Index() seq: number = 0;
  @Field("string") role: string = "";
  @Field("string") content: string | null = null;
  @Field("string") tool_call_id: string | null = null;
  @Field("string") tool_calls: string | null = null;
  @Field("string") name: string | null = null;

  async save(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }

  async delete(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }
}

// --- Input types ---

export interface SaveTurnInput {
  topicKey: string;
  role: "user" | "assistant" | "tool";
  content: string | null;
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  name?: string;
}

export interface AgentTurn {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  name?: string;
}

// --- Turn operations ---

/**
 * Get the maximum seq value for a topic.
 * Returns 0 if no turns exist for the topic.
 *
 * @internal Used by saveTurn and saveAgentTurns for seq computation
 */
function getMaxSeq(stateLoader: StateLoader, topicKey: string): number {
  const turns = stateLoader.find(Turn, {
    where: { topic_key: topicKey },
    orderBy: { seq: "desc" },
    limit: 1,
  });
  return turns.length > 0 ? turns[0].seq : 0;
}

/**
 * Save a single turn for a topic.
 *
 * Atomically computes seq = MAX(seq for topic) + 1 in a transaction.
 * seq starts at 1 for the first turn in a topic.
 */
export async function saveTurn(
  stateLoader: StateLoader,
  input: SaveTurnInput,
): Promise<Turn> {
  return await stateLoader.transaction(() => {
    const maxSeq = getMaxSeq(stateLoader, input.topicKey);
    const nextSeq = maxSeq + 1;

    return stateLoader.create(Turn, {
      id: `turn_${crypto.randomUUID()}`,
      topic_key: input.topicKey,
      seq: nextSeq,
      role: input.role,
      content: input.content,
      tool_call_id: input.toolCallId ?? null,
      tool_calls: input.toolCalls ? JSON.stringify(input.toolCalls) : null,
      name: input.name ?? null,
    });
  });
}

/**
 * Batch insert all turns from an agent loop for a topic.
 *
 * All turns are inserted in a single transaction with sequential seq values.
 * This ensures atomicity and consistent ordering within the batch.
 */
export async function saveAgentTurns(
  stateLoader: StateLoader,
  topicKey: string,
  turns: AgentTurn[],
): Promise<Turn[]> {
  if (turns.length === 0) {
    return [];
  }

  return await stateLoader.transaction(() => {
    const maxSeq = getMaxSeq(stateLoader, topicKey);
    const savedTurns: Turn[] = [];

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const nextSeq = maxSeq + i + 1;

      const savedTurn = stateLoader.create(Turn, {
        id: `turn_${crypto.randomUUID()}`,
        topic_key: topicKey,
        seq: nextSeq,
        role: turn.role,
        content: turn.content ?? null,
        tool_call_id: turn.tool_call_id ?? null,
        tool_calls: turn.tool_calls ? JSON.stringify(turn.tool_calls) : null,
        name: turn.name ?? null,
      });
      savedTurns.push(savedTurn);
    }

    return savedTurns;
  });
}

/**
 * Load the most recent turns for a topic, ordered oldest-first (chronological).
 *
 * @param maxRows Maximum number of rows to return (default 16).
 *                Callers should size this to cover the expected turn density
 *                (e.g. tool-calling conversations have more messages per exchange).
 */
export function loadRecentTurns(
  stateLoader: StateLoader,
  topicKey: string,
  maxRows = 16,
): Turn[] {
  // Get the most recent turns by seq DESC
  const recentTurns = stateLoader.find(Turn, {
    where: { topic_key: topicKey },
    orderBy: { seq: "desc" },
    limit: maxRows,
  });

  // Reverse to get chronological order (oldest first)
  return recentTurns.reverse();
}

/**
 * Load turns newer than the given seq cursor for a topic.
 *
 * Returns turns with seq > cursorSeq, ordered oldest-first (chronological).
 * Used for extraction and other cursor-based processing.
 *
 * @param cursorSeq The seq value to start after (exclusive)
 * @param limit Optional maximum number of turns to return
 */
export function loadTurnsSinceCursor(
  stateLoader: StateLoader,
  topicKey: string,
  cursorSeq: number,
  limit?: number,
): Turn[] {
  const turns = stateLoader.find(Turn, {
    where: {
      topic_key: topicKey,
      seq: { op: "gt", value: cursorSeq },
    },
    orderBy: { seq: "asc" },
    ...(limit !== undefined ? { limit } : {}),
  });

  return turns;
}

/**
 * Get a turn by ID.
 */
export function getTurn(stateLoader: StateLoader, id: string): Turn | null {
  return stateLoader.get(Turn, id);
}
