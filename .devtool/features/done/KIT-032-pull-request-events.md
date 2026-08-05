---
id: "KIT-032"
status: "done"
completedAt: "2026-08-05"
priority: "high"
assignee: ""
epic: "v5-github-webhook"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["webhook", "core"]
order: "d2"
---

# pull_request Events → Review Dispatch + Live Re-Review

## User Story

See [US-028](../../docs/stories/US-028-auto-review-on-pr-events.md) (AC-1) and [US-030](../../docs/stories/US-030-live-re-review-on-push.md).

## Technical Refinement

### Files

**Created (dispatcher):**
- `packages/dispatcher/src/webhook/events.ts` — `routeEvent(event, payload, deps)`: zod-parses the `pull_request` payload (`.loose()` except used fields: `action`, `pull_request.number`, `.head.ref`, `.base.ref`, `.state`, `repository.full_name`, `sender.login`); actions `opened`/`reopened`/`synchronize` only; closed PRs ignored. Builds the `ReviewJob` and decides dispatch vs re-review.
- `packages/dispatcher/src/webhook/dispatch.ts` — `dispatchReview(job, deps)`: the Pod-creation + initial-status block EXTRACTED from `routes/review.ts` (single implementation; `POST /review` and the webhook both call it).

**Modified:**
- `packages/dispatcher/src/routes/review.ts` — delegate to `dispatchReview` (behavior unchanged).
- `packages/dispatcher/src/routes/webhook.ts` — replace the KIT-031 stub with `routeEvent`.
- `packages/shared/src/types/` (pubsub message type) — add `"re_review"` to the `PubSubMessage.type` union.
- `packages/reviewer/src/index.ts` + `packages/reviewer/src/agent.ts` — `onReReview` handler: re-runs `runPipeline(config, { signal })` (no `ignoreBudget`), resets idle timer, updates status to `reviewing`. Registered next to `onForce`/`onStop`.

### Consumes

- `dispatchReview` shares `k8sClient`/`podConfig`/`redis` deps (`routes/review.ts:10-14`)
- Active-job detection: `review:{jobId}:status` in Redis + `TERMINAL_STATUSES` (pattern in `routes/message.ts:8`)
- `redis.publish` return value = subscriber count — the fallback signal (US-030 AC-2)
- Agent message plumbing (`agent.ts` `handleMessage`, KIT-008/015/016)

### Produces

- `dispatchReview` and `routeEvent` — KIT-033 adds the `issue_comment` branch to the same router.
- `re_review` Pod behavior — KIT-034 exercises it e2e.

### Design decisions

1. **Re-review = message, not Pod recreation** (epic D3, user decision) — `runPipeline` re-clones from scratch, so a live Pod re-running the pipeline reviews the new head. Zero churn.
2. **`publish() === 0` → fallback to new Pod** — publish returns the subscriber count; a dead Pod (idle-timed-out) cannot consume, so the dispatcher creates a fresh Pod with `isReReview: true`.
3. **Active job + `opened`/`reopened` → dispatch anyway is impossible** (Pod name collision, 409 from K8s) — treated as re-review too: any of the three actions on an ACTIVE job publishes `re_review`; only a dead/absent job creates a Pod.
4. **Malformed payload for a handled event → 200 `{ ignored: true }` + warning** — GitHub must not retry forever (epic error table).

### Risks

1. **Concurrent runPipeline in the Pod** (re_review arriving mid-review) — the pre-pipeline subscription exists (`index.ts` "Subscribed pre-pipeline"); handler must serialize: ignore `re_review` while a pipeline run is in flight, queue at most one pending re-run. Unit-tested.
2. **Clone dir reuse** — `runPipeline` cleans `/tmp/clones/{jobId}` in `finally`; a re-run recreates it. Verified by the existing cleanup invariant tests.

## Implementation Plan

1. - [x] RED: `packages/dispatcher/tests/webhook-events.test.ts` — signed `pull_request opened` → `createPod` called with the right manifest + status stored (via `dispatchReview`); `synchronize` with active job → `re_review` published, no Pod; publish returning 0 → Pod created; `closed` action → ignored; malformed payload → 200 + warning. FAIL.
2. - [x] GREEN: `dispatch.ts` (extraction), `events.ts`, wire into `webhook.ts`; `re_review` in the shared type union. PASS (existing `POST /review` tests must stay green — extraction is behavior-preserving).
3. - [x] Commit: `feat(dispatcher): dispatch reviews from pull_request webhooks`
4. - [x] RED: `packages/reviewer/tests/agent.test.ts` — `re_review` message triggers the callback, resets idle timer; a second `re_review` during a run queues once (no concurrent pipelines). FAIL.
5. - [x] GREEN: `onReReview` in `agent.ts`/`index.ts` with in-flight serialization. PASS.
6. - [x] Commit: `feat(reviewer): re-run pipeline on re_review message`
7. - [x] `pnpm test && pnpm lint` green.

## How to Test

- **Automated**: `pnpm test` — new dispatcher/reviewer tests + all suites green.
- **Manual**: minikube — simulate a signed `pull_request opened` delivery with curl → Pod appears; simulate `synchronize` while it runs → Pod logs show a second "Processing job" without a new Pod.
- **Negative**: `synchronize` for a PR with no job and a dead channel → new Pod (fallback); `closed` action → `{ ignored: true }`.
- **Done means**: `pnpm test && pnpm lint` exit 0; PR events produce exactly one review of the latest code, live Pods re-review in place.
