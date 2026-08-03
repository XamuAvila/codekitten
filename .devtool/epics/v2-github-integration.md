---
id: v2-github-integration
title: "v2: GitHub Integration"
status: draft
created: "2026-08-03"
---

# v2: GitHub Integration

> GitHub plumbing with Agent Pod model. Dispatcher spawns a K8s Pod per review that clones with auth, fetches real diffs, posts placeholder PR comments, and stays alive for follow-up messages via Redis pub/sub. Worker + BullMQ removed. The Pod IS the agent.

## Problem

v1 proved the pipeline skeleton works: dispatcher receives a review request, enqueues in BullMQ, worker clones a repo and logs a dry-run summary. But the pipeline has four critical gaps before it can be used for real reviews:

1. **No GitHub auth** — `cloneRepo` clones public repos only (no token). Private repos fail.
2. **No real diff** — `ReviewContext` has a `diff` field, nothing generates it. The dry-run treats all files in the repo as "changed."
3. **No PR feedback** — results are logged to stdout, not posted as PR comments.
4. **No follow-up** — each review is fire-and-forget. No way to ask the reviewer to clarify, re-check, or explain a finding after the initial review.

Additionally, v1's BullMQ + worker architecture adds complexity without value in a K8s world. The executor should be the Pod itself.

## Solution (v2 scope)

Replace BullMQ + worker with an **Agent Pod** model. The dispatcher creates a K8s Pod (not a Job) per review request. The Pod:

1. Runs the initial review pipeline (clone → diff → files → dry-run → comment)
2. **Stays alive** and subscribes to a Redis pub/sub channel for follow-up messages
3. Processes follow-ups (dispatcher routes them to the correct Pod via Redis)
4. Dies after 10 minutes of inactivity (idle timeout)

No LLM calls in v2 — the review output is still a dry-run log, and follow-up responses are acknowledgments. The architecture is ready for LLM in v3.

```
1. POST /review {repo, prNumber, headRef, baseRef}
       │
       ▼
2. Dispatcher:
   - Validates payload (Zod)
   - Creates K8s Pod (reviewer container, envs injected)
   - Creates Redis channel: review:{jobId}:messages
   - Stores status in Redis: { status: "queued" }
   - Returns 202 { jobId, status: "queued" }
       │
       ▼
3. Pod starts:
   - Reports status: "running"
   - Clones repo (auth via GITHUB_TOKEN)
   - Generates diff (baseRef...headRef)
   - Fetches PR changed files (GitHub API)
   - Reads .reviewer.yml (if exists)
   - Runs dry-run analysis
   - Posts placeholder comment on PR
   - Reports status: "reviewing" (idle, waiting for follow-ups)
   - Subscribes to Redis channel: review:{jobId}:messages
   - Starts idle timer (10 min)
       │
       ▼
4. Follow-up (optional, repeatable):
   - POST /review/:jobId/message { message: "explain finding X" }
   - Dispatcher publishes to Redis channel
   - Pod receives message, resets idle timer
   - Pod processes (v2: echo/ack; v3+: LLM response)
   - Pod posts response as PR comment
       │
       ▼
5. Idle timeout (10 min no messages):
   - Pod reports status: "completed"
   - Pod exits cleanly (clone dir cleaned up by container death)
   - K8s garbage-collects the Pod
```

## Implementation Cards

| Card | Story | Scope |
|---|---|---|
| KIT-005 | US-005 | K8s infrastructure: minikube setup, namespace, Redis + dispatcher manifests, image build |
| KIT-006 | US-006 | Dispatcher: replace BullMQ with K8s Pod creation, add POST /review/:jobId/message |
| KIT-007 | US-007 | Reviewer package: clone with auth, real diff, PR files fetch, dry-run |
| KIT-008 | US-008 | Agent lifecycle: Redis pub/sub, follow-up message handling, idle timeout, status reporting |
| KIT-009 | US-009 | GitHub API: PR comment posting (placeholder review + follow-up ack) |
| KIT-010 | US-010 | End-to-end: POST /review → Pod runs → comment posted → follow-up → idle → Pod dies |

## Architecture Decisions

### Agent Pod (not K8s Job)

**Decision:** Use a bare K8s Pod (not a Job) per review. The Pod stays alive after the initial review to handle follow-up messages.

**Rationale:**
- K8s Job is batch — runs once and exits. No way to receive follow-ups.
- A persistent Pod with Redis pub/sub subscription enables interactive review: user asks "@reviewer explain X" → dispatcher routes to Pod → Pod responds.
- Clone persists while Pod is alive — follow-ups can re-read files without re-cloning.
- Idle timeout (10 min) ensures Pods don't linger forever.
- Pod death = automatic cleanup (filesystem, network, memory).

**Rejected:** K8s Job (one-shot, no follow-up capability). Also rejected: long-running worker pool (shared state, no isolation).

### Worker + BullMQ removal

**Decision:** Remove `packages/worker/` and BullMQ entirely.

**Rationale:**
- BullMQ worker only did `dequeue → spawn executor → wait`. Zero value-add when the dispatcher can create Pods directly.
- One less container, one less package, fewer dependencies.
- If K8s API is down, dispatcher returns 503 — user retries.

**Rejected:** Keeping BullMQ as buffer. K8s handles pending Pods natively.

### Redis pub/sub for follow-up messages

**Decision:** Follow-up messages flow through Redis pub/sub channels. One channel per review: `review:{jobId}:messages`.

**Rationale:**
- Redis already in the stack (status storage). No new infra.
- Pub/sub is fire-and-forget — if Pod is dead, message is lost (correct behavior: Pod is gone, follow-up fails gracefully).
- Dispatcher doesn't need to know Pod IP/port — just publishes to the channel.
- Pod subscribes on startup, unsubscribes on shutdown.

**Rejected:** HTTP endpoint inside the Pod (requires service discovery, port management). Also rejected: polling Redis key (wasteful, latency).

### Manual trigger + follow-up endpoint (no webhook in v2)

**Decision:** Two endpoints for interaction:
- `POST /review` — trigger a new review (creates Pod)
- `POST /review/:jobId/message` — send follow-up to an active Pod

No `POST /webhook/github` in v2. GitHub webhook for PR comments (automatic follow-up via "@reviewer") lands in a future phase.

**Rationale:**
- Faster deliverable — webhook + signature validation is its own feature.
- `POST /review/:jobId/message` proves the pub/sub + agent lifecycle without webhook complexity.
- Future webhook handler just translates PR comment events into calls to `/review/:jobId/message`.

### GitHub token via K8s Secret

**Decision:** `GITHUB_TOKEN` stored in a K8s Secret (`kitten-github-token`), referenced as `valueFrom.secretKeyRef` in Pod manifests.

**Rationale:**
- Single source of truth — one Secret, consumed by both dispatcher and Pods.
- No token in logs, no token in Pod env values (referenced, not inlined).
- v2 uses one token (personal access token). Multi-token per repo/client is future work.

## Types (shared package)

```typescript
// ReviewRequest — payload for POST /review (v2)
interface ReviewRequest {
  readonly repo: string;          // "owner/repo"
  readonly prNumber: number;
  readonly headRef: string;
  readonly baseRef: string;
  readonly sender: string;
}

// FollowUpMessage — payload for POST /review/:jobId/message
interface FollowUpMessage {
  readonly message: string;       // free-text follow-up
  readonly sender: string;        // who sent it
}

// PubSubMessage — internal, published to Redis channel
interface PubSubMessage {
  readonly type: "follow_up" | "shutdown";
  readonly payload: FollowUpMessage | Record<string, never>;
  readonly timestamp: string;     // ISO 8601
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

// ReviewJobStatus — written to Redis by the Pod
interface ReviewJobStatus {
  readonly jobId: string;
  readonly status: "queued" | "running" | "reviewing" | "completed" | "failed";
  readonly podName: string;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly followUpCount: number; // how many follow-ups received
  readonly error?: AppError;
}
```

Status transitions:
```
queued → running → reviewing → completed
                 ↘ failed
         running → failed (clone/diff/API error)
       reviewing → completed (idle timeout or explicit shutdown)
```

- `queued`: Pod created, not yet started
- `running`: Pod executing initial review pipeline
- `reviewing`: Initial review done, Pod alive waiting for follow-ups
- `completed`: Idle timeout reached or explicit shutdown
- `failed`: Unrecoverable error during pipeline

## Config

### Environment variables (Dispatcher)

```bash
GITHUB_TOKEN=ghp_...             # personal access token (v2 MVP)
REDIS_URL=redis://redis:6379
PORT=3001
K8S_NAMESPACE=kitten             # default: "kitten"
REVIEWER_IMAGE=kitten-reviewer:latest
POD_IDLE_TIMEOUT_MS=600000       # 10 min, default
```

### Environment variables (K8s Pod — injected by dispatcher)

```bash
# Credentials (from K8s Secret)
GITHUB_TOKEN=ghp_...             # from secretKeyRef
REDIS_URL=redis://redis:6379

# Job metadata (from POST body, dynamic per Pod)
REVIEW_JOB_ID=review-octocat-Hello-World-1
REVIEW_REPO=octocat/Hello-World
REVIEW_PR_NUMBER=1
REVIEW_HEAD_REF=feature/x
REVIEW_BASE_REF=main
REVIEW_SENDER=test

# Pod config
POD_IDLE_TIMEOUT_MS=600000       # 10 min
```

### K8s Pod manifest (generated by dispatcher)

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: review-octocat-hello-world-1
  namespace: kitten
  labels:
    app: kitten-reviewer
    review-job-id: review-octocat-Hello-World-1
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
        - name: REVIEW_JOB_ID
          value: "review-octocat-Hello-World-1"
        - name: REVIEW_REPO
          value: "octocat/Hello-World"
        - name: REVIEW_PR_NUMBER
          value: "1"
        - name: REVIEW_HEAD_REF
          value: "feature/x"
        - name: REVIEW_BASE_REF
          value: "main"
        - name: REVIEW_SENDER
          value: "test"
        - name: POD_IDLE_TIMEOUT_MS
          value: "600000"
      resources:
        requests:
          memory: "128Mi"
          cpu: "100m"
        limits:
          memory: "512Mi"
          cpu: "500m"
```

## Project Structure

```
kitten/
├── packages/
│   ├── shared/                    # (kept, expanded)
│   │   └── src/
│   │       ├── types/
│   │       │   ├── review-job.ts  # + ReviewRequest, FollowUpMessage, PullRequestFile
│   │       │   ├── review-status.ts # NEW — ReviewJobStatus, PubSubMessage
│   │       │   ├── reviewer-config.ts # (unchanged)
│   │       │   ├── errors.ts      # (unchanged)
│   │       │   └── index.ts
│   │       ├── config/            # (unchanged)
│   │       ├── llm/               # (unchanged — interface only)
│   │       └── index.ts
│   ├── dispatcher/                # (kept, rewritten)
│   │   ├── src/
│   │   │   ├── server.ts          # Express (no BullMQ)
│   │   │   ├── index.ts           # entrypoint
│   │   │   ├── routes/
│   │   │   │   ├── review.ts      # POST /review → create Pod
│   │   │   │   ├── message.ts     # NEW — POST /review/:jobId/message → Redis pub/sub
│   │   │   │   ├── status.ts      # GET /status/:jobId → Redis
│   │   │   │   └── health.ts      # GET /health
│   │   │   ├── k8s/               # NEW
│   │   │   │   ├── client.ts      # K8s API client (create/delete/get Pods)
│   │   │   │   ├── manifest.ts    # buildPodManifest(request) → Pod spec
│   │   │   │   └── index.ts
│   │   │   └── middleware/
│   │   │       ├── validation.ts  # Zod (kept)
│   │   │       └── error-handler.ts
│   │   ├── tests/
│   │   │   ├── routes/
│   │   │   │   ├── review.test.ts
│   │   │   │   └── message.test.ts
│   │   │   ├── k8s/
│   │   │   │   └── manifest.test.ts
│   │   │   └── middleware/
│   │   │       └── validation.test.ts
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── reviewer/                  # NEW — code that runs INSIDE the K8s Pod
│   │   ├── src/
│   │   │   ├── index.ts           # entrypoint: read envs → pipeline → subscribe → idle loop
│   │   │   ├── pipeline.ts        # clone → diff → files → analyze → comment
│   │   │   ├── agent.ts           # NEW — agent lifecycle: subscribe, handle messages, idle timer
│   │   │   ├── git/
│   │   │   │   ├── clone.ts       # clone with GITHUB_TOKEN (auth)
│   │   │   │   ├── diff.ts        # NEW — git diff baseRef...headRef
│   │   │   │   ├── files.ts       # fetch PR files (GitHub API) + skip patterns
│   │   │   │   └── index.ts
│   │   │   ├── analyzer/
│   │   │   │   ├── dry-run.ts     # (migrated from worker v1)
│   │   │   │   └── index.ts
│   │   │   ├── github/
│   │   │   │   ├── comment.ts     # post PR comment (placeholder review + follow-up ack)
│   │   │   │   ├── pr.ts          # fetch PR metadata + files
│   │   │   │   └── index.ts
│   │   │   ├── redis/
│   │   │   │   ├── status.ts      # report progress (queued→running→reviewing→completed)
│   │   │   │   └── pubsub.ts      # NEW — subscribe to channel, parse messages
│   │   │   └── types.ts           # internal types
│   │   ├── tests/
│   │   │   ├── pipeline.test.ts
│   │   │   ├── agent.test.ts      # NEW — idle timer, message handling, shutdown
│   │   │   ├── git/
│   │   │   │   ├── clone.test.ts
│   │   │   │   ├── diff.test.ts
│   │   │   │   └── files.test.ts
│   │   │   ├── analyzer/
│   │   │   │   └── dry-run.test.ts
│   │   │   ├── github/
│   │   │   │   └── comment.test.ts
│   │   │   └── redis/
│   │   │       └── pubsub.test.ts # NEW
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── worker/                    # REMOVED — replaced by reviewer + K8s Pod
├── k8s/                           # NEW — K8s manifests for minikube
│   ├── namespace.yaml
│   ├── dispatcher-deployment.yaml
│   ├── dispatcher-service.yaml
│   ├── redis-deployment.yaml
│   ├── redis-service.yaml
│   └── secret.yaml                # kitten-github-token (template, real value not committed)
├── scripts/
│   └── minikube-setup.sh          # minikube start + namespace + apply manifests + build images
├── docker-compose.yml             # kept for non-K8s dev (dispatcher + redis only)
├── docker-compose.test.yml
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .env.example
└── README.md
```

## Agent Lifecycle (reviewer/src/agent.ts)

```typescript
// Pseudocode — actual implementation in TDD

async function startAgent(config: AgentConfig): Promise<void> {
  const redis = createRedisClient(config.redisUrl);
  const subscriber = redis.duplicate();
  const channel = `review:${config.jobId}:messages`;

  let idleTimer = createIdleTimer(config.idleTimeoutMs, async () => {
    await reportStatus(redis, config.jobId, "completed");
    await subscriber.unsubscribe(channel);
    await redis.quit();
    await subscriber.quit();
    process.exit(0);
  });

  // Subscribe to follow-up messages
  await subscriber.subscribe(channel, async (rawMessage: string) => {
    const message: PubSubMessage = JSON.parse(rawMessage);

    if (message.type === "shutdown") {
      idleTimer.cancel();
      await reportStatus(redis, config.jobId, "completed");
      process.exit(0);
    }

    if (message.type === "follow_up") {
      idleTimer.reset();
      // v2: acknowledge only. v3+: process with LLM.
      await postFollowUpAck(config, message.payload);
      await incrementFollowUpCount(redis, config.jobId);
    }
  });

  // Start idle timer
  idleTimer.start();
}
```

## Dry Run Behavior (v2)

```bash
# Start minikube + deploy
$ minikube start
$ ./scripts/minikube-setup.sh
# → Builds reviewer image, applies namespace + redis + dispatcher manifests

# Trigger a review
$ curl -X POST http://localhost:3001/review \
    -H "Content-Type: application/json" \
    -d '{"repo":"XamuAvila/kitten-test-repo","prNumber":1,"headRef":"test/add-feature","baseRef":"master","sender":"test"}'

# Response: 202 Accepted
# { "jobId": "review-XamuAvila-kitten-test-repo-1", "status": "queued" }

# Pod logs (kubectl logs review-xamuavila-kitten-test-repo-1 -n kitten):
# [reviewer] Starting review: review-XamuAvila-kitten-test-repo-1
# [reviewer] Cloning XamuAvila/kitten-test-repo (depth=1, branch=test/add-feature)...
# [reviewer] Clone complete: 48KB
# [reviewer] Generating diff (master...test/add-feature)...
# [reviewer] Diff: 3 files changed, +31 -0
# [reviewer] Fetching PR #1 files from GitHub API...
# [reviewer] PR files: 3 (2 modified, 1 added)
# [reviewer] Files after skip patterns: 3 (0 skipped)
# [reviewer] Config loaded from .reviewer.yml: language=en, model=claude-sonnet-5
# [reviewer] DRY RUN — would send 8k tokens to claude-sonnet-5
# [reviewer] Posted placeholder comment to PR #1
# [reviewer] Status: reviewing (waiting for follow-ups, idle timeout: 10m)
# [reviewer] Subscribed to channel: review:review-XamuAvila-kitten-test-repo-1:messages

# Check status
$ curl localhost:3001/status/review-XamuAvila-kitten-test-repo-1
# { "jobId": "...", "status": "reviewing", "followUpCount": 0 }

# Send a follow-up message
$ curl -X POST localhost:3001/review/review-XamuAvila-kitten-test-repo-1/message \
    -H "Content-Type: application/json" \
    -d '{"message":"explain the changes in utils.ts","sender":"test"}'

# Response: 200 { "status": "sent" }

# Pod logs:
# [reviewer] Follow-up received from test: "explain the changes in utils.ts"
# [reviewer] ACK — would process with LLM in v3
# [reviewer] Posted follow-up ack comment to PR #1
# [reviewer] Idle timer reset (10m)

# Check status again
$ curl localhost:3001/status/review-XamuAvila-kitten-test-repo-1
# { "jobId": "...", "status": "reviewing", "followUpCount": 1 }

# After 10 min of inactivity:
# [reviewer] Idle timeout reached (10m). Shutting down.
# [reviewer] Status: completed
# [reviewer] Pod exiting.

$ curl localhost:3001/status/review-XamuAvila-kitten-test-repo-1
# { "jobId": "...", "status": "completed", "followUpCount": 1, "durationMs": 612000 }
```

## Error Handling

| Error | Response / Behavior |
|---|---|
| Invalid payload | 400 `{ code: "VALIDATION", message: "...", details: [...] }` |
| K8s API unavailable | 503 `{ code: "SERVICE_UNAVAILABLE", message: "..." }` |
| GITHUB_TOKEN missing/expired | Pod fails, status: `failed`, error: `AUTH_FAILED` |
| Clone fails (repo not found) | Pod fails, status: `failed`, error: `NOT_FOUND` |
| PR not found | Pod fails, status: `failed`, error: `NOT_FOUND` |
| Redis unavailable (dispatcher) | 503 |
| Redis unavailable (Pod) | Pod fails, status: `failed`, error: `REDIS_UNAVAILABLE` |
| Follow-up to non-existent/dead Pod | 404 or 410 `{ code: "NOT_FOUND", message: "Review pod not active" }` |
| Pod crash (OOM, unexpected) | Status stays `running` — dispatcher can detect via K8s API (Pod phase != Running) |

Structured errors everywhere: `{ code, message, details }`.

## Testing Strategy

| Level | Infra needed | What | Runs in CI? |
|---|---|---|---|
| Unit | Nothing | Manifest builder, validation, pipeline steps, agent lifecycle (all mocked) | ✅ Always |
| Component | Redis only | Dispatcher routes, pub/sub messaging, status read/write | ✅ Redis in container |
| Reviewer standalone | Redis + GITHUB_TOKEN | Full pipeline without K8s (run as Node process with envs) | ✅ With secret |
| Integration | minikube + Redis | POST /review → Pod created → status updated → follow-up routed | ⚠️ Slow, optional |
| E2E | minikube + Redis + token | Full flow → comment on PR → follow-up → idle shutdown | 🚫 Manual / nightly |

Coverage target: 80%+ on shared + dispatcher + reviewer.

**Test fixture:** `XamuAvila/kitten-test-repo` with permanent PR #1 (3 files changed, .reviewer.yml present). Tests use this repo. Test comments prefixed with `[KITTEN-TEST]`.

**K8s in tests:** Unit tests mock `@kubernetes/client-node`. Integration tests run against minikube. `docker-compose.yml` provides a K8s-free fallback (dispatcher + redis only).

**Agent lifecycle tests:** Unit tests for `agent.ts` mock Redis pub/sub and timers. Verify: idle timer starts after pipeline, message resets timer, shutdown message exits cleanly, timeout triggers graceful shutdown.

## What is NOT in v2 (out-of-scope)

- LLM API calls (Claude, Anthropic SDK) — follow-ups are echo/ack only
- MCP agentic review (Semble, filesystem tools)
- `.reviewer-mcp.json` configuration
- GitHub webhook (`POST /webhook/github`) — follow-ups via manual endpoint only
- GitHub App installation flow
- Webhook signature validation (HMAC)
- GitHub App auth (installation tokens)
- `ReviewResult` with real `Finding[]`
- `.reviewer.yml` `rules[]` pattern matching
- Multi-token per repo/client
- Dashboard / UI
- Pod-to-Pod communication
- Horizontal pod autoscaling

## Future phases (reference only)

| Phase | Scope |
|---|---|
| v3 — LLM Integration | Claude adapter impl, prompt builder, structured output, real PR comments with findings, LLM-powered follow-up responses |
| v4 — MCP Agentic Review | Semble MCP + filesystem tools inside Pod. `.reviewer-mcp.json` config per repo. Agent explores codebase via tool calls |
| v5 — GitHub Webhook | `POST /webhook/github`, signature validation, auto-trigger on PR open/sync, "@reviewer" comment → follow-up routing |
| v6 — GitHub App | Installation flow, per-installation auth tokens, multi-tenant |
| v7 — Deep Context | git log history, pattern comparison, learning from past reviews |
| v8 — Production | Helm chart, monitoring, cost tracking, multi-repo |
