---
id: US-015
title: "Force Full Review"
status: draft
epic: v3-llm-integration
---

# US-015: Force Full Review

## Story

As a **developer**, I want to reply `force` to a budget-exceeded review so that the entire PR is reviewed without token limits when I explicitly opt in.

## Acceptance Criteria

### AC-1: Budget question includes force instruction

```
Given a review exceeded the token budget
When the budget-exceeded comment is posted on the PR
Then the comment explains the PR exceeded the budget
And tells the user to reply `force` to review everything without limits
```

### AC-2: force command triggers unlimited review

```
Given a Pod is alive and waiting (reviewing state) after a budget-exceeded review
When I POST /review/:jobId/message with { "message": "force" }
Then the Pod re-runs the review without the max_tokens limit
And the full-context findings are posted on the PR
And the earlier partial review is superseded/noted
```

### AC-3: force works only on a live Pod

```
Given no active Pod for a jobId
When I POST /review/:jobId/message with "force"
Then the response is 404/410 { code: "NOT_FOUND" } with "Job {jobId} not found" or "Job {jobId} is no longer active"
```

### AC-4: Regular follow-ups unaffected

```
Given a Pod in reviewing state
When I POST a non-command message ("explain the changes in utils.ts")
Then it is treated as a follow-up question, not a force
```

## Notes

- `force` is interpreted by the same message handler that future v5 webhook will call
- "Superseded/noted": the force review posts full findings; the partial-comment context is acknowledged in the new review body
