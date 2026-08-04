---
id: "KIT-020"
status: "backlog"
priority: "high"
assignee: ""
epic: "v3-llm-integration"
dueDate: null
created: "2026-08-04"
modified: "2026-08-04"
completedAt: null
labels: ["config", "github", "debt"]
order: "c10"
---

# Blocking Review Mode

## User Story

See [US-020](../../docs/stories/US-020-blocking-review-mode.md).

## Technical Refinement

### Files

**Modified (reviewer):**
- `packages/reviewer/src/github/review.ts` — `postPrReview` signature (lines 38-44) gains `blocking`; the single `createReview` call (lines 92-102) picks the event, drops the no-op `state` field, and gains the 422 downgrade path; return type gains `event` and `downgraded`
- `packages/reviewer/src/pipeline.ts` — line 197-203, pass `reviewerConfig.config.blocking` into `postPrReview`

**Modified (tests):**
- `packages/reviewer/tests/github/review.test.ts`
- `packages/reviewer/tests/pipeline.test.ts`

### Consumes

- `postPrReview(token, repo, prNumber, findings, filePatches): Promise<{ postedInline: number; inTable: number }>` (`review.ts:38-44`), sole caller `pipeline.ts:197-203`
- `ReviewerConfig.blocking: "comment_only" | "request_changes"` (`packages/shared/src/types/reviewer-config.ts:32`), parsed at `packages/shared/src/config/parse-config.ts:25,67`, default `"comment_only"` (`defaults.ts:19`). Currently read by zero source files outside config.
- `octokit.pulls.createReview` — request body accepts exactly `commit_id?`, `body?`, `event?: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"`, `comments?[]` (verified in `@octokit/openapi-types@28.0.0` `types.d.ts:114854-114885`, the version this repo resolves). Documented failure response for validation errors is `422 validation_failed_simple` (`types.d.ts:114894`).

### Produces

- `postPrReview(token, repo, prNumber, findings, filePatches, blocking): Promise<{ postedInline: number; inTable: number; event: "COMMENT" | "REQUEST_CHANGES"; downgraded: boolean }>` — `blocking` is a required sixth parameter of type `ReviewerConfig["blocking"]`; `event` reports what was actually submitted and `downgraded` is true when a requested `REQUEST_CHANGES` fell back to `COMMENT`.
- Event mapping: `request_changes` → `REQUEST_CHANGES`, `comment_only` → `COMMENT`.
- On a 422 while submitting `REQUEST_CHANGES`, the review is re-submitted once as `COMMENT` with an appended body line explaining the downgrade; the job still completes.

### Design decisions

1. **Pass the `blocking` primitive, not the whole `ReviewerConfig`.** `postPrReview` currently takes only primitives and plain data (`review.ts:38-44`); threading the config object would couple the `github/` layer to the config type for one enum. Rejected alternative: passing `ReviewerConfig` — larger blast radius, no benefit.
2. **Required parameter, not optional with a default.** An optional `blocking` would let a future call site silently get `comment_only` — exactly the class of bug this card exists to remove. The compiler should force every caller to decide.
3. **Delete `state: "COMMENTED"` (`review.ts:96`) as part of this change.** It is not a field of the create-review request body (evidence above); Octokit forwards unknown body keys and GitHub ignores them, so it has never done anything. Leaving it next to a now-variable `event` would actively mislead the next reader into thinking two knobs control the outcome.
4. **Downgrade on any 422 from a `REQUEST_CHANGES` submit, not on a matched error message.** GitHub returns 422 for several validation failures and the exact self-review message is not part of the typed contract — matching on prose would be brittle across API changes. Retrying once as `COMMENT` is self-validating: a 422 caused by something else (malformed comment anchor, missing body) fails again on the retry and surfaces normally. Rejected alternative: string-matching the error message.
5. **Zero findings never blocks, and that is already structural.** `pipeline.ts:186` routes the empty-findings case to `postReviewComment`, so `postPrReview` is unreachable with zero findings (US-020 AC-3). No new branch is added; a regression test locks the routing so a future refactor cannot quietly start blocking clean PRs.
6. **Cancelled and failed reviews never block, also structural** (AC-5). A failed pipeline throws before line 197; `stop` aborts the chunk loop at `pipeline.ts:110-113` and `index.ts:115-126` exits without posting a review. Covered by test, not by new code.

### Risks

1. **The downgrade retry could double-post.** If the first `createReview` actually succeeded and the 422 came from a later step, the retry would create a second review. Mitigated because `createReview` is a single call whose failure means no review was created — step 6 asserts exactly one `createReview` call on the success path and exactly two on the downgrade path.
2. **`body` is required when `event` is `REQUEST_CHANGES` or `COMMENT`** (`types.d.ts:114859`). The current code always builds a body (`review.ts:67-84`), so this holds today; step 3's test asserts a non-empty body accompanies `REQUEST_CHANGES` so a future body-trimming refactor fails loudly instead of 422-ing in production.
3. **Real self-review 422 is unproven locally.** The manual check in How to Test is the only place this path meets the real API; it must be run with a token whose user authored the PR.

## Implementation Plan

1. - [ ] **RED — request_changes submits REQUEST_CHANGES**: in `tests/github/review.test.ts`, call `postPrReview(..., "request_changes")` with one in-hunk finding. Assert the mocked `createReview` received `event: "REQUEST_CHANGES"` and the result reports `event: "REQUEST_CHANGES", downgraded: false`. Run `npx vitest run packages/reviewer/tests/github/review.test.ts` → FAIL.
2. - [ ] **RED — comment_only submits COMMENT**: same file, `postPrReview(..., "comment_only")`. Assert `event: "COMMENT"` and `downgraded: false`. Run → FAIL.
3. - [ ] **RED — no `state` key, body always present**: same file, assert the `createReview` argument object has no `state` property and that `body` is a non-empty string for both events. Run → FAIL.
4. - [ ] **GREEN — event selection**: add the required `blocking` parameter, map it to the event, remove `state`, widen the return type. Run → 3 PASS.
5. - [ ] **GREEN — wire the pipeline**: pass `reviewerConfig.config.blocking` at `pipeline.ts:197-203`. Run `npx vitest run packages/reviewer/tests/pipeline.test.ts` → PASS.
6. - [ ] Commit: `feat(reviewer): honour blocking mode when submitting the PR review`
7. - [ ] **RED — 422 downgrades to COMMENT**: in `tests/github/review.test.ts`, mock `createReview` to reject with `{ status: 422 }` on the first call and resolve on the second. Call with `"request_changes"`. Assert `createReview` was called exactly twice, the second with `event: "COMMENT"`, the result is `{ event: "COMMENT", downgraded: true }`, and the second call's body mentions the downgrade. Run → FAIL.
8. - [ ] **RED — non-422 does not retry**: same file, mock a `{ status: 500 }` rejection. Assert `createReview` was called exactly once and the error propagates. Run → FAIL.
9. - [ ] **GREEN — downgrade path**: wrap the submit, catch status 422 when the event was `REQUEST_CHANGES`, append the downgrade note to the body, re-submit once as `COMMENT`. Run → PASS.
10. - [ ] Commit: `feat(reviewer): downgrade blocking review to a comment when GitHub rejects it`
11. - [ ] **RED — clean PR never blocks**: in `tests/pipeline.test.ts`, run a pipeline with `blocking: "request_changes"` whose LLM returns zero findings. Assert `postPrReview` was never called and `postReviewComment` was called once. Run → FAIL if uncovered, then PASS with no source change (locks decision 5).
12. - [ ] **RED — aborted review never blocks**: same file, run with `blocking: "request_changes"` and an already-aborted `AbortSignal`. Assert `createReview` was never called. Run → FAIL if uncovered, then PASS with no source change (locks decision 6).
13. - [ ] Commit: `test(reviewer): lock clean and cancelled reviews out of the blocking path`
14. - [ ] Run `pnpm test && pnpm lint && pnpm build` — all green.

## How to Test

- **Automated**: `pnpm test`. Must be green: `tests/github/review.test.ts` (REQUEST_CHANGES for `request_changes`, COMMENT for `comment_only`, no `state` key, non-empty body, 422 downgrades with exactly two calls, 500 propagates with exactly one call) and `tests/pipeline.test.ts` (blocking value reaches `postPrReview`, zero-findings skips it, aborted run skips it). Test count increases by 8; no previously-green test may turn red.
- **Manual verification**: set `blocking: request_changes` in `XamuAvila/kitten-test-repo`'s `.reviewer.yml` and open a PR **authored by a different account than the reviewer token's user**, containing a deliberate bug. Run the review on minikube. On the GitHub PR page the review appears under "Changes requested" and the merge button shows the review as unresolved. Then flip `.reviewer.yml` back to `blocking: comment_only`, re-run, and confirm the new review is a plain comment leaving merge state untouched.
- **Negative check**: three things must NOT happen — (1) with `blocking: request_changes` on a PR the **reviewer token's own user authored**, the job must still reach `completed` (`curl "$DISPATCHER_URL/status/<jobId>"`) with a comment-type review and a body line explaining the downgrade, never a `failed` status; (2) with `blocking: request_changes` on a PR that produces zero findings, no review may be submitted at all — only the "No issues found" comment; (3) sending `stop` mid-review must leave status `cancelled` with no `REQUEST_CHANGES` review on the PR.
- **Done means**: `pnpm test && pnpm lint && pnpm build` all green, AND `blocking: request_changes` provably puts a real PR into "Changes requested", AND a self-authored PR downgrades to a comment with the job still reporting `completed`.
