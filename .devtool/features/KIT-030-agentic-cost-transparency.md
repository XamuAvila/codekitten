---
id: "KIT-030"
status: "backlog"
priority: "medium"
assignee: ""
epic: "v4-mcp-agentic-review"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["agentic", "bug", "budget"]
order: "c8"
---

# Token Accounting + Per-Turn Tool Logging

## User Story

See [US-027](../../docs/stories/US-027-agentic-review-hardening.md) (AC-4).

## Technical Refinement

Two KIT-026 promises unmet: (a) `ExploreResult.metadata` tokens are discarded
— the agentic `ReviewResult` hardcodes `inputTokens: 0, outputTokens: 0`, so
budget comments report 0 tokens; (b) KIT-026's manual verification expects
per-turn logs (turn number, tool, latency, tokens) that were never
implemented.

**Modified:**
- `packages/reviewer/src/agentic/loop.ts` — accumulate per-turn
  input/output tokens; return `{ inputTokens, outputTokens }` in the loop
  result; per executed tool log
  `[reviewer] Turn N/M: <tool>(<input JSON truncated to 120 chars>) <ms>ms`
  and per turn `[reviewer] Turn N/M: <in> in / <out> out tokens`. Tool
  RESULT content is never logged (repo file contents may hold secrets).
- `packages/reviewer/src/pipeline.ts` — use the loop's token totals in the
  agentic `ReviewResult.metadata`.

## Implementation Plan

1. - [x] RED: `loop.test.ts` — loop result sums turn tokens; console.log
   receives per-tool lines with truncated input and no tool-result content.
   FAIL.
2. - [x] GREEN: loop accumulation + logging. PASS.
3. - [x] RED: `pipeline.test.ts` — agentic result metadata carries the summed
   tokens. FAIL.
4. - [x] GREEN: pipeline wiring. PASS.
5. - [x] `pnpm test && pnpm lint` green; commit.

## How to Test

- **Automated**: `pnpm test` — new loop + pipeline assertions, suites green.
- **Manual**: minikube agentic run → Pod logs show one line per tool call
  with latency and per-turn token counts; posted comment token estimate > 0.
- **Negative**: tool result bodies (file contents) never appear in logs.
- **Done means**: `pnpm test && pnpm lint` exit 0; token totals real,
  per-turn logs present, no result content logged.
