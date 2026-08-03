---
id: v2-github-integration
title: "v2: GitHub Integration"
status: draft
created: "2026-08-03"
---

# v2: GitHub Integration

> GitHub plumbing — webhook-free, manual trigger via `POST /review`. Dispatcher spawns K8s Jobs that clone with auth, fetch real diffs, and post placeholder PR comments. Worker + BullMQ removed. K8s Job IS the executor.

## Problem

v1 proved the pipeline skeleton works: dispatcher receives a review request, enqueues in BullMQ, worker clones a repo and logs a dry-run summary. But the pipeline has three critical gaps before it can be used for real reviews:

1. **No GitHub auth** — `cloneRepo` clones public repos only (no token). Private repos fail.
2. **No real diff** — `ReviewContext` has a `diff` field, nothing generates it. The dry-run treats all files in the repo as "changed."
3. **No PR feedback** — results are logged to stdout, not posted as PR comments.

Additionally, v1's BullMQ + worker architecture adds complexity without value in a K8s world. The K8s Job is already the executor — no need for a separate queue-backed worker process.

## Solution (v2 scope)

Replace BullMQ + worker with direct K8s Job orchestration from the dispatcher. The Job container (`packages/reviewer`) clones the repo with `GITHUB_TOKEN`, generates a real diff, fetches PR changed files from the GitHub API, and posts a placeholder comment. No LLM calls — the review output is still a dry-run log.

```
curl POST /review (manual, with GITHUB_TOKEN)
    │
    ▼
┌──────────────────────────────────┐
│  Dispatcher (Express)            │
│  POST /review                    │
│  GET  /health                    │
│  GET  /status/:jobId             │
│  ─────────────────────────────── │
│  Zod validation                  │
│  Build K8s Job manifest          │
│  Submit Job via K8s API          │
│  Return 202 { jobId, status }    │
└──────────┬───────────────────────┘
           │ kubectl apply -f (or K8s client)
           ▼
┌──────────────────────────────────────────┐
│  K8s Job (review-{owner}-{repo}-{pr})    │
│  ─────────────────────────────────────── │
│  1. Clone repo (--depth=1,              │
│     auth via GITHUB_TOKEN)               │
│  2. Generate diff (baseRef...headRef)     │
│  3. Fetch PR changed files (GitHub API)   │
│  4. Read .reviewer.yml (if exists)        │
│  5. DRY RUN — log what WOULD happen      │
│  6. Post PR comment: "Review queued..."   │
│     (placeholder — v3 posts real)         │
│  7. Cleanup clone dir                    │
│  ─────────────────────────────────────── │
│  TTL: 10min idle → auto-delete           │
│  RestartPolicy: Never                    │
│  BackoffLimit: 2                         │
│  Status: Redis (queued→running→done/fail)│
└──────────────────────────────────────────┘
```

## Implementation Cards

| Card | Story | Scope |
|---|---|---|
| KIT-005 | US-005 | K8s infrastructure (minikube, manifests, docker registry) |
| KIT-006 | US-006 | Dispatcher: replace BullMQ with K8s Job creation |
| KIT-007 | US-007 | Reviewer package: clone with auth, real diff, PR files |
| KIT-008 | US-008 | GitHub API: PR comment posting (placeholder) |
| KIT-009 | US-009 | End-to-end: POST /review → K8s Job → PR comment |

## Architecture Decisions

### Worker removal

**Decision:** Remove `packages/worker/` and BullMQ entirely. The K8s Job IS the executor — the dispatcher creates Jobs directly.

**Rationale:**
- BullMQ worker only did `dequeue → create K8s Job → wait`. Zero value-add over direct submission.
- One less container to maintain, one less package, fewer dependencies.
- K8s Job handles retry (`backoffLimit`), timeout (`activeDeadlineSeconds`), and cleanup (`ttlSecondsAfterFinished`).
- If K8s API is down, dispatcher returns 503 — user retries.

**Rejected:** keeping BullMQ as buffer. K8s is the buffer (pending Jobs in the cluster). Adding a queue layer between the dispatcher and K8s just duplicates what K8s already does.

### Manual trigger only (no webhook in v2)

**Decision:** No `POST /webhook/github`, no GitHub App installation flow, no webhook signature validation in v2.

**Rationale:**
- Faster deliverable — webhook + install flow is a whole feature on its own.
- `POST /review` works for testing and CI-based triggers (GitHub Actions can call it).
- Webhook + GitHub App auth lands in v4 (or a separate epic).

### K8s Job per review

**Decision:** One K8s Job per review request. No long-running reviewer pods, no worker pool.

**Rationale:**
- Complete isolation — each review gets its own container, filesystem, credentials.
- Credentials injected as env vars from K8s Secret — one Job never sees another's token.
- Natural cleanup — container exits, pod is cleaned up (TTL 10min).
- `backoffLimit: 2` handles transient failures (clone timeout, API flake).

### GitHub token via K8s Secret

**Decision:** `GITHUB_TOKEN` stored in a K8s Secret, referenced as `valueFrom.secretKeyRef` in Job manifests. Dispatcher shares the same secret for its own GitHub API calls.

**Rationale:**
- Single source of truth — one Secret, consumed by both dispatcher and Jobs.
- No token in logs, no token in Job env values (referenced, not inlined).
- v2 MVP uses one token. Multi-token per repo/client is future work.

## Types (shared package)

```typescript
// GitHubReviewJob — payload for POST /review (v2)
interface GitHubReviewJob {
  readonly repo: string;          // "owner/repo"
  readonly prNumber: number;
  readonly headRef: string;
  readonly baseRef: string;
  readonly sender: string;
}

// PullRequestFile — mirror of GitHub API response
interface PullRequestFile {
  readonly filename: string;
  readonly status: "added" | "modified" | "removed" | "renamed";
  readonly patch?: string;        // unified diff
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly blobUrl: string;
  readonly rawUrl: string;
}

// ReviewJobStatus — written to Redis by the Job
interface ReviewJobStatus {
  readonly jobId: string;
  readonly status: "queued" | "running" | "completed" | "failed";
  readonly k8sJobName: string;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly error?: AppError;
}
```

## Config

### Environment variables (Dispatcher)

```bash
GITHUB_TOKEN=ghp_...             # personal access token (v2 MVP)
REDIS_URL=redis://redis:6379
PORT=3001
K8S_NAMESPACE=kitten             # default: "kitten"
```

### Environment variables (K8s Job — injected by dispatcher)

```bash
GITHUB_TOKEN=ghp_...             # from K8s Secret
REDIS_URL=redis://redis:6379
REVIEW_REPO=octocat/Hello-World  # from POST body
REVIEW_PR_NUMBER=1               # from POST body
REVIEW_HEAD_REF=feature/x        # from POST body
REVIEW_BASE_REF=main             # from POST body
```

### K8s Job template

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: review-{owner}-{repo}-{pr}
  namespace: kitten
  labels:
    app: kitten-reviewer
spec:
  ttlSecondsAfterFinished: 600   # 10 min
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: reviewer
          image: kitten-reviewer:latest
          imagePullPolicy: IfNotPresent
          env:
            - name: GITHUB_TOKEN
              valueFrom:
                secretKeyRef:
                  name: kitten-github-token
                  key: token
            - name: REDIS_URL
              value: "redis://redis.kitten.svc.cluster.local:6379"
            - name: REVIEW_REPO
              value: "..."     # filled by dispatcher
            - name: REVIEW_PR_NUMBER
              value: "..."     # filled by dispatcher
            - name: REVIEW_HEAD_REF
              value: "..."     # filled by dispatcher
            - name: REVIEW_BASE_REF
              value: "..."     # filled by dispatcher
```

## Project Structure

```
kitten/
├── packages/
│   ├── shared/                    # (kept, expanded)
│   │   └── src/types/
│   │       ├── review-job.ts      # + GitHubReviewJob, PullRequestFile, ReviewJobStatus
│   │       ├── reviewer-config.ts # (unchanged)
│   │       ├── errors.ts          # (unchanged)
│   │       └── index.ts
│   ├── dispatcher/                # (kept, rewritten)
│   │   ├── src/
│   │   │   ├── server.ts          # Express (no BullMQ)
│   │   │   ├── routes/
│   │   │   │   ├── review.ts      # POST /review → K8s Job
│   │   │   │   ├── status.ts      # GET /status/:jobId → Redis
│   │   │   │   └── health.ts      # GET /health
│   │   │   ├── k8s/              # NEW
│   │   │   │   ├── client.ts      # K8s API client (create/delete/list Jobs)
│   │   │   │   ├── manifest.ts    # buildJobManifest(job) → K8s manifest
│   │   │   │   └── index.ts
│   │   │   ├── github/           # NEW
│   │   │   │   ├── client.ts      # octokit wrapper (auth, REST calls)
│   │   │   │   └── index.ts
│   │   │   └── middleware/
│   │   │       ├── validation.ts  # Zod (kept)
│   │   │       └── error-handler.ts
│   │   ├── tests/
│   │   │   ├── routes/
│   │   │   │   └── review.test.ts
│   │   │   ├── k8s/
│   │   │   │   └── manifest.test.ts
│   │   │   └── middleware/
│   │   │       └── validation.test.ts
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── reviewer/                  # NEW — code that runs INSIDE the K8s Job
│   │   ├── src/
│   │   │   ├── index.ts           # entrypoint: read envs, run pipeline, report status
│   │   │   ├── pipeline.ts        # clone → diff → files → analyze → comment → cleanup
│   │   │   ├── git/
│   │   │   │   ├── clone.ts       # clone with GITHUB_TOKEN (auth)
│   │   │   │   ├── diff.ts        # git diff baseRef...headRef
│   │   │   │   ├── files.ts       # fetch PR files (GitHub API) + skip patterns
│   │   │   │   └── index.ts
│   │   │   ├── analyzer/
│   │   │   │   ├── dry-run.ts     # (migrated from worker v1)
│   │   │   │   └── index.ts
│   │   │   ├── github/
│   │   │   │   ├── comment.ts     # post PR comment (placeholder → real in v3)
│   │   │   │   ├── pr.ts          # fetch PR metadata + files
│   │   │   │   └── index.ts
│   │   │   ├── redis/
│   │   │   │   └── status.ts      # report progress (queued→running→completed/failed)
│   │   │   └── types.ts           # internal types
│   │   ├── tests/
│   │   │   ├── pipeline.test.ts
│   │   │   ├── git/
│   │   │   │   ├── clone.test.ts
│   │   │   │   ├── diff.test.ts
│   │   │   │   └── files.test.ts
│   │   │   ├── analyzer/
│   │   │   │   └── dry-run.test.ts
│   │   │   └── github/
│   │   │       └── comment.test.ts
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── worker/                    # REMOVED — replaced by reviewer + K8s Job
├── k8s/                           # NEW — K8s manifests for minikube
│   ├── namespace.yaml
│   ├── dispatcher-deployment.yaml
│   ├── dispatcher-service.yaml
│   ├── redis-deployment.yaml
│   ├── redis-service.yaml
│   ├── secret.yaml                # kitten-github-token
│   └── job-template.yaml          # base Job template
├── scripts/
│   └── minikube-setup.sh          # minikube start + apply + build images
├── docker-compose.yml             # kept for non-K8s dev (dispatcher + redis)
├── docker-compose.test.yml
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .env.example
└── README.md
```

## Dry Run Behavior (v2)

```bash
# Start minikube + deploy
$ minikube start
$ ./scripts/minikube-setup.sh
# → Builds reviewer image, applies all manifests

# Trigger a review
$ curl -X POST http://localhost:3001/review \
    -H "Content-Type: application/json" \
    -d '{"repo":"octocat/Hello-World","prNumber":1,"headRef":"main","baseRef":"master","sender":"test"}'

# Response: 202 Accepted
# { "jobId": "review-octocat-Hello-World-1", "status": "queued" }

# K8s Job logs:
# [reviewer] Cloning octocat/Hello-World (depth=1)...
# [reviewer] Clone complete: 2.3MB
# [reviewer] Generating diff (master...main)...
# [reviewer] Diff: 3 files changed, +42 -7
# [reviewer] Fetching PR #1 files from GitHub API...
# [reviewer] Files in PR: 3 (2 modified, 1 added)
# [reviewer] Files after skip patterns: 3
# [reviewer] Config: using defaults (.reviewer.yml not found)
# [reviewer] DRY RUN — would send 15k tokens to claude-sonnet-5
# [reviewer] DRY RUN — would post PR comment with findings
# [reviewer] Posted placeholder comment to PR #1
# [reviewer] Cleanup: removed clone dir
# [reviewer] Job completed in 5.1s

$ curl localhost:3001/status/review-octocat-Hello-World-1
# { "id": "review-octocat-Hello-World-1", "status": "completed", "duration": 5100 }
```

## Error Handling

| Error | Response / Behavior |
|---|---|
| Invalid payload | 400 `{ code: "VALIDATION", message: "...", details: [...] }` |
| K8s API unavailable | 503 `{ code: "SERVICE_UNAVAILABLE", message: "Cannot create review job" }` |
| GITHUB_TOKEN missing/expired | Job fails, status: `failed`, error: `NOT_FOUND` |
| Clone fails (repo not found / no access) | Job fails, status: `failed`, error: `NOT_FOUND` |
| PR not found | Job fails, status: `failed`, error: `NOT_FOUND` |
| Redis unavailable | Dispatcher returns 503 |
| Job timeout (10 min) | K8s kills pod, status: `failed`, error: `TIMEOUT` |
| Backoff exhausted (3 attempts) | Status stays `failed`, no more retries |

Structured errors everywhere: `{ code, message, details }`.

## Testing Strategy

| Level | What | Tool |
|---|---|---|
| Unit | Manifest builder, validation, GitHub client (mocked), pipeline steps | vitest |
| Integration | Dispatcher → K8s Job (minikube), Redis status reporting | vitest + minikube |
| Smoke | `scripts/minikube-setup.sh` + `curl POST /review` + verify PR comment | Manual / CI script |

Coverage target: 80%+ on shared + dispatcher + reviewer.

**K8s in tests:** Unit tests mock `@kubernetes/client-node`. Integration tests run against minikube (same setup as local dev). `docker-compose.yml` provides a K8s-free fallback for quick iteration (dispatcher + redis only, no Jobs).

## What is NOT in v2 (out-of-scope)

- LLM API calls (Claude, Anthropic SDK)
- MCP agentic review (Semble, filesystem tools)
- `.reviewer-mcp.json` configuration
- GitHub webhook (`POST /webhook/github`)
- GitHub App installation flow
- Webhook signature validation (HMAC)
- GitHub App auth (installation tokens)
- `ReviewResult` with real `Finding[]`
- `.reviewer.yml` `rules[]` pattern matching
- Stale clone dir cleanup on worker startup (no worker anymore)
- Multi-token per repo/client
- Dashboard / UI
- Helth check on the reviewer Job (runs once, exits)

## Future phases (reference only)

| Phase | Scope |
|---|---|
| v3 — LLM Integration | Claude adapter impl, prompt builder, structured output, real PR comment with findings |
| v4 — MCP Agentic Review | Semble MCP + filesystem tools inside Job container. `.reviewer-mcp.json` config per repo |
| v5 — GitHub App | Webhook, installation flow, GitHub App auth, re-review trigger |
| v6 — Deep Context | git log history, pattern comparison, learning from past reviews |
| v7 — Production | Helm chart, monitoring, cost tracking, multi-repo |
