---
id: US-016
title: "Stop Review"
status: draft
epic: v3-llm-integration
---

# US-016: Stop Review

## Story

As a **developer**, I want to cancel a running review with `stop` so that I don't waste tokens or wait for a review I no longer need.

## Acceptance Criteria

### AC-1: stop aborts a running review

```
Given a review is in progress (chunks running or LLM calls pending)
When I POST /review/:jobId/message with { "message": "stop" }
Then remaining chunks are aborted
And no further LLM calls are made
```

### AC-2: Status becomes cancelled

```
Given a review was stopped
When I GET /status/:jobId
Then the status is "cancelled"
And completedAt is set
```

### AC-3: Cancellation comment on PR

```
Given a review was stopped mid-review
When the Pod shuts down
Then a "Review cancelled" comment is posted on the PR
And the Pod exits cleanly (clone dir cleaned)
```

### AC-4: stop on an idle/reviewing Pod

```
Given a Pod in "reviewing" state (initial review done, waiting)
When I POST /review/:jobId/message with "stop"
Then the Pod shuts down and status becomes "cancelled"
```

### AC-5: stop on a dead Pod

```
Given no active Pod for a jobId
When I POST /review/:jobId/message with "stop"
Then the response is 404/410 { code: "NOT_FOUND", message: "Review pod not active" }
```

### AC-6: No-op after completion

```
Given a review already completed
When I POST /review/:jobId/message with "stop"
Then nothing changes (status stays "completed")
And the response is the standard dead-Pod/not-active error
```

## Notes

- Reuses the existing `shutdown` pub/sub mechanism (`agent.ts`) — `stop` maps to a graceful shutdown with `cancelled` status
- Status enum extended: `queued | running | reviewing | completed | failed | cancelled`
