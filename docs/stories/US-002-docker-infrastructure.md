---
id: US-002
title: Docker Infrastructure Runs Locally
status: draft
epic: v1-scaffolding-dry-run
---

# US-002: Docker Infrastructure Runs Locally

## Story

As a **developer**, I want to start the entire stack (Redis, dispatcher, worker) with `docker compose up` so that I can test the review pipeline locally without any cloud dependencies.

## Acceptance Criteria

### AC-1: All services start

```
Given the repo is cloned and .env is configured from .env.example
When I run `docker compose up -d`
Then redis, dispatcher, and worker containers are running and healthy
```

### AC-2: Dispatcher health check responds

```
Given the stack is running
When I send `GET http://localhost:3000/health`
Then I receive 200 with `{ "status": "ok", "redis": "connected", "queue": "ready" }`
```

### AC-3: Worker connects to queue

```
Given the stack is running
When I check worker container logs
Then I see "[worker] Connected to Redis" and "[worker] Listening for jobs on queue: reviews"
```

### AC-4: Services restart on failure

```
Given the stack is running
When the worker container crashes
Then Docker restarts it automatically (restart: unless-stopped)
```

## Notes

- `docker-compose.yml` at repo root.
- Redis 7 Alpine image, no persistence needed.
- Dispatcher and worker each have their own Dockerfile (multi-stage: build + runtime).
- `.env.example` with all required vars (REDIS_URL, placeholder ANTHROPIC_API_KEY, placeholder GITHUB_TOKEN).
- Worker mounts a host dir for clone workspace (`/tmp/kitten-clones`).
