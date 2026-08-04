---
id: "KIT-022"
status: "backlog"
priority: "low"
assignee: ""
epic: "v3-llm-integration"
dueDate: null
created: "2026-08-04"
modified: "2026-08-04"
completedAt: null
labels: ["cleanup", "debt"]
order: "c13"
---

# Remove Dead Comment Code

## User Story

See [US-022](../../docs/stories/US-022-remove-dead-comment-code.md).

## Technical Refinement

### Files

**Modified (reviewer):**
- `packages/reviewer/src/github/comment.ts` — remove `postFollowUpAck` (lines 42-68), `formatFollowUpAck` (lines 181-189), `formatFindingsComment` (lines 105-139)
- `packages/reviewer/src/github/index.ts` — remove `postFollowUpAck` from the re-export (line 1)
- `packages/reviewer/src/index.ts` — replace the local `postReviewComment` (lines 149-170, which shadows the module one with a different signature) with a small `postCancellationComment` helper that calls the global `postReviewComment` from `comment.ts`

**Modified (tests):**
- `packages/reviewer/tests/github/comment.test.ts` — remove the whole `postFollowUpAck` describe (lines 99-138)
- `packages/reviewer/tests/agent.test.ts` — remove the dead `postFollowUpAck` mock (line 47)

### Consumes

- `postFollowUpAnswer` (live, `comment.ts:145`) — used by `agent.ts:150`, **kept**
- `postReviewComment` (live, `comment.ts:10`, signature `summary: ReviewCommentData`) — used by `pipeline.ts:191,215,229` and (after this card) `index.ts:119`
- `formatReviewComment` (live, `comment.ts:16`) — used by `postReviewComment`, **kept**

### Produces

- `postCancellationComment(token, repo, prNumber, body: string): Promise<void>` in `index.ts` — builds the `[KITTEN-TEST]`-prefixed body and delegates to the global `postReviewComment`. Non-fatal (logs, doesn't throw), matching the old local helper's behaviour.
- No exported API change — `github/index.ts` simply stops exporting `postFollowUpAck`.

### Design decisions

1. **Single card for all three targets** — one cohesive cleanup of `comment.ts` + `index.ts`; splitting them would churn the same files twice.
2. **`index.ts:119` keeps calling a local helper, but a correctly-typed one.** The old local `postReviewComment` shadowed the module export with an incompatible signature (`body: string` vs `summary: ReviewCommentData`) — a footgun for the next reader. Renaming it `postCancellationComment` removes the shadow entirely.
3. **Dead-code removal is the TDD exception** — the "test" is the existing suite holding the contract. RED is removing the mocks/describes → suite fails → GREEN is removing the code. Not dressed up as RED→GREEN.
4. **Out of scope:** `dist/` (build artifact), `formatReviewComment` (live), `postFollowUpAnswer` (live), the shadowed `postReviewComment` *caller* `index.ts:119` (stays).

### Risks

1. **`agent.test.ts` mock removal** — the mock at `line 47` is dead (no caller), but removing it touches a file that already fails lint. The KIT-021 fix (typed mocks) lands first, so this card works on a clean file. Verified ordering: KIT-021 (c12) before KIT-022 (c13).

## Implementation Plan

1. - [ ] **RED — remove the dead `postFollowUpAck` describe** from `comment.test.ts`. Run `npx vitest run packages/reviewer/tests/github/comment.test.ts` → FAIL (import unresolved).
2. - [ ] **GREEN — remove `postFollowUpAck` + `formatFollowUpAck` from `comment.ts`**, and remove the re-export from `github/index.ts`. Run → PASS.
3. - [ ] **RED — remove `formatFindingsComment`** from `comment.ts`. Run `npx vitest run packages/reviewer/tests/github/comment.test.ts` → PASS (no test referenced it).
4. - [ ] **GREEN — remove `postFollowUpAck` mock from `agent.test.ts`**. Run `npx vitest run packages/reviewer/tests/agent.test.ts` → PASS.
5. - [ ] **RED — rewrite `index.ts:119` call** to use a new `postCancellationComment`. Run `npx vitest run packages/reviewer/tests/index.test.ts` (if present) or the full suite → FAIL.
6. - [ ] **GREEN — add `postCancellationComment` helper** to `index.ts`, remove the local shadow. Run → PASS.
7. - [ ] Commit: `refactor(reviewer): remove dead comment code (postFollowUpAck, formatFindingsComment)`
8. - [ ] Run `pnpm test && pnpm build && npx eslint packages/reviewer/src/github/comment.ts packages/reviewer/src/github/index.ts packages/reviewer/src/index.ts` — all green, lint exit 0.

## How to Test

- **Automated**: `pnpm test` → all green (216 → same count, minus the removed `postFollowUpAck` describe's tests). `npx eslint` on the three changed source files → exit 0. `pnpm build` → exit 0.
- **Manual verification**: `rtk proxy grep -rn "postFollowUpAck\|formatFindingsComment\|formatFollowUpAck" packages/ --include=*.ts` → **zero matches** in `src/` and `tests/`.
- **Negative check**: `postFollowUpAnswer` and `postReviewComment` are still exported and used — `rtk proxy grep -rn "postFollowUpAnswer\|postReviewComment" packages/reviewer/src/` shows both, and `agent.ts:150` / `pipeline.ts:191` still call them. The cancellation path (`index.ts:119`) still posts a comment with the `[KITTEN-TEST]` prefix.
- **Done means**: `pnpm test && pnpm build` green, eslint on the 3 changed files exits 0, and `postFollowUpAck`/`formatFollowUpAck`/`formatFindingsComment` have zero matches in `packages/reviewer/src/` and `packages/reviewer/tests/`.