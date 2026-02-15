# Cortex: Architecture

## Overview

Cortex is a proactive life assistant that runs 24/7 on a Mac Mini, reachable via Telegram. It remembers everything (via Engram), reasons through LLMs (via Synapse), acts on user-created schedules, and adapts its personality to context.

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
| **Cortex** | `shetty4l/cortex` | Life assistant: Telegram bot + skills + scheduler | 7751 |
| **Wilson** | `shetty4l/wilson` | Deployment orchestration CLI, manages all services | -- |

All services run on a Mac Mini, managed by Wilson via macOS LaunchAgents, auto-updating from GitHub releases. All are Bun/TypeScript with zero runtime dependencies.

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
| Hexagonal ports/adapters | One chat platform (Telegram), one LLM backend (Synapse), one memory store (Engram). Abstractions add cost with no benefit until a second implementation exists. Refactor if/when needed. |
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
| **Scheduler** | User-created via chat (tool calling) | Users say "remind me every Monday..." and the LLM creates a persistent cron job via the `create_schedule` tool. Stored in SQLite. |
| **Persona** | Adaptive per context | Concise for tasks, warm for check-ins, firm for accountability. Reads the room. |
| **Proactive messaging** | Yes -- scheduler can push to Telegram | Bot can initiate conversations for scheduled events, reminders, nudges. |
| **Daemon** | Full Wilson-managed daemon | HTTP health endpoint at `:7751`. Wilson manages lifecycle, logs, updates. |
| **Process model** | Single process, LaunchAgent restart on crash | No supervisor. Graceful SIGTERM shutdown (drain in-flight, then exit). |
| **Concurrency** | TopicQueue (ordered per topic, parallel across) | Messages within a conversation are sequential. Different conversations run in parallel. |

---

## Architecture

### The Smart Loop

Cortex is a single-process event loop that does two things on each tick:

1. **Poll Telegram** for new messages
2. **Check the scheduler** for due jobs

Both produce "inbound messages" that flow through the same agent pipeline.

```
while (running) {
  // 1. Poll Telegram
  updates = telegram.poll(cursor)
  for (update of updates) {
    if (!isAllowedUser(update)) continue
    topicQueues.dispatch(topicKey(update), () => handleMessage(update))
  }

  // 2. Check scheduler
  dueJobs = scheduler.getDueJobs()
  for (job of dueJobs) {
    topicQueues.dispatch(job.topicKey, () => handleScheduledJob(job))
  }
}
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

  // Tool-calling loop (max 10 iterations)
  loop:
    response = synapse.chat(messages, tools)

    if response.hasToolCalls:
      for toolCall of response.toolCalls:
        result = skills.execute(toolCall)
        messages.push(toolCall, result)
      continue

    // Final text response
    break

  // Deliver and persist
  telegram.send(message.chatId, response.content)
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
                    +----------+
                    | Telegram |
                    +----+-----+
                         | poll / send
                         v
+--------------------------------------------------+
|                    loop.ts                        |
|  +--------------+              +--------------+   |
|  | Telegram     |              | Scheduler    |   |
|  | messages     |              | due jobs     |   |
|  +------+-------+              +------+-------+   |
|         +----------+---+--------------+           |
|                    v                              |
|            topics.ts (TopicQueue)                  |
|                    |                              |
|                    v                              |
|  +-----------------------------------------+     |
|  |              agent.ts                    |     |
|  |                                         |     |
|  |  engram.recall() --> prompt.build()     |     |
|  |  history.load() -->     |               |     |
|  |                         v               |     |
|  |                  synapse.chat()          |     |
|  |                     |                   |     |
|  |              +------+------+            |     |
|  |              | tool calls? |            |     |
|  |              +-yes-> skills.execute()   |     |
|  |              |       +---> loop back    |     |
|  |              +-no--> final response     |     |
|  +-----------------------------------------+     |
|                    |                              |
|         +----------+----------+                   |
|         v                     v                   |
|  telegram.send()    history.save()                |
|                         |                         |
|                    (every N turns, async)          |
|                         v                         |
|                  extraction.ts                     |
|                   |          |                     |
|                   v          v                     |
|            engram.remember  engram.upsert          |
|            (facts)          (topic summary)        |
+--------------------------------------------------+
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

Each extracted fact is stored via `engram.remember({ content, category, chat_id, thread_id })`.

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
  // Telegram
  telegramToken: string           // TELEGRAM_TOKEN env var
  allowedUserIds: string[]        // Telegram user IDs permitted to interact

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
  schedulerTickSeconds: number    // default: 60 (seconds between scheduler checks)

  // Server
  port: number                    // default: 7751 (health endpoint)
}
```

---

## SQLite Schema

Three tables. Minimal -- long-term knowledge lives in Engram, not here.

```sql
-- Recent conversation turns (the active window source)
CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_key TEXT NOT NULL,         -- "chatId:threadId" or "chatId:root"
  role TEXT NOT NULL,              -- "user" | "assistant"
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL       -- unix epoch ms
);
CREATE INDEX idx_turns_topic ON turns(topic_key, timestamp);

-- Tracks extraction progress per topic
CREATE TABLE extraction_cursors (
  topic_key TEXT PRIMARY KEY,
  last_extracted_turn_id INTEGER NOT NULL,
  turns_since_extraction INTEGER DEFAULT 0
);

-- User-created scheduled jobs
CREATE TABLE scheduler_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  description TEXT NOT NULL,       -- human-readable label
  cron TEXT NOT NULL,              -- cron expression (e.g. "0 7 * * *")
  action TEXT NOT NULL,            -- prompt text fed to the agent when job fires
  target_chat_id TEXT NOT NULL,    -- Telegram chat to send the response to
  created_by_user_id TEXT,         -- who created this schedule
  last_run_at INTEGER,             -- unix epoch ms
  next_run_at INTEGER,             -- precomputed next fire time
  enabled INTEGER DEFAULT 1
);
CREATE INDEX idx_jobs_next ON scheduler_jobs(next_run_at) WHERE enabled = 1;
```

Database location: `~/.local/share/cortex/cortex.db`

---

## Skills

### Framework

Skills are the bridge between the LLM and real-world capabilities. Each skill registers:

1. **Tool definition** -- an OpenAI function calling schema (name, description, parameters)
2. **Executor** -- an async function that runs when the LLM calls the tool

```typescript
interface Skill {
  name: string
  tools: ToolDef[]                    // OpenAI function definitions
  execute(call: ToolCall): Promise<string>  // returns result text
}

interface SkillRegistry {
  register(skill: Skill): void
  allToolDefs(): ToolDef[]            // aggregated from all skills
  execute(call: ToolCall): Promise<string>
}
```

The LLM receives all tool definitions in its prompt. When it returns tool calls, Cortex looks up the skill by tool name and executes it. Results are fed back to the model for the next iteration of the tool-calling loop.

Adding a new skill = adding a file to `src/skills/` and registering it. No changes to core architecture.

### Included Skills (Phase 2)

#### Calendar (`src/skills/calendar.ts`)

Reads Apple Calendar events via `osascript` (AppleScript/JXA). Runs on the Mac Mini where Calendar.app has the user's accounts.

**Tools:**
- `read_calendar` -- read events for a date range. Parameters: `startDate`, `endDate`. Returns structured event list.

#### Schedule (`src/skills/schedule.ts`)

CRUD for user-created scheduled jobs. The LLM uses these tools when users say things like "remind me every Monday to submit my timesheet."

**Tools:**
- `create_schedule` -- create a new cron job. Parameters: `description`, `cron`, `action` (prompt text), `target_chat_id`.
- `list_schedules` -- list all active schedules.
- `delete_schedule` -- remove a schedule by ID.

---

## File Structure

```
cortex/
  src/
    main.ts              # Entry point, health server (GET /health), SIGTERM handler
    config.ts            # Load config from file + env, validate, export typed config
    telegram.ts          # Telegram API client: poll(cursor), send(chatId, text)
    synapse.ts           # Synapse client: chat(messages, tools, model?) with SSE streaming
    engram.ts            # Engram client: remember(), recall(), forget(), upsert()
    db.ts                # SQLite: schema creation, turn/cursor/job queries
    loop.ts              # Main event loop: poll Telegram + scheduler tick -> dispatch
    agent.ts             # Tool-calling loop: build prompt -> synapse.chat -> execute tools -> repeat
    prompt.ts            # System prompt builder: persona + memories + summary + turns + tools
    history.ts           # Conversation history: load/save turns, window management, extraction trigger
    extraction.ts        # Async extraction: extract facts + update topic summary via cheap model
    topics.ts            # TopicQueue + TopicQueueMap for concurrent topic processing
    scheduler.ts         # Cron ticker: check due jobs, synthesize trigger messages, dispatch

    skills/
      index.ts           # Skill registry: register, allToolDefs, execute
      calendar.ts        # Apple Calendar skill (osascript)
      schedule.ts        # Schedule CRUD skill (SQLite)

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

**16 source files. ~1500-2000 lines estimated.** Flat `src/` directory, no `packages/`, no `adapters/`, no `ports/`.

---

## Build Order

### Phase 2: Cortex (10 vertical slices)

Each slice is a vertical cut through all layers. Build, test, validate before moving to the next.

#### Slice 0: Scaffold + Health

**What it proves:** Wilson can manage Cortex as a service.

**Scope:**
- `main.ts` -- HTTP server on `:7751`, `GET /health` returns `{ status: "healthy", version }`, SIGTERM handler
- `config.ts` -- load and validate config
- `package.json`, `tsconfig.json`, `biome.json`, `.gitignore`

**Acceptance criteria:** `bun run src/main.ts` starts, `curl localhost:7751/health` returns healthy.

#### Slice 1: Telegram Echo

**What it proves:** Telegram polling and sending works. TopicQueue concurrency works.

**Scope:**
- `telegram.ts` -- `poll(cursor)` and `send(chatId, text)`
- `loop.ts` -- main loop polling Telegram, dispatching to topic queues
- `topics.ts` -- `TopicQueue` + `TopicQueueMap`
- Auth check: reject messages from users not in `allowedUserIds`

**Acceptance criteria:** Send a message on Telegram, bot echoes it back. Messages in different chats process in parallel. Unauthorized users are silently ignored.

#### Slice 2: Synapse Reply (Tracer Bullet)

**What it proves:** Full end-to-end path works. This is the tracer bullet -- if this works, the architecture is proven.

**Scope:**
- `synapse.ts` -- chat completions client (tool-call aware, SSE streaming)
- `agent.ts` -- tool-calling loop (no tools yet, just pass-through)
- `prompt.ts` -- basic system prompt (persona, no memories/history yet)

**Acceptance criteria:** Send "Hello" on Telegram, get an LLM-generated response back via Synapse.

#### Slice 3: Engram Recall

**What it proves:** Memory-augmented responses. The model sees relevant context from past sessions.

**Scope:**
- `engram.ts` -- `recall(query)` and `remember(content, category)`
- Update `prompt.ts` to inject recalled memories into the system prompt

**Acceptance criteria:** Ask something that Engram has stored memories about. The response demonstrates awareness of stored context.

#### Slice 4: Turn History

**What it proves:** Conversational continuity. The model sees recent turns.

**Scope:**
- `db.ts` -- SQLite schema (turns table), turn queries
- `history.ts` -- load recent turns for a topic, save new turns, window management

**Acceptance criteria:** Multi-turn conversation works. Bot remembers what you said 5 messages ago in the same topic.

#### Slice 5: Fact Extraction

**What it proves:** Durable knowledge is automatically extracted from conversations.

**Scope:**
- `extraction.ts` -- async extraction pipeline (fact extraction via cheap model)
- Update `db.ts` with `extraction_cursors` table
- Update `history.ts` to trigger extraction every N turns

**Acceptance criteria:** Have a conversation mentioning a preference. After extraction runs, that preference appears in Engram. Start a new conversation on a different topic -- the preference surfaces via recall.

#### Slice 6: Topic Summaries

**What it proves:** Per-topic orientation survives across sessions.

**Pre-requisite:** Add `upsert` support to Engram (`POST /remember` with `{ upsert: true, idempotency_key: "..." }` overwrites instead of rejecting).

**Scope:**
- Update `extraction.ts` to generate and upsert topic summaries
- Update `prompt.ts` to include topic summary in the prompt

**Acceptance criteria:** Have a long conversation. Close Telegram, wait, come back. The bot's response shows awareness of what the conversation was about (via the topic summary), not just the last few turns.

#### Slice 7: Skill Framework

**What it proves:** Tool calling works end-to-end. The LLM can call tools and Cortex executes them.

**Scope:**
- `skills/index.ts` -- skill registry, `allToolDefs()`, `execute()`
- Wire tool definitions into `prompt.ts`
- Wire tool execution into `agent.ts` loop

**Acceptance criteria:** Register a trivial test skill (e.g., `get_current_time`). Ask "what time is it?" -- the LLM calls the tool and reports the result.

#### Slice 8: Schedule Skill

**What it proves:** Users can create persistent schedules via natural language. The scheduler fires them.

**Scope:**
- `skills/schedule.ts` -- `create_schedule`, `list_schedules`, `delete_schedule` tools
- `scheduler.ts` -- cron evaluation on 60s tick, dispatch synthetic messages through agent pipeline
- Update `db.ts` with `scheduler_jobs` table

**Acceptance criteria:** Say "remind me every day at 9am to drink water." Verify the job is created. Wait for 9am (or adjust cron for testing). Bot proactively sends a message.

#### Slice 9: Calendar Skill

**What it proves:** Cortex can read real-world data and reason about it.

**Scope:**
- `skills/calendar.ts` -- `read_calendar` tool using `osascript` to query Apple Calendar

**Acceptance criteria:** Ask "what's on my calendar today?" Bot returns actual calendar events from the Mac Mini's Calendar.app.

#### Slice 10: Deploy

**What it proves:** Cortex runs in production, managed by Wilson, auto-updates.

**Scope:**
- `scripts/install.sh` -- curl|bash installer
- `scripts/version-bump.ts` -- release helper
- `.github/workflows/ci.yml` + `release.yml`
- Update Wilson: add Cortex to service registry (`src/services.ts`) and `wilson-update.sh`

**Acceptance criteria:** `wilson status` shows Cortex healthy. `wilson update` can pull and deploy a new Cortex release. Bot survives a `kill` (LaunchAgent restarts it).

---

### Phase 3: First Skills

Phase 3 is pure accretion -- the architecture doesn't change. Each skill is a new file in `src/skills/` registered in the skill registry.

#### Preferences

Read/write user preferences stored in Engram. Examples: quiet hours, preferred name, notification preferences.

**Tools:**
- `get_preference` -- read a preference by key
- `set_preference` -- write a preference

**Engram storage pattern:** `category: "preference"`, content is `"key: value"` format.

#### Morning Briefing

A scheduled skill that composes calendar + reminders + any relevant context into a daily summary. Fires as a scheduled job (created by the user or pre-configured).

This is not a separate "skill" per se -- it's a scheduled job whose `action` prompt is something like: "Give me a morning briefing. Check my calendar for today, list any upcoming reminders, and surface anything important from recent conversations."

The agent uses the existing `read_calendar` and `list_schedules` tools plus Engram recall to compose the briefing. No new skill code needed -- just a well-crafted scheduled prompt.

#### Task Coaching

Help with task breakdown, deadline tracking, and accountability. Examples: trip preparation checklists, project milestone tracking, gentle nudges.

**Tools:**
- `create_task` -- create a task with optional deadline
- `list_tasks` -- list tasks by status
- `complete_task` -- mark a task done
- `breakdown_task` -- break a task into subtasks

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

Wilson's `src/services.ts` needs a new entry:

```typescript
cortex: {
  repo: "shetty4l/cortex",
  port: 7751,
  healthUrl: "http://localhost:7751/health",
  installPath: "~/srv/cortex/",
  cliPath: null,  // no CLI -- cortex is a daemon only
  versionFile: "~/srv/cortex/latest/version.txt",
  logPaths: { daemon: "~/srv/cortex/logs/daemon.log" }
}
```

Wilson's `deploy/wilson-update.sh` needs a Cortex update check alongside engram and synapse.

### Pre-requisite: Engram Upsert

Before slice 6 (topic summaries), Engram needs upsert support:

- Modify `POST /remember` to accept `{ upsert: true, idempotency_key: "..." }`
- If a memory with that idempotency_key exists in the same scope, **update its content** instead of rejecting as a duplicate
- Small change: ~20 lines in Engram's remember handler + a test
- Deliver as a PR to `shetty4l/engram`, release as a patch version

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
- Synapse PR #6 (uptime in status) pending merge
