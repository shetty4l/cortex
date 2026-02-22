/**
 * Triage prompt and parsing for thalamus sync.
 *
 * The thalamus uses a cheap LLM to review buffered receptor data,
 * group related items, assign priorities, and produce summaries
 * for the cortex processing loop.
 */

import { createLogger } from "@shetty4l/core/log";

const log = createLogger("cortex");

// --- Types ---

export interface SyncOutputItem {
  topicKey: string;
  priority: number;
  summary: string;
  rawBufferIds: string[];
}

// --- Prompts ---

export const THALAMUS_TRIAGE_SYSTEM_PROMPT = `You are a triage layer for incoming sensor data in a personal life assistant.

Your job:
1. Review buffered data from various channels (calendar, email, etc.)
2. Group related items together by topic
3. Assign each group a priority
4. Produce a brief summary for each group describing what is new, changed, or needs attention

Priority scale:
- 0 = immediate action needed (deadline today, urgent request)
- 1 = needs attention today
- 2 = this week
- 3 = informational (good to know, no action needed)
- 4 = low priority / background
- 5 = noise / can be ignored

Rules:
- Group related items (e.g., multiple calendar events in the same week, related emails)
- Use existing topic keys when a matching topic exists
- For new topics, use a descriptive kebab-case key (e.g., "japan-trip-planning")
- Each summary should be 1-3 sentences: what happened, what changed, what needs attention
- Include the buffer IDs (id field) that belong to each group in rawBufferIds
- If nothing is noteworthy, return an empty items array

Output ONLY valid JSON matching this schema:
{
  "items": [
    {
      "topicKey": "string",
      "priority": number,
      "summary": "string",
      "rawBufferIds": ["string"]
    }
  ]
}

Do not include any text outside the JSON.`;

export function buildTriageUserPrompt(
  buffers: {
    channel: string;
    items: { id: string; content: string; occurredAt: number }[];
  }[],
  existingTopics: { key: string; name: string; status: string }[],
): string {
  const parts: string[] = ["## Buffered Data\n"];

  for (const group of buffers) {
    parts.push(`### Channel: ${group.channel}`);
    for (const item of group.items) {
      const date = new Date(item.occurredAt).toISOString();
      parts.push(`[${item.id}] (${date})\n${item.content}\n`);
    }
  }

  parts.push("## Existing Topics");
  if (existingTopics.length === 0) {
    parts.push("(none)\n");
  } else {
    for (const topic of existingTopics) {
      parts.push(`- ${topic.key}: ${topic.name} (${topic.status})`);
    }
    parts.push("");
  }

  parts.push("## Instructions");
  parts.push(
    "Analyze the buffered data above. Group related items, assign topics and priorities, and produce a summary for each group.",
  );

  return parts.join("\n");
}

// --- Parsing ---

export function parseSyncOutput(llmResponse: string): SyncOutputItem[] {
  try {
    // Strip markdown code fences if present
    let json = llmResponse.trim();
    const fenceMatch = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      json = fenceMatch[1].trim();
    }

    const parsed = JSON.parse(json) as { items?: unknown[] };

    if (!parsed.items || !Array.isArray(parsed.items)) {
      log("thalamus sync: parsed response missing items array");
      return [];
    }

    const valid: SyncOutputItem[] = [];
    for (const item of parsed.items) {
      if (
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).topicKey === "string" &&
        typeof (item as Record<string, unknown>).priority === "number" &&
        typeof (item as Record<string, unknown>).summary === "string" &&
        Array.isArray((item as Record<string, unknown>).rawBufferIds)
      ) {
        valid.push(item as SyncOutputItem);
      } else {
        log("thalamus sync: skipping invalid item in response");
      }
    }

    return valid;
  } catch (e) {
    log(
      `thalamus sync: failed to parse LLM response: ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
}
