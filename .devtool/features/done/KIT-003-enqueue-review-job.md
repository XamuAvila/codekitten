---
id: "KIT-003"
status: "done"
priority: "high"
assignee: ""
epic: "v1-scaffolding-dry-run"
dueDate: null
created: "2026-08-02"
modified: "2026-08-02"
completedAt: null
labels: ["dispatcher"]
order: "a2"
---

# Submit and Track a Review Job

## User Story

See [US-003](../../docs/stories/US-003-enqueue-review-job.md).

## Technical Refinement

### Files

**Created:**
- `packages/dispatcher/src/routes/review.ts` — `POST /review` route handler
- `packages/dispatcher/src/routes/status.ts` — `GET /status/:jobId` route handler
- `packages/dispatcher/src/routes/index.ts` — barrel, registers routes on Express app
- `packages/dispatcher/src/middleware/validation.ts` — Zod validation middleware factory
- `packages/dispatcher/src/middleware/error-handler.ts` — global error handler → AppError format
- `packages/dispatcher/src/queue/producer.ts` — BullMQ Queue wrapper, `enqueueReview(job: ReviewJob): Promise<string>`
- `packages/dispatcher/src/queue/index.ts` — barrel
- `packages/dispatcher/tests/routes/review.test.ts` — POST /review tests
- `packages/dispatcher/tests/routes/status.test.ts` — GET /status tests
- `packages/dispatcher/tests/middleware/validation.test.ts` — validation tests
- `packages/dispatcher/tests/queue/producer.test.ts` — enqueue tests

**Modified:**
- `packages/dispatcher/src/index.ts` (KIT-002 baseline) — replace placeholder with full Express app wiring: routes + middleware + error handler. Lines: entire file rewritten.
- `packages/dispatcher/src/routes/health.ts` — extract health route from index.ts (created in KIT-002 inline), add queue status info.

### Consumes

From KIT-001 (`@kitten/shared`):
- `ReviewJob` type and `ReviewJobSchema` Zod schema — used to validate POST /review payload
- `AppError` type — used in error responses

From KIT-002:
- `docker-compose.yml` — Redis service for BullMQ
- Health endpoint pattern (extended with queue info)
- Express app skeleton in `index.ts` (rewritten to add routes)

### Produces

Consumed by KIT-004:
- BullMQ queue name: `"reviews"` — worker connects to same queue
- Job ID format: `review-{owner}-{repo}-{prNumber}` (deterministic) — worker receives this as `job.id`
- Job data shape: `ReviewJob` (from @kitten/shared) — worker deserializes this
- `GET /status/:jobId` endpoint — used to verify job completion after worker processes

Consumed externally (curl / GitHub Actions):
- `POST /review` — accepts `{ repo, prNumber, headRef, baseRef, sender }`, returns `{ jobId, status: "queued" }`
- `GET /status/:jobId` — returns `{ id, status, duration?, error? }`
- `GET /health` — returns `{ status: "ok", redis, queue }`

### Design decisions

1. **Deterministic job IDs** — `review-{owner}-{repo}-{prNumber}` format. Allows status lookup without storing a mapping. Re-review creates a new BullMQ job with `{removeOnComplete: true}` on the old one. Rejected: UUID (need extra storage for PR→job mapping).
2. **Zod validation middleware** — generic factory: `validate(schema)` returns Express middleware. Reusable for any route. Rejected: manual validation in route handlers (repetitive).
3. **BullMQ Queue abstraction** — thin wrapper `ReviewQueue` class hiding BullMQ details. Constructor takes Redis URL. Methods: `enqueue(job)`, `getStatus(jobId)`. Rejected: direct BullMQ usage in routes (tight coupling, hard to test).
4. **Error handler middleware** — catches thrown `AppError` or Zod errors, formats as `{ code, message, details }`. Unknown errors → 500 with `code: "INTERNAL"`. Never leaks stack traces.
5. **Re-review = new job** — POST /review for existing PR creates a new job (old one may be completed/failed). No dedup logic in v1. BullMQ handles concurrent runs via unique job names with `{jobId}` option.

### Risks

1. **BullMQ `getJob` returns null for expired jobs** — `removeOnComplete` has a TTL. If status is queried after TTL, returns null. Step 8 tests this edge case. Mitigation: set `removeOnComplete: { age: 3600 }` (1 hour retention).

## Implementation Plan

1. - [ ] **Test (RED):** Write `packages/dispatcher/tests/middleware/validation.test.ts` — test `validate(ReviewJobSchema)` middleware: valid payload passes through, missing `repo` returns 400 with `{ code: "VALIDATION" }`, extra fields stripped. Command: `pnpm test -- packages/dispatcher/tests/middleware/validation.test.ts` — expected: FAIL.
2. - [ ] **Implement (GREEN):** Create `packages/dispatcher/src/middleware/validation.ts` — `validate(schema: ZodSchema)` middleware factory. Create `error-handler.ts` — global error handler. Command: same test — expected: PASS.
3. - [ ] Commit: `feat: add Zod validation middleware and error handler`
4. - [ ] **Test (RED):** Write `packages/dispatcher/tests/queue/producer.test.ts` — test `ReviewQueue.enqueue(job)` returns deterministic job ID, `ReviewQueue.getStatus(jobId)` returns `{ status: "waiting" }` after enqueue. Use testcontainers Redis or mock. Command: `pnpm test -- packages/dispatcher/tests/queue/producer.test.ts` — expected: FAIL.
5. - [ ] **Implement (GREEN):** Create `packages/dispatcher/src/queue/producer.ts` — `ReviewQueue` class with `enqueue()` and `getStatus()`. Job ID: `review-${repo.replace('/', '-')}-${prNumber}`. Command: same test — expected: PASS.
6. - [ ] Commit: `feat: add BullMQ review queue producer`
7. - [ ] **Test (RED):** Write `packages/dispatcher/tests/routes/review.test.ts` — test POST /review with valid payload → 202 + `{ jobId, status: "queued" }`, invalid payload → 400 + VALIDATION error, Redis down → 503 + SERVICE_UNAVAILABLE. Command: `pnpm test -- packages/dispatcher/tests/routes/review.test.ts` — expected: FAIL.
8. - [ ] **Test (RED):** Write `packages/dispatcher/tests/routes/status.test.ts` — test GET /status/:jobId for queued job → 200 + `{ status: "waiting" }`, unknown job → 404 + `{ code: "NOT_FOUND" }`. Command: `pnpm test -- packages/dispatcher/tests/routes/status.test.ts` — expected: FAIL.
9. - [ ] **Implement (GREEN):** Create `packages/dispatcher/src/routes/review.ts`, `status.ts`, `index.ts`. Rewrite `index.ts` to wire routes + middleware + error handler. Extract health route to `routes/health.ts`. Command: both tests — expected: PASS.
10. - [ ] Commit: `feat: add POST /review and GET /status routes`
11. - [ ] **Docker test:** `docker compose up -d --build` then `curl -X POST localhost:3000/review -H 'Content-Type: application/json' -d '{"repo":"octocat/Hello-World","prNumber":1,"headRef":"main","baseRef":"main~1","sender":"test"}'` — expected: 202 with jobId.
12. - [ ] Commit: `test: verify dispatcher routes work in Docker`

## How to Test

- **Automated**: `pnpm test -- packages/dispatcher/` — all tests pass:
  - `validate middleware accepts valid ReviewJob payload`
  - `validate middleware rejects missing repo with VALIDATION error`
  - `validate middleware strips extra fields`
  - `ReviewQueue.enqueue returns deterministic job ID`
  - `ReviewQueue.getStatus returns waiting for queued job`
  - `POST /review returns 202 with jobId for valid payload`
  - `POST /review returns 400 VALIDATION for invalid payload`
  - `POST /review returns 503 when Redis unavailable`
  - `GET /status returns job state for known job`
  - `GET /status returns 404 NOT_FOUND for unknown job`
- **Manual verification**:
  1. `docker compose up -d --build`
  2. `curl -X POST localhost:3000/review -H 'Content-Type: application/json' -d '{"repo":"octocat/Hello-World","prNumber":1,"headRef":"main","baseRef":"main~1","sender":"test"}'`
  3. Response: `{"jobId":"review-octocat-Hello-World-1","status":"queued"}`
  4. `curl localhost:3000/status/review-octocat-Hello-World-1` — shows job status
- **Negative check**: `curl -X POST localhost:3000/review -H 'Content-Type: application/json' -d '{"prNumber":1}'` — returns 400: `{ "code": "VALIDATION", "message": "Invalid payload", "details": [{"field": "repo", ...}] }`.
- **Done means**: POST /review enqueues a job in BullMQ visible via GET /status, and invalid payloads return structured VALIDATION errors.
