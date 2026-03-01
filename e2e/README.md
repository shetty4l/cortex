# Wilson E2E Tests

End-to-end tests for the Wilson assistant system. These tests exercise the full stack: Thalamus → Inbox → Agent → Cerebellum → Wilson → Telegram.

## Prerequisites

1. **All services running locally:**
   - Cortex API (port 7751)
   - Synapse sync service
   - Wilson Telegram bot
   - Engram memory service

2. **Config files in place:**
   - `~/.config/cortex/config.json` - must include `ingestApiKey`
   - `~/.config/wilson/config.json` - must include `channels.telegram.botToken`

3. **Database files accessible:**
   - `~/.local/share/cortex/cortex.db`
   - `~/.local/share/wilson/wilson.db`

## Setup

1. Copy environment variables:
   ```bash
   cp .env.example .env
   ```

2. Fill in your `.env`:
   - `TEST_USER_ID` - Your Telegram user ID (numeric)
   - `TEST_SUPERGROUP_ID` - Supergroup ID for test threads (starts with -100)

3. Install dependencies:
   ```bash
   bun install
   ```

## Running Tests

```bash
# Run all tests (11 total: 6 source + 5 scenario)
bun run test

# Run only source tests (6 tests)
bun run test:sources

# Run only scenario tests (5 tests)
bun run test:scenarios

# Run a single test by name
bun run test:one 01-calendar-sync
bun run test:one calendar          # partial match also works
```

## Interpreting Results

### Console Output

Tests print results as they complete:
```
Running 11 test(s)...

  ✓ 01-calendar-sync (2.34s)
  ✓ 02-user-dm (5.12s)
  ✗ 03-existing-thread (1.23s)
    Expected thread to exist but not found

──────────────────────────────────────────────────
  10 passed, 1 failed in 45.67s
  Results written to results/2024-01-15T10-30-00-000Z.json
```

### JSON Results

Each run writes a JSON file to `results/` with:
```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "summary": {
    "total": 11,
    "passed": 10,
    "failed": 1,
    "totalDuration": 45670
  },
  "results": [
    {
      "name": "01-calendar-sync",
      "passed": true,
      "duration": 2340
    },
    {
      "name": "03-existing-thread",
      "passed": false,
      "duration": 1230,
      "error": "Expected thread to exist but not found"
    }
  ]
}
```

## Cleanup

Tests create artifacts with `[TEST]` prefix in topic keys and task titles. To clean up:

```bash
# Preview what will be deleted (no changes made)
bun run cleanup --dry-run

# Delete test artifacts from databases
bun run cleanup
```

The cleanup script removes:
- Topics with `[TEST]` in topic_key or starting with `test-`
- Tasks with `[TEST]` in title
- Related outbox messages and conversation history

## Test Structure

```
e2e/
├── lib/           # Shared helpers
│   ├── assert.ts    # Assertion helpers
│   ├── config.ts    # Config loader
│   ├── cortex.ts    # Cortex API helpers
│   ├── db.ts        # Database helpers
│   ├── telegram.ts  # Telegram API helpers
│   ├── types.ts     # Type definitions
│   └── wait.ts      # Polling/waiting helpers
├── tests/
│   ├── runner.ts    # Test runner
│   ├── sources/     # Single-source tests (6)
│   └── scenarios/   # Multi-component scenarios (5)
├── scripts/
│   └── cleanup.ts   # Artifact cleanup
└── results/         # JSON test results
```

## Source Tests

Test individual input sources:

| Test | Description |
|------|-------------|
| `01-calendar-sync` | Calendar buffer → notification |
| `02-user-dm` | Direct message → conversational reply |
| `03-existing-thread` | Message in existing thread |
| `04-new-thread` | Create new topic thread |
| `05-task-reminder` | Task creation → tick notification |
| `06-approval-response` | Approval flow |

## Scenario Tests

Test multi-component workflows:

| Test | Description |
|------|-------------|
| `a-calendar-to-reminder` | Calendar → task → reminder |
| `b-memory-recall` | Store preference → recall in context |
| `c-thread-to-calendar` | Thread + calendar routing |
| `d-overdue-conversation` | Task overdue → conversation |
| `e-dm-creates-thread` | DM → supergroup thread |

## Development

### Type Checking

```bash
bun run typecheck
```

### Adding New Tests

1. Create a new file in `tests/sources/` or `tests/scenarios/`
2. Export `name` (string) and `run()` (async function returning TestResult)
3. Use helpers from `lib/` for API calls, assertions, and waiting

Example test structure:
```typescript
import type { TestResult } from "../../lib";
import { someHelper } from "../../lib";

export const name = "07-new-test";

export async function run(): Promise<TestResult> {
  const start = Date.now();
  try {
    // Test implementation
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      duration: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
```

## Notes

- Tests run sequentially to avoid race conditions
- Timeouts: 60s for LLM responses, 10s for delivery
- Tests leave state for inspection; use cleanup script when done
- All test artifacts use `[TEST]` prefix for easy identification
