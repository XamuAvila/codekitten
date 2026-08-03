---
id: US-003
title: Submit and Track a Review Job
status: draft
epic: v1-scaffolding-dry-run
---

# US-003: Submit and Track a Review Job

## Story

As a **CI pipeline** (or developer via curl), I want to POST a review request to the dispatcher and have it enqueued for asynchronous processing so that PRs can be reviewed without blocking the caller.

## Acceptance Criteria

### AC-1: Valid review request is accepted

```
Given the dispatcher is running and connected to Redis
When I POST /review with a valid payload:
  { "repo": "octocat/Hello-World", "prNumber": 1, "headRef": "main", "baseRef": "main~1", "sender": "test" }
Then I receive 202 Accepted with:
  { "jobId": "review-octocat-Hello-World-1", "status": "queued" }
And the job is visible in the BullMQ queue
```

### AC-2: Invalid payload is rejected

```
Given the dispatcher is running
When I POST /review with missing required fields (e.g., no "repo")
Then I receive 400 with:
  { "code": "VALIDATION", "message": "Invalid payload", "details": [{ "field": "repo", "error": "Required" }] }
And no job is enqueued
```

### AC-3: Job status is queryable

```
Given a job was enqueued with ID "review-octocat-Hello-World-1"
When I GET /status/review-octocat-Hello-World-1
Then I receive the job's current state:
  { "id": "review-octocat-Hello-World-1", "status": "completed|active|waiting|failed", "duration": 4200 }
```

### AC-4: Duplicate PR re-enqueues

```
Given a job for repo "org/repo" PR #5 already exists (completed or active)
When I POST /review with the same repo and prNumber
Then a new job is created (re-review scenario)
And the response includes the new job ID
```

### AC-5: Redis unavailable returns 503

```
Given the dispatcher is running but Redis is down
When I POST /review with a valid payload
Then I receive 503 with:
  { "code": "SERVICE_UNAVAILABLE", "message": "Queue backend unavailable" }
```

## Notes

- Payload validated with Zod schema.
- Job ID format: `review-{owner}-{repo}-{prNumber}` (deterministic, idempotent for status lookup).
- `isReReview` derived from whether a previous job exists for the same PR.
- BullMQ producer in `packages/dispatcher/src/queue/producer.ts`.
