---
id: "KIT-013"
status: "backlog"
priority: "high"
assignee: ""
epic: "v3-llm-integration"
dueDate: null
created: "2026-08-03"
modified: "2026-08-03"
completedAt: null
labels: ["github", "pr-comments"]
order: "c3"
---

# Inline Diff Comments on PR

## User Story

See [US-013](../../docs/stories/US-013-inline-diff-comments.md).

## Technical Refinement

### Files

**Created (reviewer):**
- `packages/reviewer/src/github/review.ts` — `postPrReview(...)` + hunk parsing helpers
- `packages/reviewer/tests/github/review.test.ts` — unit tests with mocked Octokit

**Modified (reviewer):**
- `packages/reviewer/src/pipeline.ts` — replace `postReviewComment` (placeholder table) with `postPrReview` for findings; keep the fallback table in the review body
- `packages/reviewer/src/types.ts` — `ReviewCommentData` stays; add `PrReviewResult` type if needed
- `packages/reviewer/src/github/index.ts` — export `postPrReview`
- `packages/reviewer/tests/pipeline.test.ts` — assert pipeline calls `postPrReview` with mapped findings

### Consumes

- `PullRequestFile.patch` (`packages/shared/src/types/pull-request-file.ts:7`) — unified diff per file, fetched by `fetchPrFiles` (`packages/reviewer/src/git/files.ts:31`)
- `Finding` (`packages/shared/src/types/review-job.ts:23-32`): `file`, `line`
- `postReviewComment` body format (`packages/reviewer/src/github/comment.ts:73-92`) — pattern for review body
- Octokit `pulls.createReview` — `@octokit/rest` already used in `comment.ts:1`

### Produces

- `postPrReview(token: string, repo: string, prNumber: number, findings: readonly Finding[], filePatches: ReadonlyMap<string, string>): Promise<{ postedInline: number; inTable: number }>` — creates a PR Review (state COMMENTED) with inline comments; unmappable findings land in a Markdown table in the review body
- `isLineInPatch(patch: string, line: number): boolean` — pure function: parses `@@ -a,b +c,d @@` hunks, checks whether `line` (new-file side) falls inside any hunk's added-line range
- Review body format (mirrors CodeRabbit): `**Actionable comments posted: N**` + `<details>` grouping + table

### Design decisions

1. **Modern API anchors (`line`/`side`), not legacy `position`** — GitHub docs recommend `line` + `side: "RIGHT"` + `subject_type: "line"`; `position` (hunk index) is legacy and brittle across commit changes. Verified against docs.github.com/rest/pulls/comments (Aug 2026).
2. **Hunk membership check, then table fallback** — a finding anchors inline only if its `line` falls inside a hunk of that file's patch (added/context lines on the RIGHT side). Renamed files, removed lines, or lines outside hunks → table fallback. Fallback never blocks the review (US-013 AC-3).
3. **One PR Review, not N comments** — `pulls.createReview` with a `comments` array batches all inline comments in a single review submission. Matches CodeRabbit behavior (one review with `state: COMMENTED`).
4. **Per-file patch map from `fetchPrFiles`** — patches already fetched in the pipeline; no extra API calls.

### Risks

1. **Hunk parsing edge cases** — no-newline markers (`\ No newline at end of file`), binary files (no patch), large hunks. Unit tests cover these; the table fallback is the safety net.
2. **Octokit review payload shape** — `subject_type` support in `@octokit/rest` types. Step 2 (unit test of payload shape) verifies before pipeline wiring.
3. **Deleted/renamed file lines** — `line` on the RIGHT side refers to the new file; findings on deleted lines cannot anchor (LEFT-side anchors are for comment ranges). Covered by fallback.

## Implementation Plan

1. - [ ] **RED — isLineInPatch test**: create `packages/reviewer/tests/github/review.test.ts`. Cases: line inside added range → true; line in context (unchanged) range → true; line before/after hunks → false; empty patch → false; binary (undefined patch) → false. Run: FAIL.
2. - [ ] **GREEN — isLineInPatch**: implement hunk parser in `review.ts`. PASS.
3. - [ ] **RED — postPrReview test (mocked Octokit)**: assert `pulls.createReview` called once with: `state: "COMMENTED"`, `body` containing `**Actionable comments posted: 2**`, `comments` array with `{ path, line, side: "RIGHT", body }` for mapped findings, and the unmapped finding in the table. Run: FAIL.
4. - [ ] **GREEN — postPrReview**: implement review building: map findings → inline comments (hunk membership), rest → table; single `createReview` call. PASS.
5. - [ ] Commit: `feat(reviewer): post PR review with inline diff comments and table fallback`
6. - [ ] **RED — pipeline test**: `packages/reviewer/tests/pipeline.test.ts` — pipeline calls `postPrReview` (not `postReviewComment`) with findings + patch map; `postedInline`/`inTable` logged. Run: FAIL.
7. - [ ] **GREEN — pipeline wiring**: replace `postReviewComment` call (`pipeline.ts` line ~76) with `postPrReview`; build patch map from `prFiles`. Keep non-fatal error handling (comment.ts:32-34 pattern). PASS.
8. - [ ] Commit: `feat(reviewer): wire PR review inline posting into pipeline`
9. - [ ] **RED — empty findings test**: pipeline with zero findings does not crash; review body states no issues found or no review created (US-013 AC-5). Run: FAIL.
10. - [ ] **GREEN — empty findings handling**. PASS.
11. - [ ] Commit: `test(reviewer): cover empty-findings review posting`
12. - [ ] Run: `pnpm test && pnpm lint` — all green.

## How to Test

- **Automated**: `pnpm test` — `packages/reviewer/tests/github/review.test.ts` (hunk parsing + payload shape), `packages/reviewer/tests/pipeline.test.ts` (wiring + empty findings). All PASS.
- **Manual verification (real PR)**: run the pipeline against `XamuAvila/kitten-test-repo` PR #1 with `GITHUB_TOKEN` set → open the PR, see a CodeRabbit-style review (`state: COMMENTED`) with inline comments on the changed lines; findings that could not anchor appear in a table in the review body. `curl https://api.github.com/repos/XamuAvila/kitten-test-repo/pulls/1/reviews` shows the review with `"state": "COMMENTED"` and per-line comments under `comments`.
- **Negative check**: a finding pointing at a line outside any hunk (e.g. `line: 9999` on a 40-line file, or a file with `status: "removed"`) must NOT fail the review — it lands in the table; `createReview` is still called with the valid comments only.
- **Done means**: `pnpm test` green; a real review on the test repo appears as one GitHub PR Review with inline comments on diff lines and table fallback for unmappable findings; zero findings produces no crash.
