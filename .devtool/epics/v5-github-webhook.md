---
id: v5-github-webhook
title: "v5: GitHub Webhook"
status: done
created: "2026-08-05"
---

# v5: GitHub Webhook

> The dispatcher gains `POST /webhook/github`: signature-validated GitHub
> webhooks auto-trigger reviews on PR events and route `@reviewer` comments
> to the existing force/stop/follow-up handlers. A push to a PR with a live
> review re-dispatches the pipeline inside the same Pod (re-clone = fresh
> code). Value: the product works from GitHub alone — no manual `curl`.

## Problem

Through v4, a review only starts via a manual `POST /review` and commands via
`POST /review/:jobId/message`. No developer workflow works like that. The
missing piece between "working engine" and "usable product" is GitHub calling
us: PR opened → review appears; `@reviewer force` in a comment → forced
re-review. `ReviewerConfig.trigger` ("@reviewer") has existed since v1 and is
consumed by nothing.

## Solution (v5 scope)

1. **`POST /webhook/github`** — HMAC SHA-256 signature validation
   (`X-Hub-Signature-256`) against a mandatory `WEBHOOK_SECRET` env var,
   timing-safe comparison over the exact raw body. Invalid/missing signature
   → 401, payload never processed. Unhandled event types → 200
   `{ ignored: true }` (a webhook endpoint never errors at GitHub for
   irrelevant events).
2. **`pull_request` events** (`opened`, `reopened`, `synchronize`) → review
   job. No active job → create the Pod (the `POST /review` flow, extracted
   into a shared `dispatchReview` function). Active job + `synchronize` →
   publish a `re_review` message: the live Pod re-runs `runPipeline`, whose
   clone step always fetches the current head — fresh code with zero Pod
   churn (user decision, 2026-08-05). No subscriber on the channel → fall
   back to creating a new Pod.
3. **`issue_comment` events** (`created`, on a PR, non-bot author) whose body
   starts with the trigger word (`TRIGGER_WORD` env, default `@reviewer`):
   `force` → existing force handler; `stop` → existing stop handler; anything
   else → follow-up. Reuses the `POST /review/:jobId/message` internals
   verbatim. Comments without the trigger are ignored.
4. **Reviewer**: new `re_review` message handler in the agent (next to
   force/stop) that re-runs `runPipeline` without `ignoreBudget`.

## Implementation Cards

Execution order (sequential):

| Card | Story | Scope |
|---|---|---|
| [KIT-031](../features/KIT-031-webhook-signature-route.md) | [US-028](../../docs/stories/US-028-auto-review-on-pr-events.md) | raw-body capture, HMAC validation middleware, `POST /webhook/github` route, ignored-event handling |
| [KIT-032](../features/KIT-032-pull-request-events.md) | [US-028](../../docs/stories/US-028-auto-review-on-pr-events.md), [US-030](../../docs/stories/US-030-live-re-review-on-push.md) | `pull_request` → `dispatchReview` extraction, active-job detection, `re_review` publish + reviewer handler + fallback |
| [KIT-033](../features/KIT-033-comment-command-routing.md) | [US-029](../../docs/stories/US-029-comment-commands.md) | `issue_comment` → trigger parse → force/stop/follow-up routing |
| [KIT-034](../features/KIT-034-webhook-e2e.md) | [US-028](../../docs/stories/US-028-auto-review-on-pr-events.md) | webhook e2e on minikube (simulated deliveries), GitHub webhook setup docs, secret seeding in `minikube-setup.sh` |

## Architecture

```
GitHub ──POST /webhook/github──▶ Dispatcher
  1. rawBody middleware (express.json verify) keeps exact bytes
  2. verifySignature(rawBody, X-Hub-Signature-256, WEBHOOK_SECRET)
       └─ fail → 401 { code: "AUTH_FAILED" }
  3. route by X-GitHub-Event:
       pull_request (opened|reopened|synchronize)
         ├─ no active job → dispatchReview(job)         (shared with POST /review)
         └─ active job + synchronize
              └─ publish re_review ──▶ Pod: runPipeline again (re-clone = new code)
                   └─ 0 subscribers → dispatchReview(job)  (Pod already dead)
       issue_comment (created, PR, starts with TRIGGER_WORD)
         ├─ "force" / "stop" → publish follow_up          (existing message flow)
         └─ other text       → publish follow_up (question)
       anything else → 200 { ignored: true }
```

`X-GitHub-Delivery` is logged for traceability; delivery dedupe is out of
scope (GitHub retries are rare and a duplicate review is harmless).

## Stack

| Component | Technology |
|---|---|
| Signature | `node:crypto` `createHmac("sha256")` + `timingSafeEqual` — no new deps |
| Raw body | `express.json({ verify })` capturing `req.rawBody` (webhook route only) |
| Event payloads | zod schemas for the two consumed event shapes (strict on used fields, `.loose()` elsewhere — GitHub payloads are huge and additive) |
| Config | `WEBHOOK_SECRET` (required for the route; absent → route disabled + warning), `TRIGGER_WORD` (default `@reviewer`) |
| Testing | vitest + supertest (dispatcher pattern), signed fixture payloads |

## Types (shared package)

```typescript
// packages/shared/src/types/pubsub.ts — PubSubMessage gains:
type: "follow_up" | "shutdown" | "re_review";
```

`ReviewJob`, `Finding`, statuses: unchanged.

## Error handling

| Error | Behavior |
|---|---|
| Missing/invalid signature | 401 `{ code: "AUTH_FAILED" }`, body never parsed as event |
| `WEBHOOK_SECRET` unset | Route returns 503 `{ code: "SERVICE_UNAVAILABLE" }`, warning at boot |
| Unhandled event/action | 200 `{ ignored: true }` |
| Malformed payload for a handled event | 200 `{ ignored: true }` + warning log (GitHub must not retry forever) |
| Pod creation fails | 503 `SERVICE_UNAVAILABLE` via `dispatchReview` + error handler (GitHub shows delivery failure — actionable) |
| `re_review` publish with 0 subscribers | Fallback to `dispatchReview` (new Pod) |
| Comment from a bot (`sender.type === "Bot"`) | Ignored — prevents feedback loops with the reviewer's own comments |

## Recorded decisions (v5 brainstorm — 2026-08-05)

| # | Question | Decision |
|---|---|---|
| D1 | Auto-trigger events | `opened` + `reopened` + `synchronize` (one review per push — standard bot behavior). |
| D2 | Trigger word source | Dispatcher env `TRIGGER_WORD`, default `@reviewer`. The dispatcher has no clone, so `.reviewer.yml`'s `trigger` stays reserved/documented; reading it via GitHub API rejected (per-comment API cost). |
| D3 | Push during active review | NO Pod recreation. `re_review` message → live Pod re-runs `runPipeline`; clone step already fetches current head. Dead Pod → new Pod fallback. (User proposal — cheaper than cancel+recreate and reuses the force plumbing shape.) |
| D4 | Webhook auth | Single shared `WEBHOOK_SECRET` env (self-hosted MVP). Per-installation secrets are v6 (GitHub App). |

## What is NOT in v5 (out-of-scope)

- GitHub App installation/auth, per-installation tokens — v6
- Delivery dedupe (`X-GitHub-Delivery` persistence), branch filters
- Webhook management UI / auto-registration of the webhook on repos
- Any change to the review pipeline itself (v4 behavior frozen)

## Testing strategy

| Level | What |
|---|---|
| Unit | signature verify (valid/invalid/missing/timing), event router (each event/action → dispatch, re_review, message, ignore), payload schema edges (bot author, non-PR comment, missing fields) |
| Component | supertest against the app: signed POST → 202 + Pod create called; bad signature → 401; ignored events → 200 |
| E2E | minikube: simulated signed deliveries via curl against the deployed dispatcher — PR opened → Pod created; comment `@reviewer stop` → status cancelled; synchronize on live job → second pipeline run in the same Pod logs |

Coverage target: 80%+ on dispatcher.
