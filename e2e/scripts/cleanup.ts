/**
 * Cleanup script for E2E test artifacts.
 *
 * Removes test data with [TEST prefix from databases.
 *
 * Cortex DB:
 *   - receptor_buffers: Records with content containing pattern
 *   - inbox: Records with content containing pattern
 *   - outbox: Records with content containing pattern
 *   - topics: Records with topic_key containing pattern
 *   - tasks: Records with title containing pattern
 *
 * Wilson DB:
 *   - topic_channel_mappings: Records with topic containing pattern
 *
 * Usage:
 *   bun run cleanup                    # Delete all [TEST artifacts
 *   bun run cleanup --dry-run          # Preview what would be deleted
 *   bun run cleanup --pattern "test-%" # Delete by custom pattern
 */

import { openCortexDb, openWilsonDb, query } from "../lib/db";

interface CleanupArgs {
  dryRun: boolean;
  pattern: string;
}

function parseArgs(): CleanupArgs {
  const args = process.argv.slice(2);
  const result: CleanupArgs = {
    dryRun: args.includes("--dry-run"),
    pattern: "%[TEST%", // Default pattern for test markers
  };

  // Parse --pattern argument
  const patternIndex = args.indexOf("--pattern");
  if (patternIndex !== -1 && args[patternIndex + 1]) {
    result.pattern = args[patternIndex + 1];
  }

  return result;
}

interface TopicRow {
  id: number;
  topic_key: string;
}

interface BufferRow {
  id: number;
  content: string;
}

interface InboxRow {
  id: number;
  content: string;
}

interface OutboxRow {
  id: number;
  content: string;
}

interface TopicChannelMappingRow {
  id: number;
  topic: string;
}

interface TaskRow {
  id: number;
  title: string;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const testPattern = args.pattern;

  console.log();
  console.log(args.dryRun ? "DRY RUN - No changes will be made" : "Cleaning up test artifacts...");
  console.log(`Pattern: ${testPattern}`);
  console.log();

  // Open databases
  const cortexDb = await openCortexDb();
  const wilsonDb = await openWilsonDb();

  // ==================== Cortex DB ====================

  // Find receptor_buffers with pattern in content
  const buffers = query<BufferRow>(
    cortexDb,
    `SELECT id, content FROM receptor_buffers WHERE content LIKE $pattern`,
    { $pattern: testPattern }
  );
  console.log(`Found ${buffers.length} test receptor_buffer(s)`);
  for (const buffer of buffers.slice(0, 5)) {
    const preview = buffer.content.substring(0, 60).replace(/\n/g, " ");
    console.log(`  - ${preview}...`);
  }
  if (buffers.length > 5) {
    console.log(`  ... and ${buffers.length - 5} more`);
  }

  // Find inbox records with pattern in content
  const inboxRecords = query<InboxRow>(
    cortexDb,
    `SELECT id, content FROM inbox WHERE content LIKE $pattern`,
    { $pattern: testPattern }
  );
  console.log(`Found ${inboxRecords.length} test inbox record(s)`);
  for (const record of inboxRecords.slice(0, 5)) {
    const preview = record.content.substring(0, 60).replace(/\n/g, " ");
    console.log(`  - ${preview}...`);
  }
  if (inboxRecords.length > 5) {
    console.log(`  ... and ${inboxRecords.length - 5} more`);
  }

  // Find outbox records with pattern in content
  const outboxRecords = query<OutboxRow>(
    cortexDb,
    `SELECT id, content FROM outbox WHERE content LIKE $pattern`,
    { $pattern: testPattern }
  );
  console.log(`Found ${outboxRecords.length} test outbox record(s)`);
  for (const record of outboxRecords.slice(0, 5)) {
    const preview = record.content.substring(0, 60).replace(/\n/g, " ");
    console.log(`  - ${preview}...`);
  }
  if (outboxRecords.length > 5) {
    console.log(`  ... and ${outboxRecords.length - 5} more`);
  }

  // Find topics with pattern in topic_key
  const topics = query<TopicRow>(
    cortexDb,
    `SELECT id, topic_key FROM topics WHERE topic_key LIKE $pattern`,
    { $pattern: testPattern }
  );
  console.log(`Found ${topics.length} test topic(s)`);
  for (const topic of topics) {
    console.log(`  - ${topic.topic_key}`);
  }

  // Find tasks with pattern in title
  const tasks = query<TaskRow>(
    cortexDb,
    `SELECT id, title FROM tasks WHERE title LIKE $pattern`,
    { $pattern: testPattern }
  );
  console.log(`Found ${tasks.length} test task(s)`);
  for (const task of tasks.slice(0, 5)) {
    console.log(`  - ${task.title}`);
  }
  if (tasks.length > 5) {
    console.log(`  ... and ${tasks.length - 5} more`);
  }

  // ==================== Wilson DB ====================

  // Find topic_channel_mappings with pattern in topic
  const mappings = query<TopicChannelMappingRow>(
    wilsonDb,
    `SELECT id, topic FROM topic_channel_mappings WHERE topic LIKE $pattern`,
    { $pattern: testPattern }
  );
  console.log(`Found ${mappings.length} test topic_channel_mapping(s)`);
  for (const mapping of mappings) {
    console.log(`  - ${mapping.topic}`);
  }

  if (args.dryRun) {
    console.log();
    console.log("Run without --dry-run to delete these artifacts.");
    return;
  }

  // ==================== Delete from Cortex DB ====================

  if (buffers.length > 0) {
    for (const buffer of buffers) {
      cortexDb.run("DELETE FROM receptor_buffers WHERE id = ?", [buffer.id]);
    }
    console.log(`Deleted ${buffers.length} receptor_buffer(s)`);
  }

  if (inboxRecords.length > 0) {
    for (const record of inboxRecords) {
      cortexDb.run("DELETE FROM inbox WHERE id = ?", [record.id]);
    }
    console.log(`Deleted ${inboxRecords.length} inbox record(s)`);
  }

  if (outboxRecords.length > 0) {
    for (const record of outboxRecords) {
      cortexDb.run("DELETE FROM outbox WHERE id = ?", [record.id]);
    }
    console.log(`Deleted ${outboxRecords.length} outbox record(s)`);
  }

  if (tasks.length > 0) {
    for (const task of tasks) {
      cortexDb.run("DELETE FROM tasks WHERE id = ?", [task.id]);
    }
    console.log(`Deleted ${tasks.length} task(s)`);
  }

  if (topics.length > 0) {
    for (const topic of topics) {
      // Delete messages for this topic first (foreign key constraint)
      cortexDb.run("DELETE FROM messages WHERE topic_id = ?", [topic.id]);
      // Delete topic
      cortexDb.run("DELETE FROM topics WHERE id = ?", [topic.id]);
    }
    console.log(`Deleted ${topics.length} topic(s) and related messages`);
  }

  // ==================== Delete from Wilson DB ====================

  if (mappings.length > 0) {
    for (const mapping of mappings) {
      wilsonDb.run("DELETE FROM topic_channel_mappings WHERE id = ?", [mapping.id]);
    }
    console.log(`Deleted ${mappings.length} topic_channel_mapping(s)`);
  }

  console.log();
  console.log("Cleanup complete.");
}

main().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
