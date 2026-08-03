---
id: "KIT-016"
status: "backlog"
priority: "medium"
assignee: ""
epic: "v3-llm-integration"
dueDate: null
created: "2026-08-03"
modified: "2026-08-03"
completedAt: null
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
- `packages/reviewer/src/agent.ts` — dispatch `"stop"` command; `onStop` callback; abort in-flight chunk review
- `packages/reviewer/src/index.ts` — wire `onStop`

**Modified (dispatcher):**
- `packages/dispatcher/src/routes/message.ts` — `TERMINAL_STATUSES` (line 8): add `"cancelled"` (follow-up to cancelled job → 404, US-016 AC-5/6)

**Modified (tests):**
- `packages/shared/tests/types/review-job.test.ts`, `packages/reviewer/tests/redis/status.test.ts`, `packages/reviewer/tests/agent.test.ts`, `packages/dispatcher/tests/routes/message.test.ts`

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
3. **Dispatchers treat `cancelled` as terminal** — `POST /message` to a cancelled job returns 404 (`NOT_FOUND`, "no longer active"), matching `completed`/`failed` handling (US-016 AC-6).
4. **`stop` on a `reviewing` Pod** — allowed; the Pod shuts down and status becomes `cancelled` (US-016 AC-4). The Pod is not mid-review at that point but the user's intent is to end it.

### Risks

1. **Chunk loop and agent message flow race** — the chunk loop runs inside the pipeline, which runs before the agent subscribes (`index.ts:52-80`). `stop` mid-pipeline can only arrive after `reviewing` status... but `stop` must also work mid-chunks. Mitigation: pipeline reports `running` status; the agent subscribes immediately when chunks start (restructure: subscribe in pipeline for the running phase or accept the small window where stop is queued and handled at chunk boundary via a shared AbortController).
2. **AbortController wiring across pipeline/agent** — keep the signal in `PipelineConfig`; the agent creates it and hands it in; tested with a mocked slow chunk.

## Implementation Plan

1. - [ ] **RED — status enum test**: `packages/shared/tests/types/review-job.test.ts` — `"cancelled"` is a valid status; schema rejects `"cancelling"`. Run: FAIL.
2. - [ ] **GREEN — enum**: add `"cancelled"` to `ReviewJobStatusSchema.status`. PASS.
3. - [ ] Commit: `feat(shared): add cancelled status to review lifecycle`
4. - [ ] **RED — status.ts terminal test**: `packages/reviewer/tests/redis/status.test.ts` — `reportStatus(redis, job, "cancelled")` sets `completedAt`. Run: FAIL.
5. - [ ] **GREEN — TERMINAL_STATUSES**: add `"cancelled"` in `packages/reviewer/src/redis/status.ts:13` and `packages/dispatcher/src/routes/message.ts:8`. PASS.
6. - [ ] Commit: `feat: treat cancelled as terminal status in reviewer and dispatcher`
7. - [ ] **RED — chunk abort test**: `packages/reviewer/tests/pipeline.test.ts` — a chunk loop given an aborted signal performs zero LLM calls; signal aborted mid-loop skips remaining chunks (mocked adapter counts calls). Run: FAIL.
8. - [ ] **GREEN — AbortSignal in chunk loop**: thread `signal` through `PipelineConfig` → chunk loop. PASS.
9. - [ ] Commit: `feat(reviewer): make chunk review abortable`
10. - [ ] **RED — agent stop test**: `packages/reviewer/tests/agent.test.ts` — follow_up `"stop"` invokes `onStop` once; `"force"` does not; idle timer not fired for stop. Run: FAIL.
11. - [ ] **GREEN — agent dispatch**: add `onStop` to `startAgent`; dispatch `"stop"` (case-insensitive trim, like force). PASS.
12. - [ ] Commit: `feat(reviewer): dispatch stop command in agent lifecycle`
13. - [ ] **RED — stop full-flow test**: `index.ts` wiring: stop → abort signal → `reportStatus("cancelled")` → `Review cancelled` comment posted → clean shutdown. Run: FAIL.
14. - [ ] **GREEN — wiring**. PASS.
15. - [ ] Commit: `feat(reviewer): wire stop command end-to-end with cancelled status`
16. - [ ] Run: `pnpm test && pnpm lint` — all green.

## How to Test

- **Automated**: `pnpm test` — `packages/shared/tests/types/review-job.test.ts` (cancelled valid), `packages/reviewer/tests/redis/status.test.ts` (completedAt set), `packages/reviewer/tests/pipeline.test.ts` (abort skips chunks), `packages/reviewer/tests/agent.test.ts` (stop dispatch), `packages/dispatcher/tests/routes/message.test.ts` (cancelled → 404). All PASS.
- **Manual verification**: on minikube with a slow fixture (or low budget forcing many chunks), trigger a review; while `running`, `curl -X POST $DISPATCHER_URL/review/<jobId>/message -d '{"message":"stop","sender":"dev"}'` → `GET /status/<jobId>` returns `{ "status": "cancelled", "completedAt": ... }`; PR gets a `Review cancelled` comment; `kubectl get pod -n kitten` shows the Pod exited (Succeeded/not found).
- **Negative check**: `stop` on a completed job → 404 `{ code: "NOT_FOUND" }` and status stays `"completed"` (US-016 AC-6); `stop` before chunks finish → no further LLM calls (verify in logs: chunk N+1 never starts); `stop` message content `"STOP "` (uppercase+space) also stops.
- **Done means**: `pnpm test` green; stop mid-review aborts remaining chunks, reports `cancelled` with `completedAt`, posts `Review cancelled`, Pod exits; follow-ups to cancelled jobs are rejected with 404.
