# Cortex Phase 2 Implementation Spec

This document converts the architecture into build-ready contracts for Phase 2.

Status: locked for implementation.

## Scope

Phase 2 delivers the Cortex runtime as a channel-agnostic assistant engine:

- Inbound events via authenticated `POST /ingest`
- Durable inbox/outbox queues in SQLite
- Agent loop with tool-calling through Synapse
- Runtime-loaded skills from trusted local directories
- Write approval gate for all state-changing tool operations
- Internal scheduler that emits synthetic inbound events
- Memory integration with local turns + Engram recall/extraction

Out of scope for this phase:

- Skill hot-reload
- Skill builder automation
- Out-of-process skill runtime

## Decisions Locked

- Delivery semantics: at-least-once outbound
- Runtime skill loading: startup-load only
- Scheduler timezone: one global timezone
- Ingest auth: shared bearer API key
- Outbox handoff: connector poll + explicit ack
- Retry policy: exponential backoff with cap+jitter, `attempts` increments on claim, DLQ at `attempts > outboxMaxAttempts` (exactly N claims allowed)
- Tool naming: namespaced `skill.tool`
- Tool loop limit: max 8 iterations per inbound event
- Tool timeout: enforce `toolTimeoutMs` per tool execution (default `20000` = 20s)
- Write approvals: required for all state-changing tools, TTL 15 minutes
- Schedule input: cron + natural language; parse at create-time via model with user approval before write

## Runtime Configuration

```ts
interface CortexConfig {
  // Server
  host: string; // default: 127.0.0.1
  port: number; // default: 7751

  // Auth
  ingestApiKey: string; // CORTEX_INGEST_API_KEY (required)

  // Model/Memory
  synapseUrl: string; // default: http://localhost:7750
  engramUrl: string; // default: http://localhost:7749
  model: string;
  extractionModel: string;

  // History/Extraction
  activeWindowSize: number; // default: 10
  extractionInterval: number; // default: 3
  turnTtlDays: number; // default: 30

  // Scheduler
  schedulerTickSeconds: number; // default: 30
  schedulerTimezone: string; // global, default: UTC

  // Outbox
  outboxPollDefaultBatch: number; // default: 20
  outboxLeaseSeconds: number; // default: 60
  outboxMaxAttempts: number; // default: 10

  // Skills
  skillDirs: string[]; // trusted local directories
  toolTimeoutMs: number; // default: 20000
}
```

## API Contracts

All connector-facing APIs require:

- `Authorization: Bearer <CORTEX_INGEST_API_KEY>`

### `POST /ingest`

Queue a new inbound event.

Required request body:

```json
{
  "source": "telegram",
  "externalMessageId": "1234567890",
  "idempotencyKey": "telegram:1234567890",
  "topicKey": "chat-42:thread-root",
  "userId": "tg:998877",
  "text": "Remind me every weekday at 9",
  "occurredAt": "2026-02-15T20:30:00Z"
}
```

Optional fields:

```json
{
  "metadata": {
    "chatId": "-100123",
    "threadId": "9",
    "messageType": "button_click",
    "approvalToken": "apr_abc123"
  }
}
```

Behavior:

- Dedupe identity: `source + externalMessageId`
- `idempotencyKey` is required and observability-only (not used for dedupe)
- New event: enqueue and return `202`
- Duplicate: return `200` and do not enqueue again

`202 Accepted` response:

```json
{
  "eventId": "evt_01J...",
  "status": "queued"
}
```

`200 OK` idempotent hit response:

```json
{
  "eventId": "evt_01J...",
  "status": "duplicate_ignored"
}
```

### `POST /outbox/poll`

Claim outbound messages for one connector source.

Request:

```json
{
  "source": "telegram",
  "max": 20,
  "leaseSeconds": 60
}
```

Request field rules:

- `source` required
- `max` optional; default from `outboxPollDefaultBatch`; clamp to `1..100`
- `leaseSeconds` optional; default from `outboxLeaseSeconds`; clamp to `10..300`

Behavior:

- Claim is atomic in one DB transaction; a row can be leased by at most one poller
- Eligible rows satisfy all of:
  - requested `source`
  - `next_attempt_at <= now`
  - `status = 'pending'` OR (`status = 'leased'` AND `lease_expires_at <= now`)
- Claim order is deterministic: `next_attempt_at ASC, created_at ASC`
- For each claimed row, runtime sets fresh `lease_token` and `lease_expires_at` and increments `attempts`
- Expired leased rows are reclaimable through poll (no background sweeper in Phase 2)
- Rows with `attempts > outboxMaxAttempts` transition to `dead` and are never claimable (allows exactly `outboxMaxAttempts` claims)

Validation failure response (`400`):

```json
{
  "error": "invalid_request",
  "details": [
    "max must be between 1 and 100",
    "leaseSeconds must be between 10 and 300"
  ]
}
```

Response:

```json
{
  "messages": [
    {
      "messageId": "out_01J...",
      "leaseToken": "lease_...",
      "topicKey": "chat-42:thread-root",
      "text": "Got it. I created that reminder.",
      "payload": {
        "buttons": [
          { "label": "Approve", "data": "apr_abc123:approve" },
          { "label": "Deny", "data": "apr_abc123:deny" }
        ]
      }
    }
  ]
}
```

### `POST /outbox/ack`

Acknowledge successful connector delivery.

Request:

```json
{
  "messageId": "out_01J...",
  "leaseToken": "lease_..."
}
```

Behavior:

- Ack requires both `messageId` and matching active `leaseToken`
- If lease expired or token mismatch: return `409`
- Duplicate ack for an already delivered message with the same `messageId + leaseToken` is idempotent and returns `200`

Success response:

```json
{
  "ok": true,
  "status": "delivered"
}
```

Idempotent duplicate success response:

```json
{
  "ok": true,
  "status": "already_delivered"
}
```

Conflict response:

```json
{
  "error": "lease_conflict"
}
```

Outbox retry/backoff contract:

- On delivery failure before ack, row transitions to `pending`, clears lease fields, updates `last_error`
- Runtime computes next retry as `delay = min(2^(attempts-1) * 5s, 15m)` with optional jitter `+-20%`
- `next_attempt_at` is set to `now + delay`
- Dead-letter condition: when `attempts > outboxMaxAttempts`, set `status='dead'` (with attempts counted at claim time)

## Skill Runtime Contract

Skills are loaded from trusted local `skillDirs` at startup.

Package layout:

```
<skill-dir>/<skill-id>/
  skill.json
  main.ts
```

`skill.json` (required):

```json
{
  "id": "telegram",
  "name": "Telegram Connector",
  "version": "0.1.0",
  "runtimeApiVersion": "1",
  "main": "main.ts"
}
```

`main.ts` interface:

```ts
export interface SkillRuntimeContext {
  nowIso: string;
  config: Record<string, unknown>;
  db: { query: Function; run: Function };
  http: { fetch: typeof fetch };
}

export interface SkillToolCall {
  name: string; // namespaced: "skill.tool"
  argumentsJson: string;
}

export interface SkillModule {
  listTools(): Array<{
    name: string; // must be skill.tool
    description: string;
    inputSchema: Record<string, unknown>;
    mutatesState?: boolean; // if true, approval gate applies
  }>;
  execute(call: SkillToolCall, ctx: SkillRuntimeContext): Promise<{
    content: string;
    metadata?: Record<string, unknown>;
  }>;
}
```

Load rules:

- Fail startup on missing/invalid `runtimeApiVersion`
- Fail startup on duplicate fully-qualified tool names
- Enforce per-tool timeout using `toolTimeoutMs` (default `20000`)

## Approval Gate Contract

All state-changing tools require user approval before execution.

Flow:

1. Model requests mutating tool call
2. Runtime creates `pending_approvals` row
3. Runtime emits outbox message with approve/deny buttons, embedding `approvalToken`
4. Connector sends user click/reply back through `POST /ingest`
5. Runtime resolves approval and either executes tool or rejects

Approval behavior:

- TTL: 15 minutes
- Expired approvals are marked `expired`
- Correlation primary key: token in button payload (`approvalToken`)

## SQLite Schema (Phase 2)

```sql
CREATE TABLE inbox_messages (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  topic_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  metadata_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|processing|done|failed
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(source, external_message_id)
);

CREATE INDEX idx_inbox_status_created ON inbox_messages(status, created_at);
CREATE INDEX idx_inbox_topic_status ON inbox_messages(topic_key, status);

CREATE TABLE outbox_messages (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  topic_key TEXT NOT NULL,
  text TEXT NOT NULL,
  payload_json TEXT, -- structured UI (buttons/quick replies)
  status TEXT NOT NULL DEFAULT 'pending', -- pending|leased|delivered|dead
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_outbox_source_status_next
  ON outbox_messages(source, status, next_attempt_at);

CREATE TABLE pending_approvals (
  id TEXT PRIMARY KEY,
  approval_token TEXT NOT NULL UNIQUE,
  topic_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_arguments_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|denied|expired
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_approvals_topic_status ON pending_approvals(topic_key, status);

CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_key TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE INDEX idx_turns_topic ON turns(topic_key, timestamp);

CREATE TABLE extraction_cursors (
  topic_key TEXT PRIMARY KEY,
  last_extracted_turn_id INTEGER NOT NULL,
  turns_since_extraction INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE scheduler_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  description TEXT NOT NULL,
  cron TEXT NOT NULL,
  action TEXT NOT NULL,
  target_source TEXT NOT NULL,
  target_topic_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER,
  created_by_user_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_jobs_next ON scheduler_jobs(next_run_at) WHERE enabled = 1;
```

## Scheduler Semantics

- Tick interval: 30 seconds
- Timezone: global `schedulerTimezone`
- Missed runs on restart: execute one catch-up run if any fire time was missed
- Due jobs produce synthetic inbound events through the same processing path as `/ingest`

## Agent Loop Contract

Per inbound event:

1. Load topic history window + relevant Engram memories
2. Build prompt with tool definitions
3. Call Synapse
4. If tool calls returned:
   - Validate name + args
   - Apply approval gate if mutating
   - Execute skill tool (`toolTimeoutMs`, default `20000`)
   - Append tool result and continue
5. Stop at final assistant response or max 8 tool iterations
6. Persist turns
7. Emit outbound message(s) to outbox
8. Trigger async extraction every `extractionInterval` turns

Failure behavior:

- Tool timeout/error is returned to model as tool error output
- Event-level hard failure marks inbox row failed with reason
- Outbound delivery failures are retried by outbox policy

## Phase 2 Build Slices

### Slice 0: Core service + CLI

- `serve/start/stop/restart/status`
- `/health`
- Config loader

Acceptance:

- Daemon starts and health is reachable
- CLI commands manage lifecycle correctly

### Slice 1: Ingest + inbox

- `POST /ingest` + auth + idempotency
- `inbox_messages` persistence

Acceptance:

- New event returns `202` and is queued
- Duplicate returns `200 duplicate_ignored`

### Slice 2: Loop + tracer to Synapse

- Topic-ordered processing
- Basic prompt + model reply

Acceptance:

- Ingested message produces assistant response in outbox

### Slice 3: Outbox poll/ack + retries

- `/outbox/poll` claim lease
- `/outbox/ack` with `messageId + leaseToken`
- Retry and DLQ behavior

Acceptance:

- Delivered message acked successfully
- Lease-expired ack returns `409`
- Failed deliveries retry with backoff and dead-letter when `attempts > outboxMaxAttempts`

### Slice 4: Runtime skill loader

- Load `skill.json + main.ts` from trusted dirs
- Enforce runtime API version and namespaced tool names

Acceptance:

- Valid skills load on startup
- Invalid API version fails startup

### Slice 5: Tool loop + approval gate

- Tool-call execution
- Approval flow for mutating tools

Acceptance:

- Non-mutating tool executes directly
- Mutating tool requires explicit approval and expires after 15m

### Slice 6: Scheduler + schedule skill

- Cron + NL-to-cron parsing at create-time
- 30s tick + one catch-up run semantics

Acceptance:

- User-created schedule fires via synthetic inbound event

### Slice 7: Memory integration

- Local turn history window
- Engram recall + async extraction

Acceptance:

- Multi-turn continuity and memory-aware responses

### Slice 8: External skills

- Telegram ingress+egress skill package
- Schedule CRUD skill package
- Calendar read skill package

Acceptance:

- End-to-end Telegram conversation works through ingest/outbox
- Schedule and calendar tools are callable and reliable

## Open Risks (Known, Non-Blocking)

- Model-only NL schedule parsing can produce ambiguous cron output; approval gate mitigates writes
- Startup-only skill load means operational restart needed for skill updates
- Single global API key is simple but coarse for revocation; per-connector keys can be added later
