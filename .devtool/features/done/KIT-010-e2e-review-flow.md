---
id: "KIT-010"
status: "done"
priority: "medium"
assignee: ""
epic: "v2-github-integration"
dueDate: null
created: "2026-08-03"
modified: "2026-08-03"
completedAt: "2026-08-03"
labels: ["e2e", "integration"]
order: "b5"
---

# End-to-End Review Flow

## User Story

See [US-010](../../docs/stories/US-010-e2e-review-flow.md).

## Technical Refinement

### Files

**Created:**
- `scripts/e2e-test.sh` — automated E2E test script: POST /review to dispatcher, poll `GET /status/:jobId` until `reviewing`, verify placeholder comment on GitHub PR, send follow-up via `POST /review/:jobId/message`, verify ack comment, wait for idle timeout (30s via `POD_IDLE_TIMEOUT_MS` override), poll until `completed`, verify final status fields
- `scripts/cleanup-pods.sh` — cleanup utility: deletes completed/failed Pods in `kitten` namespace older than 1 hour, cleans up orphan Redis keys matching `review:*:status` where Pod no longer exists

**Modified:**
- None — this card is purely test scripts and verification. All functional code is delivered by KIT-005 through KIT-009.

### Consumes

From KIT-005 (K8s infrastructure):
- minikube running with `kitten` namespace, Redis deployed, dispatcher deployed
- `./scripts/minikube-setup.sh` — builds images, applies manifests

From KIT-006 (dispatcher Pod orchestration):
- `POST /review` — creates Pod, returns `{ jobId, status: "queued" }`
- `POST /review/:jobId/message` — publishes follow-up to Redis channel
- `GET /status/:jobId` — reads Pod status from Redis hash
- `GET /health` — dispatcher health check

From KIT-007 (reviewer pipeline):
- Reviewer Pod clones repo, generates diff, fetches PR files, runs dry-run analysis

From KIT-008 (agent lifecycle):
- Pod subscribes to Redis pub/sub after pipeline, handles follow-ups, idle timeout triggers shutdown
- Status transitions: `queued → running → reviewing → completed`

From KIT-009 (PR comments):
- Pipeline posts placeholder review comment on PR
- Agent posts follow-up ack comment on PR

Test fixture:
- `XamuAvila/kitten-test-repo` PR #1 — permanent fixture with 3 files changed, `.reviewer.yml` present

### Produces

- Verified end-to-end flow proving all v2 components work together: dispatcher creates Pod → Pod runs pipeline → comment on PR → Pod enters agent mode → follow-up received → ack comment → idle timeout → Pod exits
- `scripts/e2e-test.sh` — repeatable E2E verification script
- `scripts/cleanup-pods.sh` — operational tooling for cleaning up after test runs

### Design decisions

1. **E2E test as shell script, not vitest** — the E2E flow requires `kubectl`, `curl`, real K8s cluster (minikube), and real GitHub API calls. A vitest test would need K8s client libraries, Octokit, and complex setup/teardown — essentially reimplementing the shell commands in TypeScript. Shell script is simpler, more transparent, and matches how ops would verify the system. Rejected: vitest with `@kubernetes/client-node` (complex setup, hard to debug, not significantly more reliable).
2. **Shortened idle timeout for E2E test (30s)** — full 10-minute timeout makes E2E test impractically slow. Dispatcher passes `POD_IDLE_TIMEOUT_MS` as env var to the Pod; E2E script overrides this to 30000 in the test `POST /review` call or via dispatcher env. 30s is long enough to send a follow-up and short enough for fast feedback. Rejected: 10-minute wait (too slow for iterative testing).
3. **Test against `XamuAvila/kitten-test-repo` PR #1** — permanent test fixture. PR stays open, has predictable content (3 files changed), includes `.reviewer.yml`. Test comments accumulate with `[KITTEN-TEST]` prefix — acceptable for a test repo, no cleanup needed. Rejected: creating/deleting a temporary PR per test run (complex, slow, API rate limit risk).
4. **Polling with timeout, not fixed sleep** — Pod startup time varies (image pull, K8s scheduling). E2E script polls `GET /status/:jobId` every 5s with a 120s timeout instead of sleeping a fixed duration. Rejected: `sleep 60` (too flaky — sometimes too short, sometimes wastefully long).
5. **Cleanup script separate from E2E test** — E2E test focuses on verification, cleanup script is operational tooling. Keeps concerns separate. Cleanup is idempotent and safe to run multiple times. Rejected: cleanup at end of E2E test (if test fails mid-run, cleanup never runs).

### Risks

1. **E2E test depends on GitHub API availability** — real API calls to GitHub. If GitHub is down or rate-limited, test fails. Mitigation: script checks `GET https://api.github.com/rate_limit` at start and warns if remaining < 100.
2. **Pod startup time varies** — image pull (first run after build) can take 30-60s. Subsequent runs use cached image (~5s). Polling with 120s timeout handles both cases. Script logs each poll attempt for debugging.
3. **Comments accumulate on test PR** — each E2E run adds 2 comments (review + follow-up ack). Over time, PR #1 gets noisy. Acceptable for test repo. If it becomes a problem, cleanup script could be extended to delete old `[KITTEN-TEST]` comments via GitHub API.
4. **minikube resource constraints** — default minikube has limited CPU/memory. If host machine is constrained, Pod scheduling may fail. Mitigation: e2e-test.sh checks minikube status before starting and warns about resource requirements.

## Implementation Plan

1. - [ ] **Write `scripts/e2e-test.sh`** — create the script with the following sections:
   - **Preamble**: set `-euo pipefail`, define colors for output, define `DISPATCHER_URL` (default `http://localhost:3001`), define `TIMEOUT=120`, define `POLL_INTERVAL=5`
   - **Pre-flight checks**: verify `kubectl` available, verify minikube running (`minikube status`), verify `kitten` namespace exists, verify dispatcher Pod is Running, verify Redis Pod is Running, check GitHub API rate limit (`curl -s https://api.github.com/rate_limit` — warn if remaining < 100)
   - **Step 1 — Health check**: `curl $DISPATCHER_URL/health` — expect `{"status":"ok","redis":"connected"}`
   - **Step 2 — Submit review**: `curl -X POST $DISPATCHER_URL/review -H "Content-Type: application/json" -d '{"repo":"XamuAvila/kitten-test-repo","prNumber":1,"headRef":"test/add-feature","baseRef":"master","sender":"e2e-test"}'` — capture `jobId` from response, verify 202 status
   - **Step 3 — Poll until running**: poll `GET /status/$jobId` every `$POLL_INTERVAL` seconds until `status` is `running` or `reviewing`, timeout after `$TIMEOUT` seconds
   - **Step 4 — Poll until reviewing**: continue polling until `status` is `reviewing` (pipeline complete, agent listening), timeout after `$TIMEOUT` seconds
   - **Step 5 — Verify Pod exists**: `kubectl get pod -n kitten -l review-job-id=$jobId` — verify Pod is Running
   - **Step 6 — Verify PR comment**: `curl -s https://api.github.com/repos/XamuAvila/kitten-test-repo/issues/1/comments` — verify latest comment contains `[KITTEN-TEST]` and `Dry Run Summary`
   - **Step 7 — Send follow-up**: `curl -X POST $DISPATCHER_URL/review/$jobId/message -H "Content-Type: application/json" -d '{"message":"explain the changes in utils.ts","sender":"e2e-test"}'` — expect 200
   - **Step 8 — Verify follow-up ack comment**: poll PR comments until one contains `Received your message: "explain the changes in utils.ts"` and `[KITTEN-TEST]`
   - **Step 9 — Verify follow-up count**: `GET /status/$jobId` — `followUpCount` should be 1
   - **Step 10 — Wait for idle timeout**: poll `GET /status/$jobId` every 5s until `status` is `completed`, timeout after 60s (idle timeout is 30s + margin)
   - **Step 11 — Verify final status**: `GET /status/$jobId` — verify `status=completed`, `completedAt` is set, `durationMs` is set, `followUpCount=1`
   - **Step 12 — Verify Pod terminated**: `kubectl get pod -n kitten -l review-job-id=$jobId` — Pod phase should be `Succeeded` or not found (garbage collected)
   - **Summary**: print PASS/FAIL for each step, overall result
   
   Command: `chmod +x scripts/e2e-test.sh && bash -n scripts/e2e-test.sh` — expected: syntax check passes.

2. - [ ] **Write `scripts/cleanup-pods.sh`** — create the script with:
   - **Preamble**: set `-euo pipefail`, define `NAMESPACE=kitten`
   - **Step 1 — Delete completed Pods**: `kubectl get pods -n $NAMESPACE -l app=kitten-reviewer --field-selector=status.phase==Succeeded -o name | xargs -r kubectl delete -n $NAMESPACE`
   - **Step 2 — Delete failed Pods**: `kubectl get pods -n $NAMESPACE -l app=kitten-reviewer --field-selector=status.phase==Failed -o name | xargs -r kubectl delete -n $NAMESPACE`
   - **Step 3 — Report**: count deleted Pods, list remaining running Pods
   - **Step 4 — Orphan Redis keys** (optional, with `--redis` flag): scan Redis for `review:*:status` keys, check if corresponding Pod exists, delete orphan keys
   
   Command: `chmod +x scripts/cleanup-pods.sh && bash -n scripts/cleanup-pods.sh` — expected: syntax check passes.

3. - [ ] Commit: `feat: add E2E test and cleanup scripts for v2 review flow`

4. - [ ] **Run full E2E flow manually** — prerequisites: minikube running, `./scripts/minikube-setup.sh` completed, `GITHUB_TOKEN` set in K8s Secret. Execute:
   - `POD_IDLE_TIMEOUT_MS=30000 ./scripts/e2e-test.sh`
   - Verify all 12 steps pass
   - Check `XamuAvila/kitten-test-repo` PR #1 for new comments
   - Run `./scripts/cleanup-pods.sh` — verify completed Pods removed

5. - [ ] Commit: `docs: document E2E test execution in README`

6. - [ ] Run unit + lint suites: `pnpm test && pnpm lint` — expected: all green (E2E script is not part of pnpm test suite).

## How to Test

- **Automated**: `./scripts/e2e-test.sh` — runs full E2E flow with output:
  - `[PASS] Health check — dispatcher healthy`
  - `[PASS] Submit review — jobId: review-XamuAvila-kitten-test-repo-1, status: queued`
  - `[PASS] Pod running — status: running (polled N times)`
  - `[PASS] Pipeline complete — status: reviewing`
  - `[PASS] Pod exists — review-xamuavila-kitten-test-repo-1 Running`
  - `[PASS] PR comment — found [KITTEN-TEST] review comment`
  - `[PASS] Follow-up sent — status: 200`
  - `[PASS] Follow-up ack comment — found ack on PR`
  - `[PASS] Follow-up count — followUpCount: 1`
  - `[PASS] Idle timeout — status: completed (waited Ns)`
  - `[PASS] Final status — completed, durationMs set, followUpCount: 1`
  - `[PASS] Pod terminated — Succeeded or not found`
  - `Result: 12/12 PASSED`
- **Manual verification**:
  1. Ensure minikube is running: `minikube status`
  2. Deploy stack: `./scripts/minikube-setup.sh`
  3. Override idle timeout: set `POD_IDLE_TIMEOUT_MS=30000` in dispatcher deployment env
  4. Run: `./scripts/e2e-test.sh`
  5. Open `https://github.com/XamuAvila/kitten-test-repo/pull/1` — see new review comment and follow-up ack comment
  6. Run: `./scripts/cleanup-pods.sh` — see completed Pods removed
  7. Verify: `kubectl get pods -n kitten -l app=kitten-reviewer` — no reviewer Pods remaining
- **Negative check**: Run E2E without `GITHUB_TOKEN` in K8s Secret → Pod fails during clone, status becomes `failed`, E2E script reports failure at "Poll until running" step with clear error message. Run E2E with minikube stopped → script fails at pre-flight checks with "minikube not running" message.
- **Done means**: `./scripts/e2e-test.sh runs → all 12 steps pass → review comment visible on GitHub PR → follow-up ack comment visible → Pod exits after idle timeout → cleanup script removes completed Pods`.
