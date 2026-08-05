---
id: "KIT-028"
status: "done"
completedAt: "2026-08-05"
priority: "high"
assignee: ""
epic: "v4-mcp-agentic-review"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["agentic", "bug"]
order: "c6"
---

# Retry Transient Failures on Explore Turns

## User Story

See [US-027](../../docs/stories/US-027-agentic-review-hardening.md) (AC-2).

## Technical Refinement

Epic promise broken: error table says LLM timeouts/rate limits go through v3
`callWithRetry` — the loop calls `adapter.explore` bare; one transient error
kills the whole review.

**Modified:** `packages/reviewer/src/agentic/loop.ts` — wrap each
`adapter.explore(...)` in `callWithRetry` (`pipeline/retry.js`) with
`isRetryable: (e) => !isAuthError(e)`; share/extract the `isAuthError` check
from `pipeline.ts` (moved to `pipeline/retry.ts` and re-exported to avoid
duplication).

## Implementation Plan

1. - [x] RED: `loop.test.ts` — explore rejects once with a transient error
   then succeeds → loop completes; rejects with 401 → no retry, error
   propagates. FAIL.
2. - [x] GREEN: wire `callWithRetry`; move `isAuthError` to retry module. PASS.
3. - [x] `pnpm test && pnpm lint` green; commit.

## How to Test

- **Automated**: `pnpm test` — new loop tests + suites green.
- **Manual**: n/a (fault injection covered by unit mocks).
- **Negative**: 401 on a turn fails the review immediately (no backoff delay
  in the test run).
- **Done means**: `pnpm test && pnpm lint` exit 0; a single transient explore
  failure no longer fails an agentic review.
