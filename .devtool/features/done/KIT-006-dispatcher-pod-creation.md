---
id: "KIT-006"
status: "done"
priority: "high"
assignee: ""
epic: "v2-github-integration"
dueDate: null
created: "2026-08-03"
modified: "2026-08-03"
completedAt: "2026-08-03"
labels: ["dispatcher", "k8s"]
order: "b1"
---

# Dispatcher Pod Creation

## User Story

See [US-006](../../docs/stories/US-006-dispatcher-pod-orchestration.md).

## Technical Refinement

### Files

**Created:**
- `packages/dispatcher/src/k8s/client.ts` — K8s API client wrapping `@kubernetes/client-node`: `createPod(manifest: V1Pod)`, `deletePod(name: string, namespace: string)`, `getPod(name: string, namespace: string)`. Uses `CoreV1Api`. In-cluster config when running in K8s, kubeconfig fallback for local dev.
- `packages/dispatcher/src/k8s/manifest.ts` — `buildPodManifest(request: ReviewJob, config: PodConfig): V1Pod`. Generates the Pod spec from the epic (image, envs from secretKeyRef + job metadata, resource limits, `restartPolicy: Never`, labels including `review-job-id`). Pod name: `review-${repo.replace('/', '-').toLowerCase()}-${prNumber}`.
- `packages/dispatcher/src/k8s/index.ts` — barrel exporting `K8sClient`, `buildPodManifest`
- `packages/dispatcher/src/routes/message.ts` — `POST /review/:jobId/message` route. Validates `FollowUpMessageSchema`. Publishes `PubSubMessage` (type `follow_up`) to Redis channel `review:{jobId}:messages`. Returns 200 `{ status: "sent" }`. Returns 404 if jobId has no active status in Redis.
- `packages/dispatcher/tests/k8s/manifest.test.ts` — unit tests for `buildPodManifest`: correct pod name, namespace, image, env vars, labels, resource limits, secretKeyRef for GITHUB_TOKEN
- `packages/dispatcher/tests/routes/review.test.ts` — rewritten: mock `K8sClient.createPod` instead of BullMQ, verify 202 response, verify Pod manifest contents passed to client
- `packages/dispatcher/tests/routes/message.test.ts` — tests for POST /review/:jobId/message: valid message → 200, missing jobId status → 404, invalid body → 400

**Modified:**
- `packages/dispatcher/src/routes/review.ts` (existing, `review.ts:11-25`) — replace `ReviewQueue.enqueue(job)` with `K8sClient.createPod(buildPodManifest(job, podConfig))`. Store initial status in Redis: `{ jobId, status: "queued", podName, createdAt, followUpCount: 0 }`. Return 202 with `{ jobId, status: "queued" }`.
- `packages/dispatcher/src/routes/index.ts` (existing, `index.ts:1-2`) — add export for `createMessageRouter`
- `packages/dispatcher/src/server.ts` (existing, `server.ts:1-26`) — remove `ReviewQueue` import and instantiation, add `K8sClient` init. Import and register `createMessageRouter`. Remove `bullmq` usage entirely.
- `packages/dispatcher/package.json` (existing, `package.json:12-16`) — add `@kubernetes/client-node` to dependencies, remove `bullmq` from dependencies

**Removed:**
- `packages/dispatcher/src/queue/producer.ts` — BullMQ queue wrapper, replaced by K8s client
- `packages/dispatcher/src/queue/index.ts` — barrel for queue module
- `packages/dispatcher/tests/queue/producer.test.ts` — tests for removed queue module
- `packages/worker/` — entire worker package directory (replaced by `packages/reviewer/` in KIT-007)

### Consumes

From KIT-005:
- K8s namespace `kitten` — Pods are created in this namespace
- `kitten-github-token` Secret — referenced in Pod manifest via `secretKeyRef`
- Redis service — `redis://redis.kitten.svc.cluster.local:6379` for status storage and pub/sub
- `REVIEWER_IMAGE` env var — used in `buildPodManifest` for the container image

From `@kitten/shared`:
- `ReviewJob` type and `ReviewJobSchema` — validates POST /review payload
- `AppError` — structured error responses

### Produces

Consumed by KIT-007:
- Pod creation with env vars: `REVIEW_JOB_ID`, `REVIEW_REPO`, `REVIEW_PR_NUMBER`, `REVIEW_HEAD_REF`, `REVIEW_BASE_REF`, `REVIEW_SENDER`, `GITHUB_TOKEN`, `REDIS_URL`, `POD_IDLE_TIMEOUT_MS` — reviewer reads these on startup
- Redis pub/sub channel `review:{jobId}:messages` — reviewer subscribes to this channel

Consumed by KIT-008:
- `POST /review/:jobId/message` endpoint — agent lifecycle card uses this to test follow-up routing
- Redis status key `review:{jobId}:status` — stores `ReviewJobStatus` for status queries

### Design decisions

1. **`@kubernetes/client-node` over raw HTTP** — official K8s Node.js client, handles auth (in-cluster ServiceAccount, kubeconfig), typed V1Pod objects, automatic retries. Rejected: raw `fetch` to K8s API (no auth handling, no types, fragile).
2. **Thin K8sClient class** — wraps `CoreV1Api` with 3 methods (`createPod`, `deletePod`, `getPod`). Easy to mock in tests, easy to extend later. Rejected: using `CoreV1Api` directly in route handlers (tight coupling, hard to test).
3. **Pod name from review metadata** — `review-${repo.replace('/', '-').toLowerCase()}-${prNumber}`. Deterministic, human-readable in `kubectl get pods`. Lowercase required by K8s naming rules. Rejected: UUID-based names (not human-readable).
4. **Status stored in Redis, not K8s** — K8s pod status requires API calls and has limited metadata. Redis key `review:{jobId}:status` stores `ReviewJobStatus` with `followUpCount`, `durationMs`, etc. Fast reads via `GET /status/:jobId`. Rejected: querying K8s API for status (slow, limited fields).
5. **Remove BullMQ + worker in this card** — clean cut. The dispatcher no longer enqueues; it creates Pods. The worker package is dead code after this change. Removing both in the same card avoids a broken intermediate state. Rejected: keeping worker as deprecated (confusing, tests break).
6. **FollowUpMessage validated with Zod** — new schema in `@kitten/shared` (or inline in message route). Fields: `message` (string, min 1), `sender` (string, min 1). Rejected: unvalidated body (violates structured-errors invariant).
7. **Pub/sub fire-and-forget** — `redis.publish(channel, JSON.stringify(pubSubMessage))`. If the Pod is dead, the message is lost. The route returns 200 regardless (the message was published). Whether the Pod received it is not the dispatcher's concern. Rejected: request-reply pattern (complex, unnecessary in v2).

### Risks

1. **`@kubernetes/client-node` in-cluster auth** — requires ServiceAccount with Pod create/delete/get permissions in the `kitten` namespace. The setup script (KIT-005) must create a ServiceAccount + Role + RoleBinding. If missing, dispatcher gets 403 on Pod creation.
2. **BullMQ removal breaks existing tests** — all dispatcher tests that mock `ReviewQueue` must be rewritten to mock `K8sClient`. The `status.ts` route also changes (reads from Redis key instead of BullMQ job status). Plan: rewrite tests before implementation.
3. **Worker package removal** — `pnpm-workspace.yaml` lists `"packages/*"` so removing `packages/worker/` is safe (glob just won't match it). But `pnpm install` may leave stale lockfile entries. Run `pnpm install` after deletion to clean up.

## Implementation Plan

1. - [ ] **Test (RED):** Write `packages/dispatcher/tests/k8s/manifest.test.ts`. Tests: (a) `buildPodManifest returns V1Pod with correct metadata` — verify `pod.metadata.name` is `review-octocat-hello-world-1`, `pod.metadata.namespace` is `kitten`, `pod.metadata.labels` includes `app: kitten-reviewer` and `review-job-id`. (b) `buildPodManifest sets container image from config` — verify `pod.spec.containers[0].image` matches `REVIEWER_IMAGE`. (c) `buildPodManifest injects job envs` — verify env vars `REVIEW_JOB_ID`, `REVIEW_REPO`, `REVIEW_PR_NUMBER`, `REVIEW_HEAD_REF`, `REVIEW_BASE_REF`, `REVIEW_SENDER` are set from the request. (d) `buildPodManifest references GITHUB_TOKEN from secret` — verify env entry uses `valueFrom.secretKeyRef` with name `kitten-github-token` and key `token`. (e) `buildPodManifest sets resource limits` — verify requests and limits match epic spec. (f) `buildPodManifest sets restartPolicy to Never`. Command: `pnpm test -- packages/dispatcher/tests/k8s/manifest.test.ts` — expected: FAIL (module does not exist).
2. - [ ] **Implement (GREEN):** Create `packages/dispatcher/src/k8s/manifest.ts` with `buildPodManifest(request: ReviewJob, config: PodConfig): V1Pod`. Create `packages/dispatcher/src/k8s/index.ts` barrel. Define `PodConfig` interface: `{ namespace: string, image: string, idleTimeoutMs: number, redisUrl: string }`. Command: `pnpm test -- packages/dispatcher/tests/k8s/manifest.test.ts` — expected: PASS (all 6 assertions).
3. - [ ] Commit: `feat: add K8s Pod manifest builder`
4. - [ ] **Test (RED):** Rewrite `packages/dispatcher/tests/routes/review.test.ts`. Remove BullMQ mocks. New tests: (a) `POST /review creates K8s Pod and returns 202` — mock `K8sClient.createPod` to resolve, verify response `{ jobId: "review-octocat-Hello-World-1", status: "queued" }`. (b) `POST /review stores initial status in Redis` — verify Redis key `review:review-octocat-Hello-World-1:status` contains `{ status: "queued", podName, createdAt, followUpCount: 0 }`. (c) `POST /review returns 503 when K8s API unavailable` — mock `K8sClient.createPod` to throw, verify 503 with `{ code: "SERVICE_UNAVAILABLE" }`. (d) `POST /review returns 400 for invalid payload` — existing validation test, keep as-is. Command: `pnpm test -- packages/dispatcher/tests/routes/review.test.ts` — expected: FAIL (K8sClient does not exist yet in route).
5. - [ ] **Implement (GREEN):** Create `packages/dispatcher/src/k8s/client.ts` with `K8sClient` class. Rewrite `packages/dispatcher/src/routes/review.ts` to use `K8sClient.createPod(buildPodManifest(...))` instead of `queue.enqueue(...)`. Add Redis status write. Update `packages/dispatcher/src/server.ts` to instantiate `K8sClient` and pass it to `createReviewRouter`. Remove `ReviewQueue` import. Command: `pnpm test -- packages/dispatcher/tests/routes/review.test.ts` — expected: PASS.
6. - [ ] Commit: `feat: replace BullMQ with K8s Pod creation in review route`
7. - [ ] **Test (RED):** Write `packages/dispatcher/tests/routes/message.test.ts`. Tests: (a) `POST /review/:jobId/message publishes to Redis channel` — mock Redis `publish`, verify channel name `review:{jobId}:messages` and message shape `{ type: "follow_up", payload: { message, sender }, timestamp }`. (b) `POST /review/:jobId/message returns 200 with { status: "sent" }`. (c) `POST /review/:jobId/message returns 404 for unknown jobId` — no status key in Redis. (d) `POST /review/:jobId/message returns 400 for invalid body` — missing `message` field. Command: `pnpm test -- packages/dispatcher/tests/routes/message.test.ts` — expected: FAIL.
8. - [ ] **Implement (GREEN):** Create `packages/dispatcher/src/routes/message.ts` with `createMessageRouter(redis: Redis)`. Add `FollowUpMessageSchema` (Zod: `{ message: string, sender: string }`). Register in `server.ts`. Export from `routes/index.ts`. Command: `pnpm test -- packages/dispatcher/tests/routes/message.test.ts` — expected: PASS.
9. - [ ] Commit: `feat: add follow-up message endpoint`
10. - [ ] **Remove BullMQ + worker:** Delete `packages/dispatcher/src/queue/` directory. Delete `packages/dispatcher/tests/queue/` directory. Remove `bullmq` from `packages/dispatcher/package.json` dependencies. Delete `packages/worker/` directory entirely. Run `pnpm install` to clean lockfile.
11. - [ ] **Update status route:** Rewrite `packages/dispatcher/src/routes/status.ts` to read from Redis key `review:{jobId}:status` instead of BullMQ job status. Update corresponding tests.
12. - [ ] Commit: `refactor: remove BullMQ and worker package`
13. - [ ] **Full test suite:** `pnpm test && pnpm lint` — expected: all green, no references to bullmq or worker.
14. - [ ] Commit: `chore: verify clean build after BullMQ removal`

## How to Test

- **Automated**: `pnpm test -- packages/dispatcher/` — all tests pass:
  - `buildPodManifest returns V1Pod with correct metadata`
  - `buildPodManifest sets container image from config`
  - `buildPodManifest injects job envs`
  - `buildPodManifest references GITHUB_TOKEN from secret`
  - `buildPodManifest sets resource limits`
  - `buildPodManifest sets restartPolicy to Never`
  - `POST /review creates K8s Pod and returns 202`
  - `POST /review stores initial status in Redis`
  - `POST /review returns 503 when K8s API unavailable`
  - `POST /review returns 400 for invalid payload`
  - `POST /review/:jobId/message publishes to Redis channel`
  - `POST /review/:jobId/message returns 200 with sent status`
  - `POST /review/:jobId/message returns 404 for unknown jobId`
  - `POST /review/:jobId/message returns 400 for invalid body`
- **Manual verification**:
  1. With minikube running (from KIT-005): rebuild dispatcher image, apply deployment
  2. `curl -X POST $(minikube service kitten-dispatcher -n kitten --url)/review -H 'Content-Type: application/json' -d '{"repo":"octocat/Hello-World","prNumber":1,"headRef":"master","baseRef":"master","sender":"test"}'` — returns 202 `{ jobId, status: "queued" }`
  3. `kubectl get pods -n kitten -l app=kitten-reviewer` — reviewer Pod exists (may be in CrashLoopBackOff if KIT-007 not done yet — expected, Pod was created)
  4. `curl $(minikube service kitten-dispatcher -n kitten --url)/status/review-octocat-Hello-World-1` — returns `{ status: "queued" }` from Redis
- **Negative check**: `curl -X POST .../review -d '{"prNumber":1}'` — returns 400 VALIDATION error. `curl -X POST .../review/nonexistent-job/message -d '{"message":"hi","sender":"test"}'` — returns 404. Verify `packages/worker/` directory no longer exists: `ls packages/worker/` — `No such file or directory`. Verify no `bullmq` in lockfile: `grep bullmq pnpm-lock.yaml` — no matches.
- **Done means**: `POST /review` creates a K8s Pod (visible via `kubectl get pods -n kitten`), `POST /review/:jobId/message` publishes to Redis, BullMQ and `packages/worker/` are completely removed, all dispatcher tests pass.
