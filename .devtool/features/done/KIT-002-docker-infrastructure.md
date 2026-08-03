---
id: "KIT-002"
status: "done"
priority: "high"
assignee: ""
epic: "v1-scaffolding-dry-run"
dueDate: null
created: "2026-08-02"
modified: "2026-08-02"
completedAt: null
labels: ["infrastructure"]
order: "a1"
---

# Docker Infrastructure Runs Locally

## User Story

See [US-002](../../docs/stories/US-002-docker-infrastructure.md).

## Technical Refinement

### Files

**Created:**
- `packages/dispatcher/Dockerfile` — multi-stage build (build + runtime)
- `packages/worker/Dockerfile` — multi-stage build (build + runtime, includes git)
- `docker-compose.yml` — redis + dispatcher + worker services
- `docker-compose.test.yml` — override for integration tests (isolated Redis)

**Modified:**
- `packages/dispatcher/src/index.ts` — add minimal HTTP server with `/health` endpoint (needed to prove container is healthy)
- `packages/dispatcher/package.json` — add `"start"` script
- `packages/worker/src/index.ts` — add Redis connection check + log on startup
- `packages/worker/package.json` — add `"start"` script

### Consumes

From KIT-001:
- Built packages: `pnpm build` produces `dist/` in each package
- `@kitten/shared` compiled output (worker/dispatcher import from it)
- Root `pnpm-workspace.yaml` (Dockerfile uses pnpm workspace install)
- `.env.example` — template for required env vars

### Produces

Consumed by KIT-003, KIT-004:
- `docker-compose.yml` with services:
  - `redis` — `redis:7-alpine`, port 6379, no persistence
  - `dispatcher` — built from `packages/dispatcher/Dockerfile`, port 3000, env: `REDIS_URL`, `WEBHOOK_SECRET`
  - `worker` — built from `packages/worker/Dockerfile`, env: `REDIS_URL`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, volume: `/tmp/kitten-clones`
- `GET /health` endpoint on dispatcher returning `{ status: "ok", redis: "connected" | "disconnected" }` — KIT-003 extends this with queue info
- Worker startup log `[worker] Connected to Redis` + `[worker] Listening for jobs on queue: reviews` — KIT-004 adds the actual BullMQ consumer
- Dockerfiles with multi-stage build pattern reused by all future images

### Design decisions

1. **Multi-stage Dockerfile** — stage 1: `node:20-alpine` + pnpm install + build. Stage 2: `node:20-alpine` + copy dist + prod deps only. Reduces image size ~70%. Rejected: single-stage (large images with devDeps).
2. **Worker image includes git** — `apk add git` in runtime stage. Required for `simple-git` clone operations. Rejected: separate init-container (K8s pattern, overkill for Docker Compose).
3. **pnpm deploy for Docker** — use `pnpm deploy --filter @kitten/dispatcher --prod /app` in build stage. Bundles only prod deps of that package + shared. Rejected: copy entire workspace (bloated image). Note: verify `pnpm deploy` works with workspace refs — risk item.
4. **No Redis persistence** — `redis:7-alpine` with no volume. Ephemeral queue data is fine — jobs are transient. Rejected: redis.conf with AOF (unnecessary complexity for dev).
5. **Health check uses minimal HTTP** — dispatcher's `index.ts` gets a tiny Express server with just `/health`. Not the full routes (that's KIT-003). Just enough to prove Docker healthcheck works.
6. **Worker clone volume** — `/tmp/kitten-clones` mounted from host. Keeps cloned repos outside container filesystem. Easy to inspect/debug. Cleaned up by worker after each job.

### Risks

1. **`pnpm deploy` with workspace protocol (`workspace:*`)** — may not resolve correctly in Docker build context. Step 3 tests this before writing Dockerfiles for all packages. Fallback: copy entire workspace and prune.
2. **Git inside Alpine** — `simple-git` needs `git` binary. Alpine's `git` package works but may miss some features. Step 7 verifies git clone works inside the worker container.

## Implementation Plan

1. - [ ] **Test (RED):** Write `packages/dispatcher/tests/health.test.ts` — test that `GET /health` returns `{ status: "ok" }` with 200 when Redis is available, and `{ status: "ok", redis: "disconnected" }` with 200 when Redis is unreachable. Command: `pnpm test -- packages/dispatcher/tests/health.test.ts` — expected: FAIL (no health endpoint yet).
2. - [ ] **Implement (GREEN):** Modify `packages/dispatcher/src/index.ts` — add Express app with `/health` route. Add `start` script to `package.json`. Health checks Redis connectivity via ioredis ping. Command: same test — expected: PASS.
3. - [ ] Create `packages/dispatcher/Dockerfile` — multi-stage, use `pnpm deploy`. Build and verify: `docker build -t kitten-dispatcher packages/dispatcher/` — expected: image builds, `docker run --rm kitten-dispatcher` prints `[dispatcher] starting on port 3000`.
4. - [ ] Modify `packages/worker/src/index.ts` — add Redis connection check, log `[worker] Connected to Redis` on success, `[worker] Redis connection failed` on error. Add `start` script to `package.json`.
5. - [ ] Create `packages/worker/Dockerfile` — multi-stage, includes `apk add git` in runtime stage. Build and verify: `docker build -t kitten-worker packages/worker/` — expected: image builds.
6. - [ ] Commit: `feat: add Dockerfiles for dispatcher and worker`
7. - [ ] Create `docker-compose.yml` with redis, dispatcher, worker services. Create `.env` from `.env.example`. Command: `docker compose up -d` — expected: all 3 containers running.
8. - [ ] Verify dispatcher health: `curl http://localhost:3000/health` — expected: `{ "status": "ok", "redis": "connected" }`.
9. - [ ] Verify worker logs: `docker compose logs worker` — expected: `[worker] Connected to Redis` and `[worker] Listening for jobs on queue: reviews`.
10. - [ ] Test git inside worker: `docker compose exec worker git --version` — expected: `git version 2.x.x`.
11. - [ ] Test restart policy: `docker compose kill worker && sleep 3 && docker compose ps` — expected: worker restarted automatically.
12. - [ ] Create `docker-compose.test.yml` with isolated Redis on different port for integration tests.
13. - [ ] Update `AGENTS.md` `## Local setup` section with real commands: `pnpm install`, `cp .env.example .env`, `docker compose up -d --build`, `curl /health`.
14. - [ ] Commit: `feat: add docker-compose for local development`
15. - [ ] Full validation: `docker compose down && docker compose up -d --build` — expected: clean build, all healthy.

## How to Test

- **Automated**: `pnpm test -- packages/dispatcher/tests/health.test.ts` — all health endpoint tests pass.
- **Manual verification**:
  1. `cp .env.example .env` (fill ANTHROPIC_API_KEY placeholder)
  2. `docker compose up -d --build`
  3. `docker compose ps` — 3 containers running, all healthy
  4. `curl http://localhost:3000/health` — `{ "status": "ok", "redis": "connected" }`
  5. `docker compose logs worker` — shows `Connected to Redis` + `Listening for jobs`
- **Negative check**: Stop Redis: `docker compose stop redis` → `curl /health` — still 200 but `redis: "disconnected"`. Worker logs show reconnection attempts, not crash.
- **Done means**: `docker compose up -d --build` starts 3 containers, dispatcher health returns `redis: "connected"`, worker logs confirm Redis connection and queue listening.
