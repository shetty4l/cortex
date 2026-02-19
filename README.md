# Cortex

Channel-agnostic life assistant runtime with a tool-calling agent loop.

Cortex is the brain of the Wilson system. It ingests messages from any channel (Telegram, CLI, etc.), reasons through an LLM via Synapse, remembers through Engram, executes skills, and writes responses to an outbox for delivery.

```
                     Telegram
                        |
                        v
                 +--------------+
                 |    Cortex    |  :7751
                 +------+-------+
                        |
           +------------+------------+
           |                         |
    +------v-------+         +------v-------+
    |    Synapse    |  :7750  |    Engram    |  :7749
    |  LLM proxy   |         |   Memory     |
    +--------------+         +--------------+
```

| Service | Purpose | Port |
|---------|---------|------|
| [Engram](https://github.com/shetty4l/engram) | Persistent semantic memory (FTS5 + decay + embeddings) | 7749 |
| [Synapse](https://github.com/shetty4l/synapse) | OpenAI-compatible LLM proxy with provider failover | 7750 |
| **Cortex** | Life assistant runtime: ingest, agent loop, outbox delivery | 7751 |

## Install

```sh
curl -fsSL https://github.com/shetty4l/cortex/releases/latest/download/install.sh | bash
```

Requires [Bun](https://bun.sh), `curl`, `tar`, and `jq`. Installs to `~/srv/cortex/` and symlinks the CLI to `~/.local/bin/cortex`.

## Quick start

```sh
# start cortex in the background
cortex start

# verify it's running
curl http://localhost:7751/health

# send a test message
cortex send "hello"

# send on a fixed topic (multi-turn conversation)
cortex send "what did I just say?" --topic test-topic
```

## Configuration

Config is loaded from `~/.config/cortex/config.json` with environment variable overrides. String values support `${ENV_VAR}` interpolation.

### Example config

```json
{
  "host": "127.0.0.1",
  "port": 7751,
  "ingestApiKey": "${CORTEX_INGEST_API_KEY}",
  "synapseUrl": "http://localhost:7750",
  "engramUrl": "http://localhost:7749",
  "model": "gpt-oss:20b",
  "extractionModel": "qwen2.5:3b",
  "activeWindowSize": 10,
  "extractionInterval": 3,
  "turnTtlDays": 30
}
```

### Key fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `ingestApiKey` | yes | -- | Bearer token for API authentication |
| `model` | yes | -- | Conversation model (routed through Synapse) |
| `extractionModel` | no | -- | Cheap model for fact extraction (omit to disable extraction) |
| `synapseUrl` | no | `http://localhost:7750` | Synapse LLM proxy URL |
| `engramUrl` | no | `http://localhost:7749` | Engram memory service URL |
| `activeWindowSize` | no | `10` | Recent turns to include in the prompt |
| `extractionInterval` | no | `3` | Turns between extraction runs |
| `turnTtlDays` | no | `30` | Days before old turns are deleted |

### Environment variables

| Variable | Description |
|----------|-------------|
| `CORTEX_PORT` | Override the listening port |
| `CORTEX_HOST` | Override the bind address |
| `CORTEX_INGEST_API_KEY` | Set the ingest API key |
| `CORTEX_MODEL` | Set the conversation model |
| `CORTEX_CONFIG_PATH` | Override the config file path |

## API

All routes require a `Bearer` token matching `ingestApiKey`.

### `GET /health`

Health check (no auth required).

```sh
curl http://localhost:7751/health
```

```json
{
  "status": "healthy",
  "version": "0.0.1",
  "uptime": 3600
}
```

### `POST /ingest`

Channel-agnostic event ingress. Connectors (Telegram, CLI, etc.) post messages here.

```sh
curl -X POST http://localhost:7751/ingest \
  -H "Authorization: Bearer $CORTEX_INGEST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "telegram",
    "externalMessageId": "msg-123",
    "idempotencyKey": "telegram:msg-123",
    "topicKey": "chat:456",
    "userId": "user-1",
    "text": "What is on my calendar today?",
    "occurredAt": "2026-02-19T12:00:00Z"
  }'
```

```json
{ "eventId": "evt_abc123", "status": "queued" }
```

Duplicate messages (same `source` + `externalMessageId`) return `{ "status": "duplicate_ignored" }`.

### `POST /outbox/poll`

Connectors claim pending outbox messages for delivery.

```sh
curl -X POST http://localhost:7751/outbox/poll \
  -H "Authorization: Bearer $CORTEX_INGEST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "source": "telegram", "max": 10 }'
```

```json
{
  "messages": [
    {
      "id": "out_xyz",
      "source": "telegram",
      "topic_key": "chat:456",
      "text": "You have a meeting at 2pm.",
      "lease_token": "lease_abc",
      "lease_expires_at": 1708348800000
    }
  ]
}
```

### `POST /outbox/ack`

Confirm delivery of an outbox message.

```sh
curl -X POST http://localhost:7751/outbox/ack \
  -H "Authorization: Bearer $CORTEX_INGEST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "messageId": "out_xyz", "leaseToken": "lease_abc" }'
```

```json
{ "ok": true, "status": "delivered" }
```

## CLI

```
cortex start          Start the server (background daemon)
cortex stop           Stop the daemon
cortex status         Show daemon status
cortex restart        Restart the daemon
cortex serve          Start the server (foreground)
cortex health         Check health of running instance
cortex config         Print resolved configuration
cortex logs [n]       Show last n log lines (default: 20)
cortex send "msg"     Send a message and wait for response
cortex inbox          Show recent inbox messages
cortex outbox         Show recent outbox messages
cortex purge          Purge all inbox and outbox messages
cortex version        Show version
```

All commands support `--json` for machine-readable output. `cortex send` supports `--topic ID` for multi-turn conversations. `cortex purge` requires `--confirm`.

## How it works

Cortex is a single-process runtime built around the **Smart Loop** pattern -- a minimal message loop enhanced with LLM tool-calling:

1. **Ingest**: Connectors post messages to `POST /ingest`, writing durable inbox rows
2. **Process**: The loop claims the next inbox message, builds context (memories + history + system prompt), and calls Synapse for a chat completion
3. **Deliver**: The assistant response is written to the outbox. Connectors poll and acknowledge delivery.

### Dual memory

Cortex splits conversation history into two layers:

- **Short-term (SQLite)**: Recent turns stored verbatim -- the last 10 turns per topic. Provides conversational continuity.
- **Long-term (Engram)**: Durable facts, preferences, and decisions extracted from conversations and stored as individual semantic memories. Recalled by relevance, not recency -- a preference stated months ago in a different topic surfaces when relevant.

An async **extraction pipeline** runs every N turns (configurable), using a cheap model to extract facts and store them in Engram. Each topic also maintains a rolling summary for orientation when returning to a conversation after hours or days.

For full architecture details, see [docs/architecture.md](docs/architecture.md).

## Development

```sh
bun install              # install dependencies
bun run start            # start the server
bun run test             # run tests
bun run typecheck        # type check
bun run lint             # lint with oxlint
bun run format           # format with biome (auto-fix)
bun run format:check     # check formatting
bun run validate         # run all checks (typecheck + lint + format + test)
```

### Tooling

- **Runtime**: [Bun](https://bun.sh) -- runs TypeScript directly, no build step
- **Type checking**: TypeScript (strict mode)
- **Formatting**: [Biome](https://biomejs.dev)
- **Linting**: [oxlint](https://oxc.rs)
- **Git hooks**: [Husky](https://typicode.github.io/husky/) -- pre-commit runs `bun run validate`

## CI/CD

- **CI** runs on all PRs and pushes to `main`: typecheck, lint, format check, tests
- **Release** runs automatically after CI passes on `main`: computes semver bump from commit markers, creates a git tag and GitHub release with a source tarball

Version bumps:

```sh
bun run version:bump minor   # next release will be a minor bump
bun run version:bump major   # next release will be a major bump
# patch bumps happen automatically if no marker is found
```

## License

MIT
