---
id: "KIT-029"
status: "done"
completedAt: "2026-08-05"
priority: "high"
assignee: ""
epic: "v4-mcp-agentic-review"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["agentic", "bug"]
order: "c7"
---

# Aborted Agentic Review Must Not Post Findings

## User Story

See [US-027](../../docs/stories/US-027-agentic-review-hardening.md) (AC-3).

## Technical Refinement

Epic promise broken: "stop mid-loop → status cancelled, 'Review cancelled'
comment". `runAgenticLoop` returns `aborted: true` but `pipeline.ts` ignores
it — empty findings flow into the normal posting path and a "No issues found"
comment lands on a cancelled review. Cancellation status/comment themselves
are the stop plumbing's job (`index.ts` onStop, KIT-016) — the pipeline's job
is to stay silent.

**Modified:** `packages/reviewer/src/pipeline.ts` — when the agentic loop
returns `aborted: true`, log and return early (`status: "completed"`, no
findings, no PR comments). The `PipelineResult` status union stays unchanged;
cancelled is reported by onStop.

## Implementation Plan

1. - [x] RED: `pipeline.test.ts` — agentic fixture with an aborted signal →
   no `createReview`/`createComment` calls, result has no findings. FAIL.
2. - [x] GREEN: early return on `aborted`. PASS.
3. - [x] `pnpm test && pnpm lint` green; commit.

## How to Test

- **Automated**: `pnpm test` — new pipeline test + suites green.
- **Manual**: minikube — send `stop` during an agentic review; PR receives
  only the "Review cancelled" comment, never "No issues found".
- **Negative**: un-aborted review still posts findings normally.
- **Done means**: `pnpm test && pnpm lint` exit 0; an aborted agentic run
  posts nothing from the pipeline.
