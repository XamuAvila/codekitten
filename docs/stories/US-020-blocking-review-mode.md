---
id: US-020
title: "Blocking Review Mode"
status: done
epic: v3-llm-integration
---

# US-020: Blocking Review Mode

## Story

As a **repository maintainer**, I want `blocking: request_changes` to actually request changes on the PR, so that a PR with real findings cannot be merged until someone addresses or dismisses them.

## Context

`ReviewerConfig.blocking` accepts `comment_only | request_changes` (`packages/shared/src/types/reviewer-config.ts:32`) and is fully parsed and tested, but no source file outside config reads it. `packages/reviewer/src/github/review.ts:99` hardcodes `event: "COMMENT"`, so `request_changes` is silently ignored — a maintainer believes merges are gated and they are not. That is worse than the feature being absent.

## Acceptance Criteria

### AC-1: request_changes blocks the PR

```
Given .reviewer.yml sets blocking: request_changes
And the review produces at least one finding
When the PR review is submitted
Then it is submitted with event REQUEST_CHANGES
And GitHub marks the PR as having changes requested
```

### AC-2: comment_only stays non-blocking

```
Given .reviewer.yml sets blocking: comment_only (the default)
When the PR review is submitted
Then it is submitted with event COMMENT
And the PR merge state is unaffected
```

### AC-3: A clean PR is never blocked

```
Given .reviewer.yml sets blocking: request_changes
And the review produces zero findings
When results are posted
Then the review is NOT submitted as REQUEST_CHANGES
And the PR merge state is unaffected
```

### AC-4: Self-review falls back instead of failing

```
Given blocking: request_changes
And the reviewer token belongs to the PR author (GitHub rejects REQUEST_CHANGES on your own PR)
When submitting the review returns 422
Then the review is re-submitted with event COMMENT
And the review body states that blocking was downgraded and why
And the job still reaches status completed
```

### AC-5: Cancelled and failed reviews never block

```
Given blocking: request_changes
When the review is cancelled via the stop command, or fails before findings exist
Then no REQUEST_CHANGES review is submitted
```

## Notes

- **Decided:** blocking triggers on *any* finding, regardless of severity (AC-1). A severity threshold was considered and rejected for this story — it would need a new `blocking_severity` config field, and the point here is to make the *existing* field honest, not to grow the config surface. A threshold remains a valid follow-up story if maintainers ask for it.
- AC-4 is not hypothetical: GitHub's `POST /repos/{owner}/{repo}/pulls/{n}/reviews` rejects `REQUEST_CHANGES` from the PR author with 422 — the self-hosted single-token setup makes this a normal case, not an edge case.
- The table-fallback path and inline-comment path share one `createReview` call (`review.ts:92-102`), so the event choice is a single decision point.
