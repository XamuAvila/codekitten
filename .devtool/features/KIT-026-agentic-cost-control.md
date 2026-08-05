---
id: "KIT-026"
status: "backlog"
priority: "medium"
assignee: ""
epic: "v4-mcp-agentic-review"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["agentic", "budget"]
order: "c4"
---

# Agentic Cost Control

## User Story

See [US-026](../../docs/stories/US-026-agentic-cost-control.md).

## Technical Refinement

### Files

**Modified (reviewer):**
- `packages/reviewer/src/agentic/loop.ts` — honor `MCPConfig.tools` as a whitelist (only whitelisted tools appear in each turn's `tools` array, plus `report_findings`); return `hitBudget` (already produced by KIT-023); read `forceMaxTurns` when `PipelineOptions.ignoreBudget` is set
- `packages/reviewer/src/pipeline.ts` — when `hitBudget` is true, post the budget-exceeded comment reusing `budgetQuestionComment` (lines 298-307) extended with the tool-call count; populate `metadata.toolCalls`
- `packages/reviewer/src/types.ts` — `PipelineResult.metadata.toolCalls?: number` (line 59-63 block)
- `packages/reviewer/src/index.ts` — confirm `onForce` (lines 105-113) flows `ignoreBudget` into the agentic path exactly as it does for the v3 chunk path

### Consumes

- `MCPConfig` caps + `tools` whitelist (`mcp-config.ts`, KIT-023)
- `runAgenticLoop` `{ findings, toolCalls, hitBudget }` (KIT-023)
- `PipelineOptions.ignoreBudget` (`pipeline.ts:26`), `budgetQuestionComment` (`pipeline.ts:298-307`)
- Existing `onForce`/`onStop` plumbing (`index.ts:105-127`, `agent.ts`)

### Produces

- Enforced tool whitelist; budget-exceeded comment with tool-call count; `metadata.toolCalls` in `PipelineResult`; `force` → `forceMaxTurns` behavior for the agentic loop

### Design decisions

1. **`force` reuses `ignoreBudget` — no new command plumbing** — the agentic loop reads `forceMaxTurns` (default 60) whenever `ignoreBudget` is set, exactly mirroring how the v3 chunk path skips its budget check (KIT-015). One flag, two consumers.
2. **Whitelist enforced at the turn-builder level** — disabled tools are never placed in the `tools` array, so the model literally cannot call them (US-026 AC-5). This is enforcement, not a prompt hint.
3. **Budget-exceeded comment shows the tool-call count** — transparency for cost control (US-026 AC-2); reuses the v3 comment shape so the PR experience stays consistent.
4. **`stop` always works even under `force`** — the AbortSignal is checked between turns regardless of the cap, so a runaway forced review can always be cancelled.

### Risks

1. **Forced reviews on huge repos can still run long** — bounded by `forceMaxTurns` (60); `stop` remains available. No unbounded loop is possible.
2. **Tool-call count drifts from actual cost** — it counts executed tool_uses, not tokens. It is a directional signal for the budget comment, not a billing figure; documented as such.

## Implementation Plan

1. - [ ] **RED — whitelist test**: extend `packages/reviewer/tests/agentic/loop.test.ts`. Assert: with `tools: ["read_file"]`, each turn's `tools` array contains only `read_file` + `report_findings`; `search`/`find_related`/`list_directory` never appear. Command: `pnpm --filter @kitten/reviewer test` — FAIL.
2. - [ ] **GREEN — loop.ts whitelist**: filter the tool set by `MCPConfig.tools` at turn build time. PASS.
3. - [ ] **RED — force escalation test**: extend the loop test. Assert: with `ignoreBudget: true`, the loop uses `forceMaxTurns` (60) instead of `maxTurns` (12) — a run that would exhaust at 13 turns continues to 60. FAIL.
4. - [ ] **GREEN — forceMaxTurns**: the loop reads `forceMaxTurns` when `ignoreBudget` is set. PASS.
5. - [ ] **RED — budget comment + metadata test**: extend `packages/reviewer/tests/pipeline.test.ts`. Assert: an agentic review that hits the budget posts a comment containing "force" and the tool-call count; `PipelineResult.metadata.toolCalls` equals the executed tool count; a review that reports before the budget posts no budget comment. FAIL.
6. - [ ] **GREEN — pipeline.ts + types.ts**: wire `hitBudget` → comment, populate `metadata.toolCalls`. Verify `onForce` flows `ignoreBudget` (no change expected in `index.ts` — the flag already reaches `runPipeline`). PASS.
7. - [ ] Commit: `feat(reviewer): enforce agentic cost caps, force escalation, and tool-call metadata`
8. - [ ] Run full suites: `pnpm test && pnpm lint` — all green.

## How to Test

- **Automated**: `pnpm test` — `packages/reviewer/tests/agentic/loop.test.ts` (whitelist + force), `packages/reviewer/tests/pipeline.test.ts` (budget comment + `toolCalls`). All PASS.
- **Manual verification**: on minikube with `.reviewer-mcp.json` (`maxTurns: 3`, `tools: ["read_file"]`), submit a review — the Pod logs show, per turn: turn number, tool called, tool latency, and tokens consumed; the model makes only `read_file` calls, the loop finalizes after 3 turns, the posted comment says "Reply `force`" with a tool-call count, and replying `force` re-runs with the raised cap.
- **Negative check**: with `tools: ["read_file"]`, a model that tries `search` gets no such tool (no tool_result; the finalize turn forces `report_findings`); a review that reports early posts NO budget comment and `metadata.toolCalls` reflects only the executed calls; a `stop` during a forced review still cancels.
- **Done means**: `pnpm test && pnpm lint` exit 0; `tools` whitelist is enforced in every turn's tool array, `force` raises the cap, budget-exceeded reviews post the force invitation with a tool-call count, and `metadata.toolCalls` is populated.
