---
id: "KIT-004"
status: "done"
priority: "high"
assignee: ""
epic: "v1-scaffolding-dry-run"
dueDate: null
created: "2026-08-02"
modified: "2026-08-02"
completedAt: null
labels: ["worker"]
order: "a3"
---

# Dry-Run Review Pipeline

## User Story

See [US-004](../../docs/stories/US-004-dry-run-review.md).

## Technical Refinement

### Files

**Created:**
- `packages/worker/src/consumer.ts` — BullMQ Worker that listens on queue `"reviews"`, delegates to pipeline
- `packages/worker/src/pipeline.ts` — orchestrates: clone → read config → list files → dry-run log → cleanup
- `packages/worker/src/git/clone.ts` — `cloneRepo(repo: string, branch: string, destDir: string): Promise<CloneResult>`
- `packages/worker/src/git/files.ts` — `readChangedFiles(repoDir: string, changedPaths: readonly string[], config: ReviewerConfig): Promise<FileContent[]>`
- `packages/worker/src/git/index.ts` — barrel
- `packages/worker/src/analyzer/dry-run.ts` — `dryRunAnalysis(context: DryRunContext): DryRunResult` — logs what WOULD happen, no LLM call
- `packages/worker/src/analyzer/index.ts` — barrel
- `packages/worker/src/types.ts` — `CloneResult`, `FileContent`, `DryRunContext`, `DryRunResult` local types
- `packages/worker/tests/git/clone.test.ts` — clone unit tests (mock simple-git)
- `packages/worker/tests/git/files.test.ts` — file reading + skip pattern tests
- `packages/worker/tests/pipeline.test.ts` — pipeline integration test
- `packages/worker/tests/analyzer/dry-run.test.ts` — dry-run output tests

**Modified:**
- `packages/worker/src/index.ts` (KIT-002 baseline) — replace placeholder with consumer startup. Lines: entire file rewritten.

### Consumes

From KIT-001 (`@kitten/shared`):
- `ReviewJob` type — deserialized from BullMQ job data
- `ReviewerConfig` type + `parseReviewerConfig(yamlContent: string)` — parse .reviewer.yml from cloned repo
- `DEFAULT_CONFIG` — fallback when no .reviewer.yml found
- `AppError` type — structured errors for clone failures

From KIT-002:
- Docker Compose with Redis — BullMQ backend
- Worker Dockerfile with git installed — required for simple-git
- Volume mount `/tmp/kitten-clones` — workspace for cloned repos

From KIT-003:
- BullMQ queue name: `"reviews"` — consumer listens on this queue
- Job ID format: `review-{owner}-{repo}-{prNumber}` — used in log lines and clone dir naming
- Job data shape: `ReviewJob` — worker expects this exact structure

### Produces

This is the last card in v1. Produces the dry-run output visible in worker logs:
- `[worker] Processing job: {jobId}`
- `[worker] Cloning {repo} (depth=1)...`
- `[worker] Clone complete: {size}`
- `[worker] Files in repo: {total}`
- `[worker] Files after skip patterns: {filtered}` (skipped {count})
- `[worker] Source: changedFiles from payload` (or `all files in repo — no changedFiles in payload`)
- `[worker] Config loaded: language={lang}, model={model}, skip={count} patterns` (or `using defaults`)
- `[worker] DRY RUN — would send {tokens}k tokens to {model}`
- `[worker] DRY RUN — would post PR comment with findings`
- `[worker] Cleanup: removed clone dir`
- `[worker] Job completed in {duration}s`

Job status transitions visible via dispatcher `GET /status/:jobId`: `waiting → active → completed` (or `failed`).

### Design decisions

1. **Pipeline as pure function** — `runPipeline(job: ReviewJob, config: ReviewerConfig): Promise<PipelineResult>`. Consumer only does BullMQ plumbing; pipeline is testable without Redis. Rejected: all logic in consumer callback (untestable).
2. **Clone dir per job** — `/tmp/clones/{jobId}/` — unique per job, no conflicts. Cleanup in `finally` block guarantees removal even on error.
3. **simple-git with explicit git binary** — `simpleGit({ binary: 'git' })`. Avoids PATH issues in Docker. Rejected: child_process.exec('git ...') (fragile quoting, no error typing).
4. **Skip pattern applied client-side** — worker receives changed file list (from job payload in v1, from GitHub API in v2), filters with picomatch against config skip patterns. Rejected: git-level exclusion (doesn't work with API-sourced file lists).
5. **Changed files in v1 = all files in repo** — since we don't have GitHub API integration yet, the dry run lists ALL files in the clone as "changed" (or accepts an optional `changedFiles` array in the job payload for testing). v2 gets real changed files from GitHub PR API.
6. **Token estimation** — rough: `Math.ceil(totalChars / 4)`. Not billing-accurate, just for dry-run logging. Good enough to validate the pipeline reports a number.
7. **Structured logging** — all log lines prefixed with `[worker]`. Key-value format for parseable output. No logging framework in v1 (console.log is fine for Docker logs).

### Risks

1. **simple-git clone of public repos without auth** — should work for public repos (octocat/Hello-World). Private repos need GitHub token in clone URL. v1 tests only public repos. Step 3 verifies this with a real clone.
2. **Clone cleanup on process kill** — `finally` block handles normal errors but not SIGKILL. Orphan dirs accumulate. Mitigation: worker startup cleans stale dirs in `/tmp/clones/` older than 1 hour.
3. **Large repo clone in tests** — cloning real repos in unit tests is slow and network-dependent. Use mock simple-git for unit tests. One integration test with a tiny public repo (or local bare git repo) for end-to-end.

## Implementation Plan

1. - [ ] **Test (RED):** Write `packages/worker/tests/git/clone.test.ts` — test `cloneRepo("octocat/Hello-World", "main", "/tmp/test-clone")`: mock simple-git, verify called with `--depth=1 --branch=main`. Test error case: mock clone rejection → returns AppError with `code: "NOT_FOUND"`. Command: `pnpm test -- packages/worker/tests/git/clone.test.ts` — expected: FAIL.
2. - [ ] **Implement (GREEN):** Create `packages/worker/src/git/clone.ts` with `cloneRepo()`. Uses simple-git. Returns `CloneResult { dir: string, sizeBytes: number }`. Wraps errors in AppError. Command: same test — expected: PASS.
3. - [ ] **Smoke test real clone:** Temporarily add integration test that clones `octocat/Hello-World` (depth=1) to verify simple-git + git binary work. Run locally: `pnpm test -- packages/worker/tests/git/clone.integration.test.ts` — expected: PASS, clone dir exists, then cleaned up. Mark test with `describe.skipIf(process.env.CI)` for now.
4. - [ ] Commit: `feat: add git clone module for worker`
5. - [ ] **Test (RED):** Write `packages/worker/tests/git/files.test.ts` — test `readChangedFiles(repoDir, ["src/a.ts", "src/b.ts", "migrations/001.cs"], config)` with skip `["**/migrations/**"]`: returns 2 FileContent objects (a.ts, b.ts), logs `Skipped 1 files by pattern`. Test with empty skip patterns: returns all 3. Command: `pnpm test -- packages/worker/tests/git/files.test.ts` — expected: FAIL.
6. - [ ] **Implement (GREEN):** Create `packages/worker/src/git/files.ts` with `readChangedFiles()`. Uses `picomatch` for skip matching. Reads file content via `fs.readFile`. Returns `FileContent { path: string, content: string, sizeBytes: number }`. Command: same test — expected: PASS.
7. - [ ] Commit: `feat: add file reader with skip pattern support`
8. - [ ] **Test (RED):** Write `packages/worker/tests/analyzer/dry-run.test.ts` — test `dryRunAnalysis(context)` returns `DryRunResult` with `tokenEstimate`, `model`, `fileCount`. Verify token estimate = `Math.ceil(totalChars / 4)`. Command: `pnpm test -- packages/worker/tests/analyzer/dry-run.test.ts` — expected: FAIL.
9. - [ ] **Implement (GREEN):** Create `packages/worker/src/analyzer/dry-run.ts` — computes token estimate, returns structured result. Logs dry-run lines. Command: same test — expected: PASS.
10. - [ ] Commit: `feat: add dry-run analyzer`
11. - [ ] **Test (RED):** Write `packages/worker/tests/pipeline.test.ts` — test `runPipeline(mockJob, DEFAULT_CONFIG)`: mock clone, mock file read, verify pipeline returns `PipelineResult` with status `completed`, dryRun `true`. Test error case: clone fails → pipeline returns status `failed` with error, cleanup still called. Command: `pnpm test -- packages/worker/tests/pipeline.test.ts` — expected: FAIL.
12. - [ ] **Implement (GREEN):** Create `packages/worker/src/pipeline.ts` — orchestrates clone → config → files → analyze → cleanup in try/finally. Create `packages/worker/src/consumer.ts` — BullMQ Worker wrapping pipeline. Rewrite `packages/worker/src/index.ts` to start consumer. Command: same test — expected: PASS.
13. - [ ] Commit: `feat: add review pipeline and BullMQ consumer`
14. - [ ] **Docker integration test:** `docker compose up -d --build`, then `curl -X POST localhost:3000/review -H 'Content-Type: application/json' -d '{"repo":"octocat/Hello-World","prNumber":1,"headRef":"master","baseRef":"master","sender":"test"}'`. Check worker logs: `docker compose logs worker --tail 20` — expected: full dry-run output (clone → config → files → DRY RUN → cleanup → completed).
15. - [ ] Verify cleanup: `docker compose exec worker ls /tmp/clones/` — expected: empty (clone dir removed).
16. - [ ] Verify status: `curl localhost:3000/status/review-octocat-Hello-World-1` — expected: `{ "status": "completed" }`.
17. - [ ] **Error case:** `curl -X POST localhost:3000/review -H 'Content-Type: application/json' -d '{"repo":"nonexistent/repo-xyz-404","prNumber":1,"headRef":"main","baseRef":"main","sender":"test"}'`. Worker logs: clone failure. Status: `{ "status": "failed" }`. No orphan clone dir.
18. - [ ] Commit: `feat: complete v1 dry-run review pipeline`
19. - [ ] Run full suite: `pnpm test && pnpm lint` — expected: all green, 80%+ coverage.

## How to Test

- **Automated**: `pnpm test -- packages/worker/` — all tests pass:
  - `cloneRepo calls simple-git with --depth=1`
  - `cloneRepo wraps git errors in AppError NOT_FOUND`
  - `readChangedFiles filters by skip patterns`
  - `readChangedFiles returns all files when no skip patterns`
  - `readChangedFiles logs skipped file count`
  - `dryRunAnalysis estimates tokens as ceil(chars/4)`
  - `dryRunAnalysis returns model from config`
  - `runPipeline completes with dry-run result`
  - `runPipeline cleans up clone dir on success`
  - `runPipeline cleans up clone dir on failure`
  - `runPipeline returns failed status on clone error`
- **Manual verification**:
  1. `docker compose up -d --build`
  2. `curl -X POST localhost:3000/review -H 'Content-Type: application/json' -d '{"repo":"octocat/Hello-World","prNumber":1,"headRef":"master","baseRef":"master","sender":"test"}'`
  3. `docker compose logs worker --tail 30` — see full pipeline: clone → config → files → DRY RUN → cleanup → completed
  4. `curl localhost:3000/status/review-octocat-Hello-World-1` — `{ "status": "completed" }`
  5. `docker compose exec worker ls /tmp/clones/` — empty
- **Negative check**: POST review for `nonexistent/repo-xyz-404` → worker logs show clone failure, status returns `failed`, `/tmp/clones/` is empty (cleanup ran despite error).
- **Done means**: `docker compose up -d --build && curl POST /review (public repo) → worker logs show complete dry-run pipeline → GET /status returns completed → clone dir cleaned up`.
