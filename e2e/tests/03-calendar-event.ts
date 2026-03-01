/**
 * Test 03: Calendar event notification.
 *
 * KNOWN LIMITATION: This test currently fails because calendar events
 * are routed by Thalamus to semantic topic keys (based on event content),
 * not to our test-specified topicKey. The test would need to discover
 * what topic Thalamus assigned the event to.
 *
 * Inserts a calendar buffer event and verifies:
 * - Response message_type = 'notification'
 * - Response has no trailing "?" (not asking questions)
 */

import type { TestResult } from "../lib/types";
import { insertBuffer, triggerSync } from "../lib/cortex";
import { waitForDeliveredMessage } from "../lib/outbox";
import { assertEqual, assertNoQuestions, assertTrue } from "../lib/assert";

export const name = "03-calendar-event";

function generateTestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function run(): Promise<TestResult> {
  const startTime = Date.now();
  const testId = generateTestId();
  const testMarker = `[TEST-${testId}]`;
  const topicKey = `test-calendar-event-${testId}`;

  try {
    const beforeTimestampMs = Date.now();

    // Create a calendar event starting in 30 minutes
    const eventStart = new Date(Date.now() + 30 * 60 * 1000);
    const eventEnd = new Date(Date.now() + 60 * 60 * 1000);

    const calendarEvent = {
      id: `evt-${testId}`,
      summary: `${testMarker} Test Meeting with Engineering Team`,
      description: "Quarterly planning session for Q2 roadmap",
      start: { dateTime: eventStart.toISOString() },
      end: { dateTime: eventEnd.toISOString() },
      location: "Conference Room A",
      attendees: [
        { email: "alice@example.com", displayName: "Alice" },
        { email: "bob@example.com", displayName: "Bob" },
      ],
    };

    // Insert as calendar buffer
    await insertBuffer({
      channel: "calendar",
      externalId: `calendar-${testId}`,
      content: JSON.stringify(calendarEvent),
      metadata: {
        topic_key: topicKey,
        event_type: "upcoming",
      },
    });

    // Trigger sync to process the buffer
    await triggerSync("calendar");

    // Wait for notification response
    const message = await waitForDeliveredMessage(topicKey, beforeTimestampMs);

    // Assert non-empty response
    assertTrue(
      message.text.length > 0,
      "Expected non-empty notification text"
    );

    // Assert message_type is notification
    assertEqual(
      message.message_type,
      "notification",
      `Expected message_type='notification', got '${message.message_type}'`
    );

    // Assert no trailing questions (notifications should be informative, not asking)
    assertNoQuestions(message.text);

    return {
      name,
      passed: true,
      duration: Date.now() - startTime,
      input: `Calendar event: ${calendarEvent.summary}`,
    };
  } catch (err) {
    return {
      name,
      passed: false,
      duration: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
