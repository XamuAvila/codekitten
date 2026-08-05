---
id: "KIT-027"
status: "backlog"
priority: "high"
assignee: ""
epic: "v4-mcp-agentic-review"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["agentic", "bug", "budget"]
order: "c5"
---

# Agentic Context Guard (maxTurns is not the only budget)

## User Story

See [US-027](../../docs/stories/US-027-agentic-review-hardening.md) (AC-1).

## Technical Refinement

Epic promise broken: "maxContextTokens still guards the initial user prompt" —
the agentic branch in `pipeline.ts` never checks `estimateTokens` on the
agentic prompt. A huge diff enters the first turn unchecked.

**Modified:** `packages/reviewer/src/pipeline.ts` — after building
`agenticPrompt`, if `!ignoreBudget && estimateTokens(user) > maxContextTokens`:
truncate the diff passed to `buildAgenticPrompt` so the rebuilt prompt fits
(head of the diff kept, `[diff truncated]` marker), log a warning, set
`agenticHitBudget = true` (reuses the existing force-invitation comment).
`force` (`ignoreBudget`) skips truncation. Design: truncation over v3
fallback — the agentic path can recover missing context via tools, chunking
cannot run without full file contents in the prompt.

## Implementation Plan

1. - [x] RED: `pipeline.test.ts` — agentic fixture with a diff larger than
   `max_context_tokens` → explore is called with a truncated diff (marker
   present), warning logged, force comment posted. FAIL.
2. - [x] GREEN: implement guard in `pipeline.ts`. PASS.
3. - [x] `pnpm test && pnpm lint` green; commit.

## How to Test

- **Automated**: `pnpm test` — new pipeline test + all suites green.
- **Manual**: minikube fixture with tiny `max_context_tokens` in
  `.reviewer.yml` → Pod log shows the truncation warning and the force
  comment appears on the PR.
- **Negative**: `force` re-run sends the full diff (no marker).
- **Done means**: `pnpm test && pnpm lint` exit 0; oversized diffs cannot
  enter the loop untruncated.
