---
id: "KIT-007"
status: "done"
priority: "high"
assignee: ""
epic: "v2-github-integration"
dueDate: null
created: "2026-08-03"
modified: "2026-08-03"
completedAt: "2026-08-03"
labels: ["reviewer", "github"]
order: "b2"
---

# Reviewer Pipeline

## User Story

See [US-007](../../docs/stories/US-007-authenticated-review-pipeline.md).

## Technical Refinement

### Files

**Created:**
- `packages/reviewer/package.json` — package `@kitten/reviewer`, deps: `simple-git`, `@octokit/rest`, `ioredis`, `picomatch`, `@kitten/shared`; devDeps: `vitest`, `@types/node`; scripts: `build`, `start`, `test`
- `packages/reviewer/tsconfig.json` — extends `../../tsconfig.base.json`, references `../shared`
- `packages/reviewer/src/index.ts` — entrypoint: reads env vars (`REVIEW_JOB_ID`, `REVIEW_REPO`, `REVIEW_PR_NUMBER`, `REVIEW_HEAD_REF`, `REVIEW_BASE_REF`, `REVIEW_SENDER`, `GITHUB_TOKEN`, `REDIS_URL`), validates required envs, calls `runPipeline`, then hands off to agent (KIT-008). On error: reports `failed` status to Redis, exits with code 1.
- `packages/reviewer/src/pipeline.ts` — `runPipeline(config: PipelineConfig): Promise<PipelineResult>`. Orchestrates: clone → diff → fetch PR files → read reviewer config → dry-run analysis → return result. Pure function (all I/O injected via config). Clone dir: `/tmp/clones/{jobId}/`. Cleanup in `finally` block.
- `packages/reviewer/src/git/clone.ts` — `cloneRepo(repo: string, branch: string, destDir: string, token: string): Promise<CloneResult>`. Migrated from `packages/worker/src/git/clone.ts` with auth URL: `https://x-access-token:${token}@github.com/${repo}.git`. Token NEVER logged — URL is constructed but only the sanitized form `https://x-access-token:***@github.com/${repo}.git` appears in any log line.
- `packages/reviewer/src/git/diff.ts` — `generateDiff(repoDir: string, baseRef: string, headRef: string): Promise<DiffResult>`. Runs `git diff ${baseRef}...${headRef} --stat` and `git diff ${baseRef}...${headRef}` via simple-git. Returns `DiffResult { raw: string, filesChanged: number, insertions: number, deletions: number }`.
- `packages/reviewer/src/git/files.ts` — `fetchPrFiles(repo: string, prNumber: number, token: string, skipPatterns: readonly string[]): Promise<readonly PullRequestFile[]>`. Uses `@octokit/rest` to call `pulls.listFiles`. Filters out files matching skip patterns via `picomatch`. Returns `PullRequestFile[]` (from `@kitten/shared`).
- `packages/reviewer/src/git/index.ts` — barrel exporting `cloneRepo`, `generateDiff`, `fetchPrFiles`
- `packages/reviewer/src/analyzer/dry-run.ts` — `dryRunAnalysis(context: DryRunContext, totalChars: number): DryRunResult`. Migrated from `packages/worker/src/analyzer/dry-run.ts`. Log prefix changed from `[worker]` to `[reviewer]`. Same logic: token estimate = `Math.ceil(totalChars / 4)`, logs file counts and dry-run message.
- `packages/reviewer/src/analyzer/index.ts` — barrel exporting `dryRunAnalysis`
- `packages/reviewer/src/types.ts` — internal types: `CloneResult { dir: string, sizeBytes: number }`, `DiffResult { raw: string, filesChanged: number, insertions: number, deletions: number }`, `DryRunContext { jobId: string, repo: string, prNumber: number, config: ReviewerConfig, fileCount: FileCount, diff: DiffResult }`, `DryRunResult { dryRun: true, model: string, tokenEstimate: number, fileCount: FileCount }`, `PipelineConfig { jobId: string, repo: string, prNumber: number, headRef: string, baseRef: string, token: string, redisUrl: string, skipPatterns: readonly string[] }`, `PipelineResult { status: "completed" | "failed", dryRun: boolean, diff?: DiffResult, error?: string, metadata: { repo: string, prNumber: number, durationMs: number } }`
- `packages/reviewer/tests/git/clone.test.ts` — mock `simple-git`: (a) verify clone URL includes `x-access-token:${token}`, (b) verify `--depth=1 --branch`, (c) verify error wraps in `AppError(NOT_FOUND)`, (d) verify token is NOT present in error message or AppError details
- `packages/reviewer/tests/git/diff.test.ts` — mock `simple-git`: (a) verify `git diff baseRef...headRef --stat` is called, (b) verify `DiffResult` fields parsed from mock stat output, (c) verify error wraps in `AppError`
- `packages/reviewer/tests/git/files.test.ts` — mock `@octokit/rest`: (a) verify `pulls.listFiles` called with correct owner, repo, pull_number, (b) verify response mapped to `PullRequestFile[]`, (c) verify skip patterns filter out matching files, (d) verify empty skip patterns return all files
- `packages/reviewer/tests/analyzer/dry-run.test.ts` — migrated from `packages/worker/tests/analyzer/dry-run.test.ts`: (a) verify token estimate = `Math.ceil(totalChars / 4)`, (b) verify model from config, (c) verify log prefix is `[reviewer]`
- `packages/reviewer/tests/pipeline.test.ts` — mock all deps (clone, diff, files, analyzer): (a) verify pipeline calls steps in order: clone → diff → fetchPrFiles → dryRunAnalysis, (b) verify clone cleanup runs on success, (c) verify clone cleanup runs on failure, (d) verify `PipelineResult.status` is `completed` on success and `failed` on error, (e) verify diff result is included in pipeline result

**Modified:**
- None in other packages. This is a new package.

### Consumes

From `@kitten/shared` (`packages/shared/src/types/`):
- `ReviewerConfig` type + `parseReviewerConfig(yaml)` + `DEFAULT_CONFIG` — read `.reviewer.yml` from cloned repo
- `AppError` class — structured errors for clone/diff/API failures
- `PullRequestFile` type — mirror of GitHub API response (defined in epic, to be added to shared types if not present)

From KIT-005:
- `packages/reviewer/Dockerfile` — container image definition (reviewer code runs inside this)

From KIT-006:
- Pod env vars injected by dispatcher: `REVIEW_JOB_ID`, `REVIEW_REPO`, `REVIEW_PR_NUMBER`, `REVIEW_HEAD_REF`, `REVIEW_BASE_REF`, `REVIEW_SENDER`, `GITHUB_TOKEN`, `REDIS_URL`, `POD_IDLE_TIMEOUT_MS`

From `packages/worker/` (migration source, being removed in KIT-006):
- `packages/worker/src/git/clone.ts` — `cloneRepo` logic migrated, auth URL added
- `packages/worker/src/git/files.ts` — `readChangedFiles` logic replaced by `fetchPrFiles` (GitHub API instead of local fs)
- `packages/worker/src/analyzer/dry-run.ts` — `dryRunAnalysis` migrated, log prefix changed
- `packages/worker/src/pipeline.ts` — `runPipeline` structure migrated, diff step added, cleanup logic kept
- `packages/worker/src/types.ts` — `CloneResult`, `DryRunContext`, `DryRunResult`, `PipelineResult` migrated to `packages/reviewer/src/types.ts`

### Produces

Consumed by KIT-008 (Agent Lifecycle):
- `runPipeline(config)` function — agent entrypoint calls this, then starts the pub/sub subscription loop
- `PipelineResult` — agent uses this to decide whether to enter `reviewing` state or `failed` state

Consumed by KIT-009 (GitHub Comments):
- Pipeline produces the dry-run output — comment posting uses this to compose the placeholder PR comment

Consumed by KIT-010 (E2E):
- Complete reviewer pipeline: clone with auth → real diff → PR files → dry-run → result

### Design decisions

1. **Auth URL format `x-access-token:${token}`** — GitHub's recommended format for token-authenticated HTTPS clones. Works with both personal access tokens and GitHub App installation tokens. Rejected: SSH key auth (requires key management in container), `Authorization` header (only works with API, not git clone).
2. **Token never in logs** — `cloneRepo` constructs the auth URL internally but every log line uses the sanitized form `https://x-access-token:***@github.com/${repo}.git`. The `AppError.details` field also sanitizes the URL. Invariant: grep for token value in any log output must return zero matches.
3. **`@octokit/rest` for PR files** — official GitHub API client, typed, handles pagination, rate limiting, auth. `pulls.listFiles` returns up to 3000 files (paginated). Rejected: raw `fetch` to GitHub API (no pagination, no types), `git diff --name-only` (misses additions/deletions counts, no `patch` field).
4. **Skip patterns via `picomatch`** — matches worker's v1 approach (`minimatch` in worker, `picomatch` in reviewer). `picomatch` is faster and has no deprecated dependencies. Same glob syntax. Rejected: keeping `minimatch` (deprecated warnings).
5. **Pipeline as pure function** — all I/O (git, GitHub API, filesystem) happens through injected config. The pipeline function itself is testable with mocks. Same pattern as `packages/worker/src/pipeline.ts` (`pipeline.ts:14-18`). Rejected: side-effectful pipeline with hardcoded dependencies (untestable).
6. **`generateDiff` via simple-git** — runs `git diff baseRef...headRef` after clone. The three-dot syntax (`...`) gives the diff of changes introduced by headRef since it diverged from baseRef. Returns both raw diff and parsed stats. Rejected: GitHub API diff (rate-limited, doesn't work for private repos without extra scopes), `git log -p` (different semantics).
7. **DiffResult includes raw diff** — the raw unified diff is stored for future LLM consumption (v3). In v2, only the stats (`filesChanged`, `insertions`, `deletions`) are logged. The raw field is carried through but not printed.

### Risks

1. **`@octokit/rest` rate limiting** — unauthenticated: 60 req/hour, authenticated: 5000 req/hour. With `GITHUB_TOKEN`, rate limiting is not a concern for dev/test. But if token is missing or expired, `fetchPrFiles` fails. Test must verify the error is wrapped in `AppError(AUTH_FAILED)`.
2. **PR with >3000 changed files** — `pulls.listFiles` paginates at 3000 max. For v2, this is acceptable (reviews of 3000+ file PRs are impractical). Log a warning if truncated.
3. **Diff on shallow clone** — `--depth=1` clone may not have the base ref. `cloneRepo` clones the head branch. To diff against base, need to fetch the base ref: `git fetch origin ${baseRef} --depth=1`. The `generateDiff` step must handle this fetch before the diff command.
4. **Worker removal ordering** — KIT-006 removes `packages/worker/`. If KIT-007 is implemented before KIT-006, the worker code is still available for reference. If after, the migration source is in git history. Plan: read worker code BEFORE starting implementation (this refinement already captures the relevant code).

## Implementation Plan

1. - [ ] **Scaffold package:** Create `packages/reviewer/package.json` with deps (`simple-git`, `@octokit/rest`, `ioredis`, `picomatch`, `@kitten/shared`), devDeps (`vitest`, `@types/node`), scripts (`build: tsc -b`, `start: node dist/index.js`, `test: vitest run`). Create `packages/reviewer/tsconfig.json` extending `../../tsconfig.base.json`. Create `packages/reviewer/src/types.ts` with `CloneResult`, `DiffResult`, `DryRunContext`, `DryRunResult`, `PipelineConfig`, `PipelineResult`. Run `pnpm install` — expected: no errors, workspace resolves `@kitten/shared`.
2. - [ ] Commit: `chore: scaffold reviewer package`
3. - [ ] **Test (RED):** Write `packages/reviewer/tests/git/clone.test.ts`. Tests: (a) `cloneRepo constructs auth URL with x-access-token` — mock `simpleGit().clone`, verify first arg is `https://x-access-token:test-token@github.com/owner/repo.git`. (b) `cloneRepo passes --depth=1 and --branch` — verify options object. (c) `cloneRepo wraps git errors in AppError NOT_FOUND` — mock clone rejection, verify thrown error is `AppError` with `code: "NOT_FOUND"`. (d) `cloneRepo does not leak token in error details` — mock clone rejection, verify `AppError.details` does not contain `test-token` string. Command: `pnpm test -- packages/reviewer/tests/git/clone.test.ts` — expected: FAIL.
4. - [ ] **Implement (GREEN):** Create `packages/reviewer/src/git/clone.ts`. Migrate from `packages/worker/src/git/clone.ts`, add `token` parameter, construct auth URL `https://x-access-token:${token}@github.com/${repo}.git`. Sanitize token in all error paths. Create `packages/reviewer/src/git/index.ts` barrel. Command: `pnpm test -- packages/reviewer/tests/git/clone.test.ts` — expected: PASS.
5. - [ ] Commit: `feat: add authenticated git clone for reviewer`
6. - [ ] **Test (RED):** Write `packages/reviewer/tests/git/diff.test.ts`. Tests: (a) `generateDiff calls git fetch for base ref` — mock `simpleGit().fetch`, verify called with `origin ${baseRef} --depth=1`. (b) `generateDiff calls git diff with three-dot syntax` — mock `simpleGit().diff`, verify called with `["${baseRef}...${headRef}"]`. (c) `generateDiff parses stat output into DiffResult` — mock `simpleGit().diffSummary`, return `{ changed: 3, insertions: 31, deletions: 0 }`, verify `DiffResult { filesChanged: 3, insertions: 31, deletions: 0 }`. (d) `generateDiff wraps errors in AppError` — mock diff rejection, verify AppError. Command: `pnpm test -- packages/reviewer/tests/git/diff.test.ts` — expected: FAIL.
7. - [ ] **Implement (GREEN):** Create `packages/reviewer/src/git/diff.ts` with `generateDiff(repoDir, baseRef, headRef)`. Uses `simpleGit(repoDir)` to fetch base ref then run diff. Parses `diffSummary` for stats, `diff` for raw output. Export from barrel. Command: `pnpm test -- packages/reviewer/tests/git/diff.test.ts` — expected: PASS.
8. - [ ] Commit: `feat: add git diff generation for reviewer`
9. - [ ] **Test (RED):** Write `packages/reviewer/tests/git/files.test.ts`. Tests: (a) `fetchPrFiles calls Octokit pulls.listFiles with correct params` — mock Octokit, verify `owner`, `repo` (split from "owner/repo"), `pull_number`. (b) `fetchPrFiles maps response to PullRequestFile[]` — mock API response with 3 files, verify mapping of `filename`, `status`, `additions`, `deletions`, `changes`, `patch`, `blob_url → blobUrl`, `raw_url → rawUrl`. (c) `fetchPrFiles filters files by skip patterns` — provide skip `["**/*.md"]`, mock response with `README.md` + `src/app.ts`, verify only `src/app.ts` returned. (d) `fetchPrFiles returns all files when no skip patterns` — empty skip array, verify all files returned. (e) `fetchPrFiles wraps auth errors in AppError AUTH_FAILED` — mock 401 response, verify AppError with `code: "AUTH_FAILED"`. Command: `pnpm test -- packages/reviewer/tests/git/files.test.ts` — expected: FAIL.
10. - [ ] **Implement (GREEN):** Create `packages/reviewer/src/git/files.ts` with `fetchPrFiles(repo, prNumber, token, skipPatterns)`. Instantiates `Octokit({ auth: token })`. Calls `octokit.pulls.listFiles({ owner, repo, pull_number, per_page: 100 })` with auto-pagination. Maps snake_case API response to camelCase `PullRequestFile`. Filters with `picomatch`. Export from barrel. Command: `pnpm test -- packages/reviewer/tests/git/files.test.ts` — expected: PASS.
11. - [ ] Commit: `feat: add GitHub PR file fetcher with skip patterns`
12. - [ ] **Test (RED):** Write `packages/reviewer/tests/analyzer/dry-run.test.ts`. Tests: (a) `dryRunAnalysis estimates tokens as ceil(chars/4)` — input 1000 chars → 250 tokens. (b) `dryRunAnalysis returns model from config` — config with `model: "claude-sonnet-5"`, verify result. (c) `dryRunAnalysis includes file count in result`. (d) `dryRunAnalysis logs with [reviewer] prefix` — spy on console.log, verify prefix. Command: `pnpm test -- packages/reviewer/tests/analyzer/dry-run.test.ts` — expected: FAIL.
13. - [ ] **Implement (GREEN):** Create `packages/reviewer/src/analyzer/dry-run.ts`. Migrate from `packages/worker/src/analyzer/dry-run.ts` (`dry-run.ts:7-27`), change `[worker]` to `[reviewer]` in all log lines. Create `packages/reviewer/src/analyzer/index.ts` barrel. Command: `pnpm test -- packages/reviewer/tests/analyzer/dry-run.test.ts` — expected: PASS.
14. - [ ] Commit: `feat: add dry-run analyzer for reviewer`
15. - [ ] **Test (RED):** Write `packages/reviewer/tests/pipeline.test.ts`. Mock all deps (`cloneRepo`, `generateDiff`, `fetchPrFiles`, `dryRunAnalysis`, `parseReviewerConfig`). Tests: (a) `runPipeline calls steps in order: clone → diff → fetchPrFiles → analyze` — verify call order via mock call sequence. (b) `runPipeline returns completed PipelineResult on success` — verify `status: "completed"`, `dryRun: true`, `diff` present, `metadata` with repo/prNumber/durationMs. (c) `runPipeline cleans up clone dir on success` — mock `fs.rmSync`, verify called with clone dir. (d) `runPipeline cleans up clone dir on failure` — mock `cloneRepo` to throw, verify `fs.rmSync` still called. (e) `runPipeline returns failed PipelineResult on clone error` — verify `status: "failed"`, `error` message. (f) `runPipeline reads .reviewer.yml from cloned repo` — mock `fs.existsSync` + `fs.readFileSync`, verify `parseReviewerConfig` called. (g) `runPipeline uses DEFAULT_CONFIG when .reviewer.yml missing` — mock `fs.existsSync` returning false, verify default config used. Command: `pnpm test -- packages/reviewer/tests/pipeline.test.ts` — expected: FAIL.
16. - [ ] **Implement (GREEN):** Create `packages/reviewer/src/pipeline.ts` with `runPipeline(config: PipelineConfig): Promise<PipelineResult>`. Migrate structure from `packages/worker/src/pipeline.ts` (`pipeline.ts:14-83`): add `generateDiff` step after clone, replace `countRepoFiles` with `fetchPrFiles`, keep `readConfigFromRepo`, keep `cleanup` in finally. Create `packages/reviewer/src/index.ts` entrypoint: reads envs, validates, calls `runPipeline`, logs result. Command: `pnpm test -- packages/reviewer/tests/pipeline.test.ts` — expected: PASS.
17. - [ ] Commit: `feat: add reviewer pipeline orchestration`
18. - [ ] **Full test suite:** `pnpm test -- packages/reviewer/ && pnpm lint` — expected: all green.
19. - [ ] **Build verification:** `pnpm build` — expected: `packages/reviewer/dist/` exists with compiled JS.
20. - [ ] Commit: `feat: complete reviewer pipeline package`

## How to Test

- **Automated**: `pnpm test -- packages/reviewer/` — all tests pass:
  - `cloneRepo constructs auth URL with x-access-token`
  - `cloneRepo passes --depth=1 and --branch`
  - `cloneRepo wraps git errors in AppError NOT_FOUND`
  - `cloneRepo does not leak token in error details`
  - `generateDiff calls git fetch for base ref`
  - `generateDiff calls git diff with three-dot syntax`
  - `generateDiff parses stat output into DiffResult`
  - `generateDiff wraps errors in AppError`
  - `fetchPrFiles calls Octokit pulls.listFiles with correct params`
  - `fetchPrFiles maps response to PullRequestFile[]`
  - `fetchPrFiles filters files by skip patterns`
  - `fetchPrFiles returns all files when no skip patterns`
  - `fetchPrFiles wraps auth errors in AppError AUTH_FAILED`
  - `dryRunAnalysis estimates tokens as ceil(chars/4)`
  - `dryRunAnalysis returns model from config`
  - `dryRunAnalysis includes file count in result`
  - `dryRunAnalysis logs with [reviewer] prefix`
  - `runPipeline calls steps in order`
  - `runPipeline returns completed PipelineResult on success`
  - `runPipeline cleans up clone dir on success`
  - `runPipeline cleans up clone dir on failure`
  - `runPipeline returns failed PipelineResult on clone error`
  - `runPipeline reads .reviewer.yml from cloned repo`
  - `runPipeline uses DEFAULT_CONFIG when .reviewer.yml missing`
- **Manual verification**:
  1. `pnpm build` — reviewer package compiles without errors
  2. Set env vars locally: `REVIEW_JOB_ID=test-1 REVIEW_REPO=XamuAvila/kitten-test-repo REVIEW_PR_NUMBER=1 REVIEW_HEAD_REF=test/add-feature REVIEW_BASE_REF=master REVIEW_SENDER=test GITHUB_TOKEN=ghp_... REDIS_URL=redis://localhost:6379 node packages/reviewer/dist/index.js`
  3. Logs show: `[reviewer] Cloning XamuAvila/kitten-test-repo...`, `[reviewer] Clone complete: ...`, `[reviewer] Diff: N files changed, +X -Y`, `[reviewer] PR files: N`, `[reviewer] DRY RUN — would send Xk tokens to ...`
  4. Clone dir `/tmp/clones/test-1/` does not exist after run (cleaned up)
- **Negative check**: Run with invalid `GITHUB_TOKEN=invalid` — logs show `[reviewer] Clone failed: ...` or `[reviewer] PR files fetch failed: ...`, process exits with code 1. Run with missing `REVIEW_REPO` env var — logs show validation error, process exits with code 1. Grep all source files for token value: `grep -r "ghp_" packages/reviewer/src/` — zero matches (no hardcoded tokens).
- **Done means**: `pnpm test -- packages/reviewer/` passes with 80%+ coverage, `pnpm build` succeeds, manual run with valid token against `XamuAvila/kitten-test-repo` PR #1 produces complete dry-run log output, clone dir is cleaned up, and no token appears in any log line.
