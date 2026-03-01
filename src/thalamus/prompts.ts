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
  topicName: string;
  priority: number;
  summary: string;
  rawBufferIds: string[];
}

export interface ParseResult {
  /** True if the LLM response was valid JSON with an items array */
  ok: boolean;
  /** Parsed items (empty array if ok=true but nothing noteworthy, or if ok=false) */
  items: SyncOutputItem[];
}

// --- Prompts ---

export const THALAMUS_TRIAGE_SYSTEM_PROMPT = `<role>
You are a triage layer for incoming sensor data in a personal life assistant.
Your purpose is to review buffered data from various channels (calendar, email, etc.),
group related items by semantic topic, assign priorities, and produce actionable summaries.
</role>

<context>
You will receive:
1. Buffered data items from various channels, each with an id, timestamp, and content
2. A list of existing topics with their keys and names

Your job is to:
- Group related items together under a semantic topic
- Reuse existing topic keys when the data matches an existing topic
- Create new topic keys (kebab-case) when no existing topic fits
- Assign a priority to each group
- Write a brief summary of what needs attention
</context>

<instructions>
CRITICAL: Respond with valid JSON only. No markdown, no explanation, no code fences. Start with { and end with }.

Priority scale:
- 0 = immediate action needed (deadline today, urgent request)
- 1 = needs attention today
- 2 = this week
- 3 = informational (good to know, no action needed)
- 4 = low priority / background
- 5 = noise / can be ignored

Rules:
- Group semantically related items (e.g., all calendar events for a trip, all emails about a project)
- IMPORTANT: If an existing topic matches the data, USE ITS EXACT KEY. Do not create variations.
- For new topics, use descriptive kebab-case keys (e.g., "japan-trip-planning", "dentist-appointment")
- topicName should be a human-readable title (e.g., "Japan Trip Planning", "Dentist Appointment")
- Each summary should be 1-3 sentences: what happened, what changed, what needs attention
- Include ALL buffer IDs (id field) that belong to each group in rawBufferIds
- If nothing is noteworthy, return an empty items array
</instructions>

<examples>
Example 1: Calendar event for existing topic
Input:
- Existing topics: [{ key: "dentist-appointment", name: "Dentist Appointment" }]
- Buffer: [{ id: "cal-123", content: "Dentist cleaning at 2pm tomorrow" }]

Output:
{
  "items": [
    {
      "topicKey": "dentist-appointment",
      "topicName": "Dentist Appointment",
      "priority": 1,
      "summary": "Dentist cleaning scheduled for tomorrow at 2pm. Prepare any questions about recent sensitivity.",
      "rawBufferIds": ["cal-123"]
    }
  ]
}

Example 2: New topic from multiple related items
Input:
- Existing topics: []
- Buffer: [
    { id: "cal-456", content: "Flight to Tokyo - Mar 15" },
    { id: "cal-457", content: "Hotel check-in Shibuya - Mar 15" },
    { id: "email-789", content: "Your JR Pass has shipped" }
  ]

Output:
{
  "items": [
    {
      "topicKey": "japan-trip-march",
      "topicName": "Japan Trip March",
      "priority": 2,
      "summary": "Japan trip on Mar 15: flight and hotel confirmed. JR Pass shipped and should arrive before departure.",
      "rawBufferIds": ["cal-456", "cal-457", "email-789"]
    }
  ]
}

Example 3: Multiple topics from mixed input
Input:
- Existing topics: [{ key: "weekly-standup", name: "Weekly Standup" }]
- Buffer: [
    { id: "cal-001", content: "Team standup at 10am Monday" },
    { id: "email-002", content: "Car insurance renewal due in 5 days" },
    { id: "cal-003", content: "Mom's birthday dinner Saturday" }
  ]

Output:
{
  "items": [
    {
      "topicKey": "weekly-standup",
      "topicName": "Weekly Standup",
      "priority": 3,
      "summary": "Regular Monday standup at 10am. No special agenda items noted.",
      "rawBufferIds": ["cal-001"]
    },
    {
      "topicKey": "car-insurance-renewal",
      "topicName": "Car Insurance Renewal",
      "priority": 1,
      "summary": "Car insurance renewal due in 5 days. Action needed to review and renew policy.",
      "rawBufferIds": ["email-002"]
    },
    {
      "topicKey": "moms-birthday",
      "topicName": "Mom's Birthday",
      "priority": 2,
      "summary": "Mom's birthday dinner on Saturday. Consider gift and reservation confirmation.",
      "rawBufferIds": ["cal-003"]
    }
  ]
}

Example 4: Nothing noteworthy
Input:
- Existing topics: []
- Buffer: [{ id: "spam-001", content: "You've won a free cruise!" }]

Output:
{
  "items": []
}
</examples>

<output_format>
Respond with ONLY valid JSON matching this schema:
{
  "items": [
    {
      "topicKey": "string (kebab-case identifier)",
      "topicName": "string (human-readable title)",
      "priority": "number (0-5)",
      "summary": "string (1-3 sentences)",
      "rawBufferIds": ["string (buffer ids included in this group)"]
    }
  ]
}

Do not include any text outside the JSON object.
</output_format>`;

/**
 * Correction prompt used when the LLM returns invalid JSON.
 * Appended to the conversation to request a clean retry.
 */
export const THALAMUS_RETRY_PROMPT =
  "Your response was not valid JSON. Respond with ONLY the JSON object. No markdown, no explanation, no code fences. Start with { and end with }.";

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

export function parseSyncOutput(llmResponse: string): ParseResult {
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
      return { ok: false, items: [] };
    }

    const valid: SyncOutputItem[] = [];
    for (const item of parsed.items) {
      if (
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).topicKey === "string" &&
        typeof (item as Record<string, unknown>).topicName === "string" &&
        typeof (item as Record<string, unknown>).priority === "number" &&
        typeof (item as Record<string, unknown>).summary === "string" &&
        Array.isArray((item as Record<string, unknown>).rawBufferIds)
      ) {
        valid.push(item as SyncOutputItem);
      } else {
        log("thalamus sync: skipping invalid item in response");
      }
    }

    return { ok: true, items: valid };
  } catch (e) {
    log(
      `thalamus sync: failed to parse LLM response: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { ok: false, items: [] };
  }
}
