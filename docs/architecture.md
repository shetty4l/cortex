# Cortex: Architecture

## Overview

Cortex is a proactive life assistant runtime that runs 24/7 on a Mac Mini. It is channel-agnostic at the core (`POST /ingest` in, outbox poll/ack out), remembers through Engram, reasons through Synapse, executes skills, and adapts its personality to context.

It is part of the **Wilson system** — four services that together form a personal AI infrastructure:

```
                        Telegram
                           |
                           v
                    +--------------+
                    |    Cortex    |  :7751  Life assistant (brain)
                    +------+-------+
                           |
              +------------+------------+
              |                         |
       +------v-------+         +------v-------+
       |    Synapse    |  :7750  |    Engram    |  :7749
       | LLM proxy    |         | Memory       |
       +--------------+         +--------------+
              |
     +--------+--------+
     |                  |
  local-gpu          cloud
  (Ollama)          (Groq)
```

| Service | Repo | Purpose | Port |
|---------|------|---------|------|
| **Engram** | `shetty4l/engram` | Persistent semantic memory (FTS5 + decay + embeddings) | 7749 |
| **Synapse** | `shetty4l/synapse` | OpenAI-compatible LLM proxy with provider failover | 7750 |
| **Cortex** | `shetty4l/cortex` | Life assistant runtime: ingest/inbox/outbox + skills + scheduler | 7751 |
| **Wilson** | `shetty4l/wilson` | Deployment orchestration CLI, manages all services | -- |

All services run on a Mac Mini, managed by Wilson via macOS LaunchAgents, auto-updating from GitHub releases. All are Bun/TypeScript with zero runtime dependencies.

## Implementation Reference

Build contracts for Phase 2 live in `docs/phase2-implementation-spec.md`.

---

## Design Principles

### Why This Architecture

Cortex's architecture was designed from first principles, not ported from `delegate-assistant`. Three approaches were evaluated:

| Approach | Description | Verdict |
|----------|-------------|---------|
| **A: "The Port"** | Port delegate-assistant's hexagonal architecture, simplify as we go | Rejected -- carries conceptual baggage (multi-user sessions, workspace model, pi-agent dependency). Over-abstraction for a small-scale personal system. |
| **B: "The Loop"** | Minimal message loop. Poll, think, respond. One file could run the whole thing. | Good simplicity, but single-threaded and no tool-calling. |
| **C: "The Agent"** | Model-first. Give the LLM tools and let it decide everything via function calling. | Most flexible for skills, but over-relies on model quality and costs more tokens. |

**Decision: B+C hybrid ("The Smart Loop").** Take B's simplicity as the skeleton (flat `src/`, direct API clients, no ports/adapters ceremony), but use C's tool-calling pattern for model interaction (LLM gets tools, calls them, Cortex executes, loops until final response).

### What We Deliberately Don't Build

| Concept | Why Not |
|---------|---------|
| Hexagonal ports/adapters | One runtime path (ingest/inbox/outbox), one LLM backend (Synapse), one memory store (Engram). Abstractions add cost with no benefit until a second implementation exists. Refactor if/when needed. |
| Supervisor/worker process | delegate-assistant used this for crash isolation. Wilson's LaunchAgent restarts on crash. Single process is simpler. |
| Tiered model routing (T0/T1/T2) | Synapse already handles provider failover. Don't duplicate routing logic. |
| Workspace/file tools | Cortex is a life assistant, not a coding assistant. |
| Pi-agent dependency | Heavyweight, opaque. A thin `fetch()` client to Synapse is all we need. |

---

## Decisions

All decisions locked during design session (Feb 13, 2026):

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Users** | Allowlist (2-5 people), Telegram user ID check | Small trusted group. No onboarding, no abuse protection needed. |
| **Memory isolation** | Shared brain, single global Engram scope | All users see all memories. Simple. A preference stored by one user benefits all. |
| **Skill permissions** | All users, all skills | No permission layer needed for a small trusted group. |
| **Chat types** | DMs + Telegram group forum topics | Session key = `chatId:threadId`. Supports both private and group conversations. |
| **Cross-topic memory** | Connected via Engram recall (global) | Topics have independent conversation history, but Engram recall searches everything. Trip planning context surfaces in a booking conversation. |
| **History** | Dual Memory (see below) | Verbatim turn window in SQLite + extracted facts in Engram + per-topic rolling summary. Relevance over recency. |
| **Extraction timing** | Batched, configurable (default every 3 turns) | Balance between completeness and model call cost. |
| **Extraction model** | Explicit `extractionModel` in config (cheap/local) | Extraction is a simpler task than conversation. Use a small fast model. |
| **Extraction dedup** | Pass existing memories into extraction prompt | Costs a few hundred tokens but avoids storing the same fact repeatedly. |
| **Topic summaries** | Engram upsert (overwrite by idempotency key) | One summary per topic, updated in place. Requires adding upsert to Engram. |
| **Turn eviction** | TTL-based, 30 days | Middle ground: some history for debugging, bounded growth. |
| **Engram scoping** | Single global scope | No per-user or per-topic scoping. All memories in one pool. |
| **Scheduler** | User-created via chat (tool calling) | Users say "remind me every Monday..." and the LLM creates a persistent cron job via a namespaced schedule tool (for example `schedule.create`). Stored in SQLite. |
| **Persona** | Adaptive per context | Concise for tasks, warm for check-ins, firm for accountability. Reads the room. |
| **Proactive messaging** | Yes -- scheduler can push to Telegram | Bot can initiate conversations for scheduled events, reminders, nudges. |
| **Daemon** | Full Wilson-managed daemon | HTTP health endpoint at `:7751`. Wilson manages lifecycle, logs, updates. |
| **Process model** | Single process, LaunchAgent restart on crash | No supervisor. Graceful SIGTERM shutdown (drain in-flight, then exit). |
| **Concurrency** | TopicQueue (ordered per topic, parallel across) | Messages within a conversation are sequential. Different conversations run in parallel. |

---

## Architecture

### The Smart Loop

Cortex is a single-process runtime with three ingress/egress paths:

1. **Connector ingest**: authenticated `POST /ingest` writes durable inbox rows
2. **Scheduler tick**: due jobs synthesize inbound events through the same ingest path
3. **Connector delivery**: connectors claim outbox messages via `/outbox/poll` and confirm via `/outbox/ack`

Agent processing runs per inbound event in topic order, with parallelism across topics.

```
on POST /ingest(event):
  inbox.enqueue(event)  // idempotent on (source, external_message_id)

every schedulerTickSeconds:
  for each due job:
    inbox.enqueue(syntheticEvent(job))

worker loop:
  event = inbox.claimNextByTopic()
  response = agent.handle(event)
  outbox.enqueue(response)
```

### Agent: Tool-Calling Loop

Each inbound message (user or scheduled) is processed by the agent:

```
function handleMessage(message):
  // Build context
  memories    = engram.recall(message.text)
  history     = history.load(message.topicKey)  // summary + recent turns
  tools       = skills.allToolDefs()
  messages    = prompt.build(memories, history, message, tools)

  // Tool-calling loop (max 8 iterations)
  loop:
    response = synapse.chat(messages, tools)

    if response.hasToolCalls:
      for toolCall of response.toolCalls:
        result = skills.execute(toolCall)
        messages.push(toolCall, result)
      continue

    // Final text response
    break

  // Persist and emit
  outbox.enqueue(message.source, message.topicKey, response.content)
  history.saveTurn(message.topicKey, message, response)

  // Async: maybe extract facts
  history.maybeExtract(message.topicKey)
```

### Concurrency: TopicQueue

Multiple users and group topics means concurrent conversations. The concurrency model:

- **Ordered within a topic** -- messages in a chat/thread are processed sequentially via a per-topic FIFO queue
- **Parallel across topics** -- different conversations run concurrently
- **Auto-cleanup** -- idle topic queues self-delete

```
TopicQueue      -- async FIFO per topic key
TopicQueueMap   -- Map<topicKey, TopicQueue>, auto-cleanup on idle
```

No semaphore needed. Synapse handles backpressure at the provider level.

### Data Flow

```
Connector -> POST /ingest -> inbox_messages
Scheduler ---------------> inbox_messages (synthetic events)

inbox_messages -> TopicQueue -> agent loop (Synapse + skills + approvals)
agent loop -> turns + outbox_messages

Connector <- POST /outbox/poll <- outbox_messages (leased)
Connector -> POST /outbox/ack  -> outbox_messages (delivered)

history/extraction -> Engram remember + upsert(topic summary)
```

---

## Dual Memory System

The hardest design problem in Cortex is conversation history. The naive approach (send all past turns to the model) doesn't scale. The standard approach (summarize old turns into a compressed blob) loses nuance and is recency-biased.

Cortex uses a **Dual Memory** system that splits history into two layers:

### Layer 1: Short-Term (SQLite)

Recent conversation turns stored verbatim in SQLite. This is the "active window" -- the last 8-10 turns per topic. Provides conversational continuity (pronoun resolution, follow-ups, context).

Turns older than 30 days are deleted (TTL-based eviction).

### Layer 2: Long-Term (Engram)

Durable knowledge extracted from conversations and stored as individual memories in Engram. Facts, decisions, preferences, insights. Recalled semantically -- a preference stated months ago in a different topic surfaces when it's relevant to the current query.

Additionally, each topic has a **rolling summary** -- a 1-2 sentence orientation stored in Engram via upsert. This prevents "amnesia" when returning to a conversation after hours/days.

### Why Not Just Summarize?

| Summarize + Compress | Dual Memory |
|---------------------|-------------|
| Linear blob of compressed text | Individual semantic memories |
| Recency-biased | **Relevance-biased** |
| No cross-topic context | Cross-topic for free (global Engram scope) |
| Summaries lose nuance over repeated compression | Facts preserved at original fidelity |
| One model (same for chat + summarize) | Two models (good for chat, cheap for extraction) |

### Prompt Structure

When building a prompt for the model, context is assembled in this order:

```
+---------------------------------------------+
| System prompt + persona rules         ~800t  |
+---------------------------------------------+
| Engram memories (top 5-8 relevant)   ~1500t  |
+---------------------------------------------+
| Topic summary (1-2 sentences)         ~200t  |
+---------------------------------------------+
| Skill/tool definitions               ~1000t  |
+---------------------------------------------+
| Recent turns (last 8-10, verbatim)  ~10000t  |
+---------------------------------------------+
| Current message                               |
+---------------------------------------------+
| Response headroom                    ~2500t  |
+---------------------------------------------+
Total budget: ~16K tokens
```

### Extraction Pipeline

Runs asynchronously (non-blocking) every N turns (configurable, default 3). Uses a cheap model specified by `extractionModel` in config.

**Step 1: Fact Extraction**

```
System: Extract durable facts from this conversation worth remembering long-term.
        Return JSON: [{content, category}] or [] if nothing new.
        Categories: fact, decision, preference, insight
        Skip: greetings, small talk, things already known.

[Existing memories for dedup]
[Recent N turns to extract from]
```

Each extracted fact is stored via `engram.remember({ content, category })`.

If Engram scope fields are enabled (`ENGRAM_ENABLE_SCOPES=1`), Cortex also includes
`chat_id` and `thread_id` for observability/filtering.

**Step 2: Topic Summary Update**

```
System: In 1-2 sentences, summarize what this conversation is about
        and its current focus.

[Previous topic summary if exists]
[Recent turns]
```

Result is stored via `engram.upsert()` with `idempotency_key: "topic-summary:{topicKey}"`, overwriting the previous summary.

### What Lives Where

| Data | Store | Lifetime |
|------|-------|----------|
| Recent turns (verbatim) | SQLite `turns` table | 30-day TTL |
| Extraction progress | SQLite `extraction_cursors` table | Permanent |
| Scheduler jobs | SQLite `scheduler_jobs` table | Until deleted |
| Extracted facts/preferences/decisions | Engram (global scope) | Permanent (Engram decay manages relevance) |
| Topic summaries | Engram (upserted per topic) | Overwritten on each update |

---

## Configuration

Config is loaded from a file (`~/.config/cortex/config.json`) with environment variable overrides.

```typescript
interface CortexConfig {
  // Server
  host: string                    // default: "127.0.0.1"
  port: number                    // default: 7751

  // Auth
  ingestApiKey: string            // CORTEX_INGEST_API_KEY (required)

  // Services
  synapseUrl: string              // default: "http://localhost:7750"
  engramUrl: string               // default: "http://localhost:7749"

  // Models
  model: string                   // Conversation model, e.g. "gpt-oss:20b"
  extractionModel: string         // Cheap model for extraction, e.g. "qwen2.5:3b"

  // History
  activeWindowSize: number        // default: 10 (turns in active window)
  extractionInterval: number      // default: 3 (turns between extraction runs)
  turnTtlDays: number             // default: 30 (days before turns are deleted)

  // Scheduler
  schedulerTickSeconds: number    // default: 30
  schedulerTimezone: string        // default: "UTC"

  // Outbox
  outboxPollDefaultBatch: number  // default: 20
  outboxLeaseSeconds: number      // default: 60
  outboxMaxAttempts: number       // default: 10

  // Skills
  skillDirs: string[]             // trusted local directories
  toolTimeoutMs: number           // default: 20000
}
```

---

## SQLite Schema

Phase 2 schema is canonical in `docs/phase2-implementation-spec.md` and includes:

- `inbox_messages`
- `outbox_messages`
- `pending_approvals`
- `turns`
- `extraction_cursors`
- `scheduler_jobs`

Database location: `~/.local/share/cortex/cortex.db`

---

## Skills

### Framework

Skills are runtime-loaded from trusted local `skillDirs` at startup. Each skill package provides metadata (`skill.json`) and an executable module (`main.ts`).

Package layout:

```text
<skill-dir>/<skill-id>/
  skill.json
  main.ts
```

`skill.json` includes `id`, `name`, `version`, `runtimeApiVersion`, and `main`.

`main.ts` exports:

- `listTools()` returning namespaced tool definitions (`skill.tool`)
- `execute(call, ctx)` returning tool output

Load rules in core runtime:

- Fail startup on missing/invalid `runtimeApiVersion`
- Fail startup on duplicate fully-qualified tool names
- Enforce per-tool timeout (`toolTimeoutMs`, default 20s)

The LLM receives aggregated tool definitions in its prompt. When tool calls are returned, Cortex resolves by tool name and executes through the loaded skill module. Results are appended to the conversation and fed back into the next tool-loop iteration.

Adding a new skill means adding a package under a trusted `skillDirs` path and restarting Cortex (startup-load only in Phase 2).

### Included Skills (Phase 2)

#### Calendar (`<skill-dir>/calendar/`)

Reads Apple Calendar events via `osascript` (AppleScript/JXA). Runs on the Mac Mini where Calendar.app has the user's accounts.

**Tools:**
- `calendar.read` -- read events for a date range. Parameters: `startDate`, `endDate`. Returns structured event list.

#### Schedule (`<skill-dir>/schedule/`)

CRUD for user-created scheduled jobs. The LLM uses these tools when users say things like "remind me every Monday to submit my timesheet."

**Tools:**
- `schedule.create` -- create a new cron job. Parameters: `description`, `cron`, `action`, `target_source`, `target_topic_key`.
- `schedule.list` -- list all active schedules.
- `schedule.delete` -- remove a schedule by ID.

---

## File Structure

```
cortex/
  src/
    main.ts              # Entry point, health server (GET /health), SIGTERM handler
    config.ts            # Load config from file + env, validate, export typed config
    synapse.ts           # Synapse client: chat(messages, tools, model?) with SSE streaming
    engram.ts            # Engram client: remember(), recall(), forget(), upsert()
    db.ts                # SQLite: schema creation, turn/cursor/job queries
    loop.ts              # Main event loop: process inbox + scheduler tick -> dispatch
    agent.ts             # Tool-calling loop: build prompt -> synapse.chat -> execute tools -> repeat
    prompt.ts            # System prompt builder: persona + memories + summary + turns + tools
    history.ts           # Conversation history: load/save turns, window management, extraction trigger
    extraction.ts        # Async extraction: extract facts + update topic summary via cheap model
    topics.ts            # TopicQueue + TopicQueueMap for concurrent topic processing
    scheduler.ts         # Cron ticker: check due jobs, synthesize trigger messages, dispatch

  test/                  # Unit + integration tests
  docs/
    architecture.md      # This document

  scripts/
    install.sh           # curl|bash installer (same pattern as wilson/engram/synapse)
    version-bump.ts      # Release version helper

  .github/
    workflows/
      ci.yml             # Lint, typecheck, test on PR
      release.yml        # Tag -> build -> GitHub release

  package.json
  tsconfig.json
  biome.json
  .gitignore
```

External skill packages are loaded from trusted `skillDirs` and are not required to live under `cortex/src/`.

**Core runtime stays flat in `src/`** (no `packages/`, no `adapters/`, no `ports/`).

---

## Build Order

### Phase 2: Cortex (canonical)

Phase 2 build slices are maintained in `docs/phase2-implementation-spec.md` and are the source of truth.

Current slice order:

0. Core service + CLI
1. Ingest + inbox
2. Loop + tracer to Synapse
3. Outbox poll/ack + retries
4. Runtime skill loader
5. Tool loop + approval gate
6. Scheduler + schedule skill
7. Memory integration
8. External skills

---

### Phase 3: First Skills

Phase 3 is pure accretion -- the architecture doesn't change. Each skill is a new package in a trusted `skillDirs` location with `skill.json` + `main.ts`.

#### Preferences

Read/write user preferences stored in Engram. Examples: quiet hours, preferred name, notification preferences.

**Tools:**
- `preferences.get` -- read a preference by key
- `preferences.set` -- write a preference

**Engram storage pattern:** `category: "preference"`, content is `"key: value"` format.

#### Morning Briefing

A scheduled skill that composes calendar + reminders + any relevant context into a daily summary. Fires as a scheduled job (created by the user or pre-configured).

This is not a separate "skill" per se -- it's a scheduled job whose `action` prompt is something like: "Give me a morning briefing. Check my calendar for today, list any upcoming reminders, and surface anything important from recent conversations."

The agent uses existing namespaced tools (for example `calendar.read` and `schedule.list`) plus Engram recall to compose the briefing. No new skill code needed -- just a well-crafted scheduled prompt.

#### Task Coaching

Help with task breakdown, deadline tracking, and accountability. Examples: trip preparation checklists, project milestone tracking, gentle nudges.

**Tools:**
- `tasks.create` -- create a task with optional deadline
- `tasks.list` -- list tasks by status
- `tasks.complete` -- mark a task done
- `tasks.breakdown` -- break a task into subtasks

**Storage:** SQLite table (tasks) or Engram-backed, TBD.

---

## Wilson Integration

### Health Endpoint

Cortex exposes `GET /health` on port 7751:

```json
{
  "status": "healthy",
  "version": "0.1.0",
  "uptime": 3600
}
```

### Service Registry Changes

Wilson's `src/services.ts` needs a new `ServiceConfig` entry (same shape as Engram/Synapse):

```typescript
{
  name: "cortex",
  displayName: "Cortex",
  repo: "shetty4l/cortex",
  port: 7751,
  healthUrl: "http://localhost:7751/health",
  installBase: "~/srv/cortex",
  currentVersionFile: "~/srv/cortex/current-version",
  cliPath: "~/.local/bin/cortex",
  logFiles: {
    daemon: "~/.config/cortex/cortex.log",
    updater: "~/Library/Logs/wilson-updater.log"
  }
}
```

Because Cortex ships a CLI, Wilson can manage it exactly like the other services (`restart`,
`status`, and `logs` delegation).

Wilson's `deploy/wilson-update.sh` needs a Cortex update check alongside Engram and Synapse
(before Wilson self-update).

### Pre-requisite: Engram Upsert

Before slice 6 (topic summaries), Engram needs upsert support:

- Modify `POST /remember` to accept `{ upsert: true, idempotency_key: "..." }`
- Upsert key matching follows Engram's existing idempotency scope semantics
  (`idempotency_key` + operation + scope key)
- If a memory with the same idempotency key exists in the same scope, **update** that memory's
  `content`/`category`/`metadata` instead of creating a new row or returning a duplicate-style conflict
- If no existing key match is found, create a new memory normally
- Return a deterministic response shape so Cortex can treat create and update paths uniformly
- Deliver as a PR to `shetty4l/engram`, release as a patch version

This is required for topic summaries: Cortex writes one rolling summary per topic using
`idempotency_key: "topic-summary:{topicKey}"`.

### Cortex CLI Contract

Cortex ships a CLI aligned with Engram/Synapse operational conventions:

- `cortex start` -- start daemon in background
- `cortex stop` -- stop daemon
- `cortex restart` -- restart daemon
- `cortex status` -- show daemon status
- `cortex serve` -- run foreground server (for local/dev)

This keeps Wilson integration simple: it can continue delegating service lifecycle commands
through each service CLI.

---

## Production State (as of Feb 13, 2026)

Current Mac Mini state -- the foundation that Cortex will deploy into:

| Service | Version | Port | Status |
|---------|---------|------|--------|
| Wilson | v0.1.2 | -- | LaunchAgent every 240s |
| Engram | v0.1.6 | 7749 | Healthy |
| Synapse | v0.1.4 | 7750 | Healthy (local-gpu + groq providers) |
| Cortex | -- | 7751 | Not deployed |

### Preserved from delegate-assistant

- `~/.config/delegate-assistant/secrets.env` -- contains `TELEGRAM_TOKEN` for Cortex reuse
- `~/.local/share/engram/engram.db` -- all memories from prior sessions preserved
- delegate-assistant source at `~/workplace/personal/watson-dev/delegate-assistant/` -- reference for porting patterns

### Open Items from Phase 1

- `eng-1`: version-bump.ts changes are local in engram repo, not committed/pushed yet
