---
id: "KIT-015"
status: "backlog"
priority: "medium"
assignee: ""
epic: "v3-llm-integration"
dueDate: null
created: "2026-08-03"
modified: "2026-08-03"
completedAt: null
labels: ["commands", "llm"]
order: "c5"
---

# Force Full Review Command

## User Story

See [US-015](../../docs/stories/US-015-force-full-review.md).

## Technical Refinement

### Files

**Modified (reviewer):**
- `packages/reviewer/src/agent.ts` — command dispatch in `handleMessage` (lines 80-96): recognize `"force"`; re-run review without budget; reset idle timer on command
- `packages/reviewer/src/pipeline.ts` — export a `runPipeline` variant or option: `runPipeline(config, { ignoreBudget: true })`
- `packages/reviewer/src/types.ts` — `PipelineConfig` gains `ignoreBudget?: boolean` (or opts param — see design decision 4)
- `packages/reviewer/tests/agent.test.ts` — force command tests
- `packages/reviewer/tests/pipeline.test.ts` — `ignoreBudget` bypass test

### Consumes

- Budget question comment from KIT-014 — the text the user replies to
- `handleMessage` + idle timer reset in `agent.ts:72-96` — existing mechanism
- `startAgent` config (`agent.ts:9-17`) — gains `onForce` callback or re-run capability
- `PubSubMessage` (`packages/shared/src/types/review-status.ts:33-39`) — follow_up payload `{ message, sender }`

### Produces

- `startAgent` accepts `onForce: () => Promise<void>` — invoked when a follow-up message equals `force`; the callback re-runs the review with `ignoreBudget: true` and posts the full findings (the budget question comment is superseded: full review body notes "full review after force")
- `runPipeline(config: PipelineConfig, opts?: { ignoreBudget?: boolean })` — when `ignoreBudget: true`, skips chunking (single call with full context)
- Command dispatch: exact match `message.trim().toLowerCase() === "force"` → command, NOT a follow-up question (US-015 AC-4)

### Design decisions

1. **`force` re-runs the whole review** — simplest correct semantics: fresh full-context LLM call, findings posted as a new PR Review. The earlier partial review body is acknowledged ("superseded by full review") rather than deleted (GitHub reviews are append-only).
2. **Command dispatch by exact match** — `force` is a reserved word; any other message is a follow-up question (KIT-017). Case-insensitive, trimmed.
3. **Re-run inside the same Pod, but it DOES re-clone** — `runPipeline`'s `finally` always removes `/tmp/clones/{jobId}` (`pipeline.ts:99-102`), so a `force` re-run performs a fresh clone (same Pod, no new Pod, no dispatcher round-trip). Accept the clone cost — correctness first, and the clone is shallow. Idle timer resets before the re-run (matches `agent.ts:82` "reset timer FIRST" invariant).
4. **`ignoreBudget` is a pipeline option, not a config field** — it is a user command decision per-run, not a repo policy. Stays out of `.reviewer.yml`. Signature: `runPipeline(config: PipelineConfig, opts?: { ignoreBudget?: boolean })`.
5. **`followUpCount` increments on message receipt, including commands** — consistent with v2 behavior (`agent.ts:87` increments for every follow_up before dispatch). `force` counts as 1; KIT-017 must NOT decrement or gate this on success.

### Risks

1. **Re-run timing vs idle timeout** — a long full review may exceed the idle window. Mitigation: reset idle timer at command receipt AND after the re-run completes.
2. **Force on a repo with genuinely huge context** — single call may exceed provider context (e.g. DeepSeek 1M). Contained: the LLM call fails, chunk failure path (KIT-014 decision 5) reports the error; no infinite loop.

## Implementation Plan

1. - [ ] **RED — ignoreBudget test**: `packages/reviewer/tests/pipeline.test.ts` — `runPipeline(config, { ignoreBudget: true })` on an over-budget fixture makes exactly 1 LLM call with all files. Run: FAIL.
2. - [ ] **GREEN — pipeline option**: add `ignoreBudget?: boolean` to `PipelineConfig`/options; skip chunking when set. PASS.
3. - [ ] Commit: `feat(reviewer): add ignoreBudget pipeline option for forced full review`
4. - [ ] **RED — agent force test**: `packages/reviewer/tests/agent.test.ts` — a follow_up with message `"force"` invokes `onForce` exactly once; idle timer reset (not fired); a follow_up with message `"explain the changes"` does NOT invoke `onForce`. Run: FAIL.
5. - [ ] **GREEN — agent command dispatch**: add `onForce` to `startAgent` config; dispatch in `handleMessage` before the follow-up path. PASS.
6. - [ ] Commit: `feat(reviewer): dispatch force command in agent lifecycle`
7. - [ ] **RED — force full-flow test**: pipeline + agent integration (mocked LLM): over-budget review posts partial + budget question; `force` message → re-run single call → full findings review posted; budget question comment referenced. Run: FAIL.
8. - [ ] **GREEN — wiring**: `index.ts` wires `onForce` → `runPipeline(config, { ignoreBudget: true })` → post full review. PASS.
9. - [ ] Commit: `feat(reviewer): wire force command end-to-end`
10. - [ ] Run: `pnpm test && pnpm lint` — all green.

## How to Test

- **Automated**: `pnpm test` — `packages/reviewer/tests/pipeline.test.ts` (ignoreBudget single call), `packages/reviewer/tests/agent.test.ts` (force dispatch, timer reset, non-command messages unaffected). All PASS.
- **Manual verification**: on minikube, trigger a review with low `max_context_tokens` in the fixture repo → PR shows partial review + budget question. Then `curl -X POST $DISPATCHER_URL/review/<jobId>/message -d '{"message":"force","sender":"dev"}'` → PR gets a full review (all files, no chunk logs), and `GET /status/<jobId>` still shows `followUpCount: 1` (force counted once).
- **Negative check**: sending `"force"` to a dead Pod returns 404 `{ code: "NOT_FOUND", message: "Job {jobId} not found" }` (dispatcher `message.ts:36`); sending `"force"` to a Pod in `reviewing` state after a *completed* (non-budget) review still triggers the re-run (allowed) — verify the status does not change to `cancelled`; a message `"FORCE "` (whitespace, uppercase) also triggers force (case-insensitive trim).
- **Done means**: `pnpm test` green; force on a budget-exceeded review produces a full-context single-call review posted on the PR, with the idle timer reset so the Pod stays alive to answer.
