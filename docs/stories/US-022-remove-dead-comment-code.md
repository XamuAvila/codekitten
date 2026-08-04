---
id: US-022
title: "Dead Comment Code Removed"
status: done
epic: v3-llm-integration
---

# US-022: Dead Comment Code Removed

## Story

As a **maintainer**, I want the dead comment-posting helpers removed from the reviewer, so that the module exposes only code that is actually called and a future reader is not misled by a shadowed export.

## Context

Three dead blobs live in the reviewer's `github/comment.ts`:
- `postFollowUpAck` — exported and tested, but zero production callers (KIT-017 replaced it with `postFollowUpAnswer` and left the old one)
- `formatFollowUpAck` — only used by `postFollowUpAck`
- `formatFindingsComment` — exported, zero callers anywhere, including tests

Plus a shadowed helper: `index.ts:149-170` defines a local `postReviewComment` with signature `body: string`, shadowing the module export `postReviewComment(summary: ReviewCommentData)` from `comment.ts:10`. Both are named the same; the local one is used only by the cancellation path at `index.ts:119`.

Refinement lives in the card, `KIT-022-remove-dead-comment-code.md`.

## Acceptance Criteria

### AC-1: Dead helpers are gone

```
Given the reviewer module
When I search for postFollowUpAck, formatFollowUpAck and formatFindingsComment
Then zero matches exist in packages/reviewer/src/ and packages/reviewer/tests/
```

### AC-2: Live helpers are untouched

```
Given postFollowUpAnswer and postReviewComment are live
When the cleanup runs
Then both remain exported and their callers (agent.ts:150, pipeline.ts:191/215/229) still work
```

### AC-3: The shadow is removed

```
Given index.ts:119 posts the cancellation notice
When the local postReviewComment (body: string) is removed
Then a correctly-typed postCancellationComment helper takes its place
And the cancellation comment still carries the [KITTEN-TEST] prefix
```

### AC-4: Suite stays green

```
Given the cleanup
When pnpm test and pnpm build run
Then all tests pass (minus the removed postFollowUpAck describe) and the build exits 0
```

## Notes

- Dead-code removal is the TDD exception: the existing suite holds the contract, so RED is removing the tests/mocks and GREEN is removing the code — not dressed up as RED→GREEN.
- Runs after KIT-021 (lint clean) so `agent.test.ts` is already green when the dead mock is removed.
