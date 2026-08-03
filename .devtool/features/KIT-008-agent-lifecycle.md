---
id: "KIT-008"
status: "backlog"
priority: "high"
assignee: ""
epic: "v2-github-integration"
dueDate: null
created: "2026-08-03"
modified: "2026-08-03"
completedAt: null
labels: ["reviewer", "redis"]
order: "b3"
---

# Agent Lifecycle

## User Story

See [US-008](../../docs/stories/US-008-agent-lifecycle.md).

## Technical Refinement

### Files

**Created:**
- `packages/reviewer/src/agent.ts` — `startAgent(config: AgentConfig): Promise<void>`: subscribes to Redis pub/sub channel, manages idle timer, handles incoming messages (follow_up resets timer, shutdown exits), triggers graceful shutdown on timeout or SIGTERM
- `packages/reviewer/src/redis/status.ts` — `reportStatus(redis, jobId, status): Promise<void>` writes to Redis hash `review:{jobId}:status`; `incrementFollowUpCount(redis, jobId): Promise<number>` atomically increments `followUpCount` field
- `packages/reviewer/src/redis/pubsub.ts` — `subscribeToChannel(subscriber, channel, handler): Promise<void>` wraps ioredis subscribe + message event; `parseMessage(raw: string): PubSubMessage` validates JSON against PubSubMessage shape, throws on invalid
- `packages/reviewer/tests/agent.test.ts` — idle timer fires shutdown, message resets timer, shutdown message exits, SIGTERM graceful shutdown
- `packages/reviewer/tests/redis/status.test.ts` — reportStatus writes correct hash fields, incrementFollowUpCount returns new count
- `packages/reviewer/tests/redis/pubsub.test.ts` — parseMessage valid/invalid, subscribeToChannel calls subscribe and wires handler

**Modified:**
- `packages/reviewer/src/index.ts` (KIT-007 baseline) — after `runPipeline()` completes, call `startAgent()` with config derived from env vars. Pipeline success → agent starts; pipeline failure → skip agent, report `failed`, exit.

### Consumes

From KIT-007 (`packages/reviewer`):
- `runPipeline()` — must complete before agent starts. Pipeline produces `PipelineResult` with dry-run data.
- `packages/reviewer/src/index.ts` — entrypoint where agent startup is added.
- Environment variables: `REDIS_URL`, `REVIEW_JOB_ID`, `POD_IDLE_TIMEOUT_MS`.

From KIT-006 (`packages/dispatcher`):
- Dispatcher publishes `PubSubMessage` JSON to channel `review:{jobId}:messages` when `POST /review/:jobId/message` is called.
- Dispatcher creates initial Redis hash `review:{jobId}:status` with `status: "queued"`.

From `@kitten/shared`:
- `PubSubMessage` type — `{ type: "follow_up" | "shutdown", payload, timestamp }`.
- `ReviewJobStatus` type — shape of Redis hash fields.
- `FollowUpMessage` type — payload of follow_up messages.
- `AppError` type — for error field in status.

### Produces

- Agent lifecycle capability: Pod stays alive after pipeline, subscribes to Redis channel, handles follow-up and shutdown messages, exits on idle timeout.
- Status reporting: Pod updates `review:{jobId}:status` Redis hash throughout lifecycle (running → reviewing → completed/failed).
- Follow-up count tracking: `followUpCount` incremented on each follow_up message — queryable via dispatcher `GET /status/:jobId`.
- Graceful SIGTERM handling: K8s sends SIGTERM before killing Pod; agent reports `completed` and exits cleanly.

### Design decisions

1. **Separate Redis connections for pub/sub and status** — ioredis subscriber connection enters "subscriber mode" and cannot run regular commands (GET, HSET). Agent creates two connections: one for `subscribe`, one for `reportStatus` / `incrementFollowUpCount`. Rejected: single connection switching modes (ioredis doesn't support this).
2. **Idle timer via setTimeout, reset on each message** — `setTimeout` with `clearTimeout` + re-set on every incoming message. Simpler than interval-based polling and integrates naturally with Node.js event loop. Rejected: polling interval that checks "last message timestamp" (unnecessary overhead, more moving parts).
3. **SIGTERM handler for graceful K8s shutdown** — `process.on("SIGTERM", ...)` reports `completed` status, unsubscribes from channel, closes both Redis connections, then `process.exit(0)`. K8s default grace period is 30s — enough for cleanup. Rejected: ignoring SIGTERM (status stays `reviewing` forever).
4. **Status stored as Redis hash at `review:{jobId}:status`** — each field of `ReviewJobStatus` is a hash field. Enables atomic field updates (`HINCRBY` for followUpCount, `HSET` for status). Rejected: JSON blob in a string key (requires read-modify-write, race-prone).
5. **Timer reset is synchronous with message processing** — `clearTimeout` called immediately on message arrival, before async processing. Prevents race where idle timeout fires during follow-up handling. Rejected: resetting after processing completes (window where timeout could fire mid-processing).

### Risks

1. **Redis disconnect during pub/sub** — if Redis goes down, subscriber loses connection and stops receiving messages. Mitigation: ioredis auto-reconnect is on by default, but messages published while disconnected are lost (pub/sub is fire-and-forget). Pod will eventually idle-timeout and exit — acceptable for v2.
2. **Race between idle timeout and incoming message** — timer reset must happen before any async work in the message handler. Implementation uses synchronous `clearTimeout` as the first line of the handler, before any `await`.
3. **SIGTERM during status write** — if K8s sends SIGTERM while `reportStatus` is mid-write, the status might not update. Mitigation: SIGTERM handler awaits `reportStatus("completed")` with a 5s timeout before exiting.

## Implementation Plan

1. - [ ] **Test (RED):** Write `packages/reviewer/tests/redis/pubsub.test.ts` — test `parseMessage('{"type":"follow_up","payload":{"message":"explain","sender":"test"},"timestamp":"2026-08-03T00:00:00Z"}')`: returns typed `PubSubMessage` with correct fields. Test `parseMessage('not json')`: throws with structured error. Test `parseMessage('{"type":"invalid"}')`: throws validation error (unknown type). Command: `pnpm test -- packages/reviewer/tests/redis/pubsub.test.ts` — expected: FAIL (module does not exist).
2. - [ ] **Implement (GREEN):** Create `packages/reviewer/src/redis/pubsub.ts` with `parseMessage()` — JSON.parse + validate type field is "follow_up" | "shutdown", validate payload shape. Create `subscribeToChannel(subscriber, channel, handler)` — calls `subscriber.subscribe(channel)`, wires `subscriber.on("message", ...)` filtering by channel, calls handler with parsed message. Command: `pnpm test -- packages/reviewer/tests/redis/pubsub.test.ts` — expected: PASS.
3. - [ ] Commit: `feat: add Redis pub/sub message parsing and subscription`
4. - [ ] **Test (RED):** Write `packages/reviewer/tests/redis/status.test.ts` — mock ioredis. Test `reportStatus(redis, "job-1", "running")`: verify `redis.hset("review:job-1:status", "status", "running")` called. Test `reportStatus` with `"completed"` also sets `completedAt` to ISO timestamp. Test `incrementFollowUpCount(redis, "job-1")`: verify `redis.hincrby("review:job-1:status", "followUpCount", 1)` called, returns new count. Command: `pnpm test -- packages/reviewer/tests/redis/status.test.ts` — expected: FAIL.
5. - [ ] **Implement (GREEN):** Create `packages/reviewer/src/redis/status.ts` — `reportStatus()` uses `hset` with field map; when status is `"completed"` or `"failed"`, also sets `completedAt` and computes `durationMs` from `createdAt`. `incrementFollowUpCount()` uses `hincrby`. Command: `pnpm test -- packages/reviewer/tests/redis/status.test.ts` — expected: PASS.
6. - [ ] Commit: `feat: add Redis status reporting for reviewer Pod`
7. - [ ] **Test (RED):** Write `packages/reviewer/tests/agent.test.ts` — use `vi.useFakeTimers()`. Test "idle timer fires shutdown after timeout": create agent with 1000ms timeout, advance timers by 1000ms, verify `reportStatus` called with `"completed"` and `process.exit(0)`. Test "message resets idle timer": create agent, receive follow_up message at t=500ms, advance to t=1000ms (original timeout), verify NOT shut down, advance to t=1500ms (500+1000), verify shutdown. Test "shutdown message exits immediately": send shutdown message, verify `reportStatus("completed")` called and `process.exit(0)` called without waiting for timeout. Test "follow_up increments counter": send follow_up, verify `incrementFollowUpCount` called. Command: `pnpm test -- packages/reviewer/tests/agent.test.ts` — expected: FAIL.
8. - [ ] **Implement (GREEN):** Create `packages/reviewer/src/agent.ts` — `startAgent(config)`: creates two ioredis clients (status + subscriber), calls `reportStatus("reviewing")`, calls `subscribeToChannel()` with handler that dispatches on message type, starts idle timer. Idle timer callback: report completed, unsubscribe, quit both connections, exit. SIGTERM handler: same cleanup sequence. Command: `pnpm test -- packages/reviewer/tests/agent.test.ts` — expected: PASS.
9. - [ ] Commit: `feat: add agent lifecycle with idle timer and pub/sub`
10. - [ ] **Integrate with index.ts:** Modify `packages/reviewer/src/index.ts` — after `runPipeline()` returns successfully, call `startAgent({ redisUrl, jobId, idleTimeoutMs })`. If pipeline fails, call `reportStatus("failed")` and exit with code 1. Command: `pnpm test -- packages/reviewer/tests/` — expected: all PASS (existing pipeline tests + new agent tests).
11. - [ ] Commit: `feat: integrate agent lifecycle into reviewer entrypoint`
12. - [ ] Run full suite: `pnpm test && pnpm lint` — expected: all green.

## How to Test

- **Automated**: `pnpm test -- packages/reviewer/tests/redis/ packages/reviewer/tests/agent.test.ts` — all tests pass:
  - `parseMessage returns PubSubMessage for valid follow_up JSON`
  - `parseMessage returns PubSubMessage for valid shutdown JSON`
  - `parseMessage throws on invalid JSON`
  - `parseMessage throws on unknown message type`
  - `subscribeToChannel subscribes and wires message handler`
  - `reportStatus writes status to Redis hash`
  - `reportStatus sets completedAt on terminal status`
  - `incrementFollowUpCount calls hincrby and returns count`
  - `agent shuts down after idle timeout`
  - `agent resets idle timer on follow_up message`
  - `agent exits immediately on shutdown message`
  - `agent increments follow-up counter on follow_up`
  - `agent handles SIGTERM gracefully`
- **Manual verification**:
  1. Start Redis locally: `docker compose up redis -d`
  2. Set env vars and run reviewer as Node process: `REDIS_URL=redis://localhost:6379 REVIEW_JOB_ID=test-job-1 POD_IDLE_TIMEOUT_MS=30000 node packages/reviewer/dist/index.js`
  3. In another terminal, publish a follow_up: `redis-cli PUBLISH review:test-job-1:messages '{"type":"follow_up","payload":{"message":"hello","sender":"test"},"timestamp":"2026-08-03T00:00:00Z"}'`
  4. Verify reviewer log: `Follow-up received from test: "hello"` and `Idle timer reset`
  5. Check status: `redis-cli HGETALL review:test-job-1:status` — `status=reviewing`, `followUpCount=1`
  6. Wait 30s (shortened timeout) — verify reviewer exits: `Status: completed`, process exits
  7. Check status: `redis-cli HGETALL review:test-job-1:status` — `status=completed`, `completedAt` set
- **Negative check**: Publish invalid JSON to channel: `redis-cli PUBLISH review:test-job-1:messages 'not json'` — reviewer logs error but does NOT crash (continues listening). Publish unknown type: `redis-cli PUBLISH review:test-job-1:messages '{"type":"unknown","payload":{},"timestamp":"..."}'` — reviewer logs warning, ignores message, idle timer NOT reset.
- **Done means**: `reviewer process starts agent after pipeline → subscribes to Redis channel → follow_up message resets idle timer and increments counter → idle timeout triggers graceful shutdown with status=completed → SIGTERM also shuts down gracefully`.
