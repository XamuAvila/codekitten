---
id: "KIT-033"
status: "backlog"
priority: "high"
assignee: ""
epic: "v5-github-webhook"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["webhook"]
order: "d3"
---

# @reviewer Comment Command Routing

## User Story

See [US-029](../../docs/stories/US-029-comment-commands.md).

## Technical Refinement

### Files

**Modified (dispatcher):**
- `packages/dispatcher/src/webhook/events.ts` — `issue_comment` branch: action `created` only; `payload.issue.pull_request` must exist (PR comments only); `sender.type === "Bot"` ignored (feedback-loop guard); body must start with `deps.triggerWord` (trim, case-insensitive). Command extraction: text after the trigger, trimmed — `force`/`stop` pass through lower-cased, anything else is the follow-up message verbatim. Publishes the same `PubSubMessage` shape as `routes/message.ts` (`type: "follow_up"`, payload `{ message, sender }`) after the same active-job check; dead/unknown job → 200 `{ ignored: true }` + log (US-029 AC-4 — GitHub must not retry).

### Consumes

- `routeEvent` + deps (KIT-032), `TERMINAL_STATUSES` check + publish flow (`routes/message.ts:33-59`), `triggerWord` from `AppConfig` (KIT-031)
- Job id derivation: `buildPodName(repo, prNumber)` (`k8s/manifest.ts`) — the webhook knows repo+PR, not jobId.

### Produces

- Complete comment-command surface for KIT-034's e2e.

### Design decisions

1. **Reuse the message flow, not the route** — extract the publish-with-active-check block from `routes/message.ts` into a shared function (same pattern as `dispatchReview`) so HTTP route and webhook cannot drift.
2. **Bot filter is mandatory** — the reviewer posts PR comments itself; without the filter, a trigger word inside a reviewer comment would self-trigger.
3. **Trigger match is prefix-only** (`@reviewer …` at the start, case-insensitive) — mid-text mentions do not trigger (mirrors CodeRabbit behavior, avoids accidental commands in prose).

### Risks

1. Trigger word colliding with a real GitHub team mention — accepted for MVP; configurable via `TRIGGER_WORD`.

## Implementation Plan

1. - [ ] RED: extend `webhook-events.test.ts` — `@reviewer force` → follow_up published with "force"; `@reviewer stop` → "stop"; `@reviewer why X?` → message "why X?"; no trigger → ignored; bot author → ignored; non-PR issue comment → ignored; terminal job → 200 ignored + log; `@REVIEWER force` (case) → works. FAIL.
2. - [ ] GREEN: `issue_comment` branch + shared publish helper extracted from `routes/message.ts` (route behavior unchanged, its tests stay green). PASS.
3. - [ ] Commit: `feat(dispatcher): route @reviewer PR comments to force/stop/follow-up`
4. - [ ] `pnpm test && pnpm lint` green.

## How to Test

- **Automated**: `pnpm test` — extended webhook tests + dispatcher suite green.
- **Manual**: minikube — simulated `issue_comment` delivery with `@reviewer explain finding 1` while a job runs → Pod logs the follow-up and answers on the PR.
- **Negative**: comment by a bot user with the trigger → nothing published; `@reviewer force` on a finished job → `{ ignored: true }`, no error delivery on GitHub.
- **Done means**: `pnpm test && pnpm lint` exit 0; all three command forms reach the Pod through the webhook exactly as through the HTTP route.
