/**
 * Types for Cerebellum - the message routing and scheduling subsystem.
 *
 * Cerebellum sits between the inbox/processing pipeline and the outbox,
 * controlling when and how messages are delivered based on their type,
 * urgency, and scheduling constraints.
 */

// --- Message Types ---

/**
 * Classification of message types that affect response behavior:
 * - conversational: Normal back-and-forth dialogue (default)
 * - notification: Informational messages (calendar events, alerts) - no questions
 * - reminder: Time-triggered reminders - brief and direct
 * - callback: Action confirmations/completions - acknowledge and execute
 */
export type MessageType =
  | "conversational"
  | "notification"
  | "reminder"
  | "callback";

// --- Configuration ---

export interface CerebellumConfig {
  /** Polling interval for checking pending messages (milliseconds). Default: 500 */
  pollIntervalMs: number;
}

/** Default configuration values for Cerebellum */
export const CEREBELLUM_DEFAULTS: CerebellumConfig = {
  pollIntervalMs: 500,
};
