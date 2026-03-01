/**
 * Assertion helpers for E2E tests.
 */

import { openCortexDb, queryOne } from "./db";

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

export function assertNoQuestions(text: string): void {
  if (text.includes("?")) {
    throw new AssertionError(
      `Expected no questions in response, but found "?" in: "${text.slice(0, 100)}..."`
    );
  }
}

export function assertContains(text: string, substr: string): void {
  if (!text.toLowerCase().includes(substr.toLowerCase())) {
    throw new AssertionError(
      `Expected text to contain "${substr}", but got: "${text.slice(0, 100)}..."`
    );
  }
}

interface Topic {
  id: string;
  topic_key: string;
}

export async function assertTopicExists(topicKey: string): Promise<void> {
  const db = await openCortexDb();
  const topic = queryOne<Topic>(
    db,
    `SELECT id, topic_key FROM topics WHERE topic_key = $topicKey`,
    { $topicKey: topicKey }
  );

  if (!topic) {
    throw new AssertionError(`Expected topic "${topicKey}" to exist, but it does not`);
  }
}

export function assertTrue(condition: boolean, message: string): void {
  if (!condition) {
    throw new AssertionError(message);
  }
}

export function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new AssertionError(
      message ?? `Expected "${expected}", got "${actual}"`
    );
  }
}
