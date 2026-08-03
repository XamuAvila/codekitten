---
id: "KIT-016"
status: "done"
priority: "medium"
assignee: ""
epic: "v3-llm-integration"
dueDate: null
created: "2026-08-03"
modified: "2026-08-03"
completedAt: "2026-08-03"
labels: ["commands", "lifecycle"]
order: "c6"
---

# Stop Review Command

## User Story

See [US-016](../../docs/stories/US-016-stop-review.md).

## Technical Refinement

### Files

**Modified (shared):**
- `packages/shared/src/types/review-status.ts` — `ReviewJobStatusSchema.status` enum (line 9): add `"cancelled"`

**Modified (reviewer):**
- `packages/reviewer/src/redis/status.ts` — `TERMINAL_STATUSES` (line 13): add `"cancelled"` (sets `completedAt`, matches `reportStatus` behavior)
- `packages/reviewer/src/index.ts` — **restructure startup**: report `"running"` and subscribe to the message channel BEFORE `runPipeline` (today nothing sets `running` — dispatcher only writes `queued` at `routes/review.ts:39-50` — and the agent subscribes only after the pipeline at `agent.ts:98`, so a `stop` during chunks would be silently lost: Redis pub/sub is fire-and-forget, `message.ts:14-15`). Shared `AbortController` created here, passed to pipeline + agent
- `packages/reviewer/src/agent.ts` — dispatch `"stop"` command; `onStop` callback; abort in-flight chunk review via the shared `AbortController`; the subscription moves here but is started before the pipeline (from `index.ts`)
- `packages/reviewer/src/pipeline.ts` — chunk loop checks `signal.aborted` (AbortSignal threaded via `PipelineConfig`)

**Modified (dispatcher):**
- `packages/dispatcher/src/routes/message.ts` — `TERMINAL_STATUSES` (line 8): add `"cancelled"` (follow-up to cancelled job → 404, US-016 AC-5/6)

**Modified (tests):**
- `packages/shared/tests/types/review-status.test.ts` — **NEW file** (the status enum lives in `review-status.ts:9`; `review-job.test.ts` only covers `ReviewJobSchema`), `packages/reviewer/tests/redis/status.test.ts`, `packages/reviewer/tests/agent.test.ts`, `packages/dispatcher/tests/routes/message.test.ts` (RED for the dispatcher change), `packages/reviewer/tests/pipeline.test.ts` (abort between chunks)

### Consumes

- `handleMessage` in `agent.ts:80-96` — command dispatch pattern from KIT-015
- Shutdown path in `agent.ts:51-70` — graceful shutdown with status report
- Chunk loop in `pipeline.ts` (KIT-014) — must be abortable
- `reportStatus` (`packages/reviewer/src/redis/status.ts:20-36`)

### Produces

- `startAgent` accepts `onStop: () => Promise<void>` — invoked when a follow-up message equals `"stop"`; aborts the in-flight chunk review (AbortSignal), posts a `Review cancelled` comment (via existing `postReviewComment` pattern with `[KITTEN-TEST]` prefix), reports `cancelled` status, shuts down cleanly
- `"cancelled"` in the status enum + `TERMINAL_STATUSES` in reviewer and dispatcher
- Chunk loop accepts an `AbortSignal` — checked between chunks and before each LLM call

### Design decisions

1. **`stop` maps to graceful shutdown with `cancelled` status** — reuses the existing shutdown path (`agent.ts:51-70`) but with a distinct status so completed vs cancelled are distinguishable (US-016 AC-2). User decision: `cancelled` is a first-class status.
2. **AbortSignal between chunks, not mid-call** — aborting mid-LLM-call is wasteful/complex; the signal is checked before each chunk call and between chunks. Remaining chunks are skipped, already-completed chunks are kept (their findings are lost — the review is cancelled, not partial).
3. **Dispatchers treat `cancelled` as terminal** — `POST /message` to a cancelled job returns 404 (`NOT_FOUND`, "Job {jobId} is no longer active" — `message.ts:42`), matching `completed`/`failed` handling (US-016 AC-6).
4. **`stop` on a `reviewing` Pod** — allowed; the Pod shuts down and status becomes `cancelled` (US-016 AC-4). The Pod is not mid-review at that point but the user's intent is to end it.
5. **Subscription moves BEFORE the pipeline** — a `stop` sent during chunks must reach the Pod. Redis pub/sub is fire-and-forget (no queue), so the only reliable design is: `index.ts` reports `running`, subscribes to the channel, creates the `AbortController`, then runs the pipeline; the agent's message handler dispatches `stop` → `controller.abort()` → chunk loop stops at the next boundary. This replaces the agent-only subscription (`agent.ts:98` — after the pipeline) with an earlier one.

### Risks

1. **Subscription lifecycle across pipeline and agent** — the subscriber connection now lives from before `runPipeline` until shutdown. The agent's `shutdown` (`agent.ts:55-66`) must unsubscribe from the same subscription object. Tested with a mocked slow chunk + a `stop` message arriving mid-pipeline (step 10).
2. **AbortController wiring across pipeline/agent** — one shared controller created in `index.ts`, threaded through `PipelineConfig` (pipeline checks `signal.aborted` between chunks) and into `startAgent` (stop dispatch aborts it).

## Implementation Plan

1. - [ ] **RED — status enum test**: create `packages/shared/tests/types/review-status.test.ts` — `"cancelled"` is a valid status; schema rejects `"cancelling"`. Run: FAIL.
2. - [ ] **GREEN — enum**: add `"cancelled"` to `ReviewJobStatusSchema.status` (`review-status.ts:9`). PASS.
3. - [ ] Commit: `feat(shared): add cancelled status to review lifecycle`
4. - [ ] **RED — status.ts terminal test**: `packages/reviewer/tests/redis/status.test.ts` — `reportStatus(redis, job, "cancelled")` sets `completedAt`. Run: FAIL.
5. - [ ] **GREEN — TERMINAL_STATUSES (reviewer)**: add `"cancelled"` in `packages/reviewer/src/redis/status.ts:13`. PASS.
6. - [ ] **RED — dispatcher message test**: `packages/dispatcher/tests/routes/message.test.ts` — a follow-up to a `cancelled` job returns 404 `{ code: "NOT_FOUND" }`. Run: FAIL.
7. - [ ] **GREEN — TERMINAL_STATUSES (dispatcher)**: add `"cancelled"` in `packages/dispatcher/src/routes/message.ts:8`. PASS.
8. - [ ] Commit: `feat: treat cancelled as terminal status in reviewer and dispatcher`
9. - [ ] **RED — chunk abort test**: `packages/reviewer/tests/pipeline.test.ts` — a chunk loop given an aborted signal performs zero LLM calls; signal aborted mid-loop skips remaining chunks (mocked adapter counts calls). Run: FAIL.
10. - [ ] **GREEN — AbortSignal in chunk loop**: thread `signal` through `PipelineConfig` → chunk loop. PASS.
11. - [ ] Commit: `feat(reviewer): make chunk review abortable`
12. - [ ] **RED — startup restructure test**: `packages/reviewer/tests/agent.test.ts` or a new `index` wiring test — a `stop` message arriving while the pipeline is mid-chunks (mocked slow adapter) aborts the loop: zero further LLM calls, `reportStatus("cancelled")` called, `Review cancelled` comment posted. Also: status `"running"` is reported BEFORE the pipeline runs. Run: FAIL.
13. - [ ] **GREEN — index.ts restructure**: report `running`, subscribe before `runPipeline`, shared `AbortController`; agent `onStop` dispatch (case-insensitive trim) → abort + cancelled status + comment + shutdown. PASS.
14. - [ ] Commit: `feat(reviewer): wire stop command end-to-end with cancelled status`
15. - [ ] Run: `pnpm test && pnpm lint` — all green.

## How to Test

- **Automated**: `pnpm test` — `packages/shared/tests/types/review-job.test.ts` (cancelled valid), `packages/reviewer/tests/redis/status.test.ts` (completedAt set), `packages/reviewer/tests/pipeline.test.ts` (abort skips chunks), `packages/reviewer/tests/agent.test.ts` (stop dispatch), `packages/dispatcher/tests/routes/message.test.ts` (cancelled → 404). All PASS.
- **Manual verification**: on minikube with a slow fixture (or low budget forcing many chunks), trigger a review; while `running`, `curl -X POST $DISPATCHER_URL/review/<jobId>/message -d '{"message":"stop","sender":"dev"}'` → `GET /status/<jobId>` returns `{ "status": "cancelled", "completedAt": ... }`; PR gets a `Review cancelled` comment; `kubectl get pod -n kitten` shows the Pod exited (Succeeded/not found).
- **Negative check**: `stop` on a completed job → 404 `{ code: "NOT_FOUND", message: "Job {jobId} is no longer active" }` and status stays `"completed"` (US-016 AC-6); `stop` before chunks finish → no further LLM calls (verify in logs: chunk N+1 never starts); `stop` message content `"STOP "` (uppercase+space) also stops.
- **Done means**: `pnpm test` green; stop mid-review aborts remaining chunks, reports `cancelled` with `completedAt`, posts `Review cancelled`, Pod exits; follow-ups to cancelled jobs are rejected with 404.
