---
id: "KIT-009"
status: "backlog"
priority: "high"
assignee: ""
epic: "v2-github-integration"
dueDate: null
created: "2026-08-03"
modified: "2026-08-03"
completedAt: null
labels: ["reviewer", "github"]
order: "b4"
---

# PR Comment Posting

## User Story

See [US-009](../../docs/stories/US-009-pr-comment-posting.md).

## Technical Refinement

### Files

**Created:**
- `packages/reviewer/src/github/comment.ts` — `postReviewComment(octokit, repo, prNumber, body): Promise<CommentResult>` posts initial review placeholder; `postFollowUpAck(octokit, repo, prNumber, message): Promise<CommentResult>` posts follow-up acknowledgment comment
- `packages/reviewer/src/github/pr.ts` — `fetchPrMetadata(octokit, repo, prNumber): Promise<PrMetadata>` fetches PR title, author, state, head/base refs via GitHub API
- `packages/reviewer/src/github/index.ts` — barrel export + `createOctokitClient(token): Octokit` factory wrapping `new Octokit({ auth: token })`
- `packages/reviewer/tests/github/comment.test.ts` — postReviewComment and postFollowUpAck with mocked Octokit, success and error cases
- `packages/reviewer/tests/github/pr.test.ts` — fetchPrMetadata with mocked Octokit, success and error cases

**Modified:**
- `packages/reviewer/src/pipeline.ts` (KIT-007 baseline) — after dry-run analysis, call `postReviewComment()` with formatted body. Comment failure is non-fatal: log error, continue pipeline.
- `packages/reviewer/src/agent.ts` (KIT-008 baseline) — in follow_up message handler, call `postFollowUpAck()` after incrementing counter. Comment failure is non-fatal: log error, do not crash agent.

### Consumes

From KIT-007 (`packages/reviewer`):
- `runPipeline()` produces `PipelineResult` with dry-run data: `tokenEstimate`, `model`, `fileCount`, `skippedCount`, `additions`, `deletions` — used to format initial review comment body.
- `packages/reviewer/src/pipeline.ts` — insertion point for `postReviewComment()` call.

From KIT-008 (`packages/reviewer`):
- `startAgent()` in `packages/reviewer/src/agent.ts` — insertion point for `postFollowUpAck()` call inside the follow_up message handler.
- Agent has access to Octokit client (created from `GITHUB_TOKEN` env var in `index.ts`, passed to both pipeline and agent).

From `@kitten/shared`:
- `FollowUpMessage` type — `{ message, sender }` — used to format follow-up ack body.
- `AppError` type — for wrapping GitHub API errors.

Environment:
- `GITHUB_TOKEN` — required for Octokit authentication (injected by K8s Secret).
- `REVIEW_REPO` — `"owner/repo"` format, split for Octokit calls.
- `REVIEW_PR_NUMBER` — PR number for comment posting.

### Produces

- PR comment capability used by pipeline (initial review placeholder) and agent (follow-up ack).
- `PrMetadata` type and fetch function — available for future cards that need PR context (title, author).
- Octokit client factory — reusable by any module that needs GitHub API access.
- Comment format templates — structured markdown with `[KITTEN-TEST]` prefix for test fixture identification.

### Design decisions

1. **Issues API for comments, not PR Review API** — PRs are issues in GitHub; `POST /repos/{owner}/{repo}/issues/{issue_number}/comments` creates a simple comment. The PR Review API (`POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`) is designed for multi-file inline reviews with approve/reject — overkill for v2 placeholder comments. Rejected: PR Review API (more complex request shape, not needed until v3 when real findings exist).
2. **Comment failure is non-fatal** — if `postReviewComment()` or `postFollowUpAck()` throws (network error, 403 rate limit, 422 PR closed), the pipeline/agent logs the error and continues. The review's value is the analysis, not the comment delivery. Rejected: fail entire pipeline on comment error (one GitHub API hiccup should not invalidate a successful review).
3. **`[KITTEN-TEST]` prefix in all comments** — distinguishes automated test comments from real review comments on the test fixture repo (`XamuAvila/kitten-test-repo` PR #1). Makes cleanup and filtering trivial. Prefix applied unconditionally in v2; future versions may make it conditional.
4. **Octokit as explicit dependency** — `@octokit/rest` as a direct dependency of `packages/reviewer`. Client created once in `index.ts`, passed down to pipeline and agent. Rejected: importing Octokit in each module (multiple instances, harder to mock in tests).
5. **Separate `PrMetadata` fetch from comment posting** — `fetchPrMetadata()` is its own function even though v2 doesn't strictly need PR metadata in comments. Keeps concern separation clean and provides data for future comment templates (author name, PR title). Rejected: embedding metadata fetch inside `postReviewComment()` (couples concerns, harder to test).

### Risks

1. **GitHub API rate limit** — authenticated requests allow 5000/hour. Unlikely to hit in v2 (each review = 2-3 API calls), but should handle 403 response gracefully with a clear error message rather than a cryptic crash.
2. **PR closed or merged when commenting** — GitHub returns 422 if the issue/PR is locked. Handler should catch 422, log warning "PR may be closed/locked", and continue without crashing.
3. **Token permission scope** — `GITHUB_TOKEN` needs `repo` scope (or `public_repo` for public repos) to post comments. If the token lacks permission, Octokit throws 403. Error message should hint at token scope, not just "forbidden".

## Implementation Plan

1. - [ ] **Test (RED):** Write `packages/reviewer/tests/github/pr.test.ts` — mock Octokit `rest.pulls.get` response. Test `fetchPrMetadata(octokit, "owner/repo", 1)`: returns `PrMetadata { title, author, state, headRef, baseRef }`. Test 404 case: mock rejection with status 404 → throws AppError with `code: "NOT_FOUND"`. Command: `pnpm test -- packages/reviewer/tests/github/pr.test.ts` — expected: FAIL (module does not exist).
2. - [ ] **Implement (GREEN):** Create `packages/reviewer/src/github/pr.ts` with `fetchPrMetadata()` — calls `octokit.rest.pulls.get({ owner, repo, pull_number })`, maps response to `PrMetadata`. Wraps errors: 404 → `NOT_FOUND`, other → `GITHUB_API_ERROR`. Create `packages/reviewer/src/github/index.ts` — barrel + `createOctokitClient(token)`. Command: `pnpm test -- packages/reviewer/tests/github/pr.test.ts` — expected: PASS.
3. - [ ] Commit: `feat: add PR metadata fetching via GitHub API`
4. - [ ] **Test (RED):** Write `packages/reviewer/tests/github/comment.test.ts` — mock Octokit `rest.issues.createComment`. Test `postReviewComment(octokit, "owner/repo", 1, "review body")`: verify `octokit.rest.issues.createComment` called with `{ owner: "owner", repo: "repo", issue_number: 1, body: "review body" }`, returns `CommentResult { id, url }`. Test `postFollowUpAck(octokit, "owner/repo", 1, "explain X")`: verify comment body contains `"explain X"` and `[KITTEN-TEST]` prefix. Test 403 error: mock rejection with status 403 → throws AppError with `code: "RATE_LIMITED"`. Test 422 error: mock rejection with status 422 → throws AppError with `code: "UNPROCESSABLE"`. Command: `pnpm test -- packages/reviewer/tests/github/comment.test.ts` — expected: FAIL.
5. - [ ] **Implement (GREEN):** Create `packages/reviewer/src/github/comment.ts` — `postReviewComment()` calls `octokit.rest.issues.createComment`, returns `{ id, url }`. `postFollowUpAck()` builds ack body from template, calls same endpoint. Error mapping: 403 → `RATE_LIMITED`, 404 → `NOT_FOUND`, 422 → `UNPROCESSABLE`. Command: `pnpm test -- packages/reviewer/tests/github/comment.test.ts` — expected: PASS.
6. - [ ] Commit: `feat: add PR comment posting for review and follow-up ack`
7. - [ ] **Test (RED):** Update `packages/reviewer/tests/pipeline.test.ts` — add test: after dry-run, `postReviewComment` is called with formatted body containing repo name, PR number, file count, token estimate, model. Add test: if `postReviewComment` throws, pipeline still completes (non-fatal). Command: `pnpm test -- packages/reviewer/tests/pipeline.test.ts` — expected: FAIL (new assertions).
8. - [ ] **Implement (GREEN):** Modify `packages/reviewer/src/pipeline.ts` — after `dryRunAnalysis()`, build comment body from template using `PipelineResult` data, call `postReviewComment()` inside try/catch (catch logs error, does not rethrow). Command: `pnpm test -- packages/reviewer/tests/pipeline.test.ts` — expected: PASS.
9. - [ ] Commit: `feat: integrate PR comment posting into review pipeline`
10. - [ ] **Test (RED):** Update `packages/reviewer/tests/agent.test.ts` — add test: on follow_up message, `postFollowUpAck` is called with the follow-up message text. Add test: if `postFollowUpAck` throws, agent continues (does not crash, idle timer still running). Command: `pnpm test -- packages/reviewer/tests/agent.test.ts` — expected: FAIL (new assertions).
11. - [ ] **Implement (GREEN):** Modify `packages/reviewer/src/agent.ts` — in follow_up handler, after `incrementFollowUpCount()`, call `postFollowUpAck()` inside try/catch. Command: `pnpm test -- packages/reviewer/tests/agent.test.ts` — expected: PASS.
12. - [ ] Commit: `feat: integrate follow-up ack comment into agent lifecycle`
13. - [ ] Run full suite: `pnpm test && pnpm lint` — expected: all green.

### Comment Templates

**Initial review (posted by pipeline):**

```markdown
🐱 **Kitten Review** [KITTEN-TEST]

**Repo:** {repo} | **PR:** #{prNumber} | **Files:** {count}

---

📋 **Dry Run Summary**
- Token estimate: {tokens}k tokens
- Model: {model}
- Files analyzed: {count} ({skipped} skipped)
- Diff: +{additions} -{deletions}

> This is a dry-run review (v2). Real LLM analysis coming in v3.
```

**Follow-up ack (posted by agent):**

```markdown
🐱 **Kitten** [KITTEN-TEST]

Received your message: "{message}"

> Follow-up processing with LLM available in v3.
```

## How to Test

- **Automated**: `pnpm test -- packages/reviewer/tests/github/` — all tests pass:
  - `fetchPrMetadata returns PrMetadata for valid PR`
  - `fetchPrMetadata throws NOT_FOUND for 404`
  - `postReviewComment calls issues.createComment with correct params`
  - `postReviewComment returns CommentResult with id and url`
  - `postFollowUpAck formats ack body with message and KITTEN-TEST prefix`
  - `postReviewComment throws RATE_LIMITED for 403`
  - `postReviewComment throws UNPROCESSABLE for 422`
  - `pipeline calls postReviewComment after dry-run`
  - `pipeline completes even if postReviewComment throws`
  - `agent calls postFollowUpAck on follow_up message`
  - `agent continues even if postFollowUpAck throws`
- **Manual verification**:
  1. Set `GITHUB_TOKEN` env var with a PAT that has `repo` scope
  2. Run reviewer against test fixture: `REVIEW_REPO=XamuAvila/kitten-test-repo REVIEW_PR_NUMBER=1 ...other envs... node packages/reviewer/dist/index.js`
  3. Check PR #1 on `XamuAvila/kitten-test-repo` — new comment with `🐱 **Kitten Review** [KITTEN-TEST]` header and dry-run summary
  4. Send follow-up via Redis: `redis-cli PUBLISH review:{jobId}:messages '{"type":"follow_up","payload":{"message":"test follow-up","sender":"test"},"timestamp":"..."}'`
  5. Check PR #1 again — new comment with `🐱 **Kitten** [KITTEN-TEST]` and `Received your message: "test follow-up"`
- **Negative check**: Temporarily use an invalid token → reviewer logs `GITHUB_API_ERROR` or `RATE_LIMITED` but pipeline still completes (comment posting is non-fatal). Check that NO token value appears in log output.
- **Done means**: `pipeline posts placeholder review comment on PR after dry-run → agent posts follow-up ack comment on follow_up message → both are non-fatal (errors logged, execution continues) → comments appear on GitHub PR with [KITTEN-TEST] prefix`.
