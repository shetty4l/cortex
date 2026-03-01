/**
 * E2E test library - re-exports all helpers.
 */

export * from "./types";
export { loadConfig, getConfig } from "./config";
export { openCortexDb, openWilsonDb, query, queryOne, execute } from "./db";
export { sleep, waitFor, type WaitForOptions } from "./wait";
export {
  insertBuffer,
  triggerSync,
  sendMessage,
  getPendingApproval,
  respondToApproval,
  type InsertBufferOptions,
  type SendMessageOptions,
  type Approval,
  type SyncResult,
} from "./cortex";
export {
  injectTestInput,
  type InjectTestInputOptions,
  type InjectTestInputResult,
} from "./input";
export {
  AssertionError,
  assertNoQuestions,
  assertContains,
  assertTopicExists,
  assertTrue,
  assertEqual,
} from "./assert";
export {
  waitForDeliveredMessage,
  waitForAnyReadyMessage,
  getReadyMessages,
  type OutboxMessage,
  type WaitForMessageOptions,
} from "./outbox";
export {
  insertTask,
  findTaskByTitle,
  deleteTask,
  getDefaultTopicId,
  getTopicIdByKey,
  topicExists,
  getTopicByKey,
  type InsertTaskInput,
} from "./tasks";
export {
  remember,
  recall,
  forget,
  type RememberOptions,
  type RememberResult,
  type RecallOptions,
  type RecallResult,
  type ForgetOptions,
} from "./engram";
export {
  waitForTickMessage,
  type TickMessage,
  type WaitForTickOptions,
} from "./tick";
export {
  cleanupTestData,
  deleteTasksForTopic,
  deleteTopic,
  type CleanupOptions,
  type CleanupResult,
} from "./cleanup";
