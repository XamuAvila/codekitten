---
id: v1-scaffolding-dry-run
title: "v1: Project Scaffolding, Infrastructure & Dry Run"
status: active
created: "2026-08-02"
---

# v1: Project Scaffolding, Infrastructure & Dry Run

> Ephemeral PR reviewer — white-label, vendor-agnostic. This epic covers the foundational skeleton: project structure, Docker infrastructure, and a complete dry run proving the architecture works end-to-end.

## Problem

Manual code review is a bottleneck. Existing LLM reviewers (CodeRabbit, etc.) see only the diff — no repo context, no team conventions, pricing scales per seat. We need a self-hosted, white-label reviewer that reads the full repo + diff + team conventions.

## Solution (v1 scope)

A pnpm monorepo with three packages (shared, dispatcher, worker), orchestrated via Docker Compose. The dispatcher receives a review request, enqueues it in BullMQ (Redis), and the worker dequeues, clones the repo, reads conventions, and logs a dry-run result. No LLM calls, no GitHub comment posting — just proving the pipeline works.

## Implementation Cards

Execution order (sequential — each depends on the previous):

| Card | Story | Scope |
|---|---|---|
| [KIT-001](../.devtool/features/KIT-001-project-bootstrap.md) | [US-001](../docs/stories/US-001-project-bootstrap.md) | pnpm workspace, shared types + config parser, dispatcher/worker skeletons, vitest, ESLint |
| [KIT-002](../.devtool/features/KIT-002-docker-infrastructure.md) | [US-002](../docs/stories/US-002-docker-infrastructure.md) | Dockerfiles, docker-compose (Redis + dispatcher + worker), /health endpoint |
| [KIT-003](../.devtool/features/KIT-003-enqueue-review-job.md) | [US-003](../docs/stories/US-003-enqueue-review-job.md) | POST /review, GET /status, Zod validation, BullMQ producer, error handler |
| [KIT-004](../.devtool/features/KIT-004-dry-run-review.md) | [US-004](../docs/stories/US-004-dry-run-review.md) | BullMQ consumer, git clone, file scanning, skip patterns, dry-run logger, cleanup |

Step-by-step TDD implementation plans live in each card's `## Implementation Plan` section.

## Architecture

```
POST /review (curl / GitHub Actions)
    │
    ▼
┌──────────────────────────────┐
│  Dispatcher (Express)        │
│  POST /review                │
│  POST /webhook/github        │
│  GET  /health                │
│  GET  /status/:jobId         │
│  Validates payload           │
│  Enqueues job in BullMQ      │
└──────────┬───────────────────┘
           │ BullMQ
           ▼
      [ Redis 7 ]
           │
           ▼
┌──────────────────────────────────────┐
│  Worker (BullMQ consumer)            │
│                                      │
│  1. git clone --depth=1 --branch=X   │
│  2. Diff from job payload (v1 mock)  │
│     (v2+: GitHub API PR files)       │
│  3. Read .reviewer.yml (if exists)   │
│  4. Read changed files (full content)│
│  5. Log dry-run summary              │
│  6. Cleanup clone dir                │
└──────────────────────────────────────┘
```

### Stack

| Component | Technology |
|---|---|
| Language | TypeScript (Node.js) |
| Package manager | pnpm (workspaces) |
| Dispatcher | Express |
| Queue | BullMQ (Redis 7) |
| Git operations | simple-git |
| Config parsing | zod (validation) |
| Testing | vitest + testcontainers |
| Containerization | Docker + docker-compose |
| LLM (future) | Anthropic SDK (adapter interface defined in v1) |
| GitHub (future) | Octokit (adapter interface defined in v1) |

### Project Structure

```
kitten/
├── packages/
│   ├── shared/
│   │   ├── src/
│   │   │   ├── types/
│   │   │   │   ├── review-job.ts      # ReviewJob, ReviewResult, Finding
│   │   │   │   ├── reviewer-config.ts # ReviewerConfig (from .reviewer.yml)
│   │   │   │   └── index.ts
│   │   │   ├── config/
│   │   │   │   ├── parse-config.ts    # .reviewer.yml → ReviewerConfig
│   │   │   │   ├── defaults.ts        # default config values
│   │   │   │   └── index.ts
│   │   │   ├── llm/
│   │   │   │   ├── adapter.ts         # LLMAdapter interface (no impl yet)
│   │   │   │   └── index.ts
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── dispatcher/
│   │   ├── src/
│   │   │   ├── server.ts              # Express app setup
│   │   │   ├── routes/
│   │   │   │   ├── review.ts          # POST /review
│   │   │   │   ├── status.ts          # GET /status/:jobId
│   │   │   │   └── health.ts          # GET /health
│   │   │   ├── middleware/
│   │   │   │   └── validation.ts      # Zod payload validation
│   │   │   ├── queue/
│   │   │   │   └── producer.ts        # BullMQ queue producer
│   │   │   └── index.ts
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── worker/
│       ├── src/
│       │   ├── consumer.ts            # BullMQ worker entry
│       │   ├── git/
│       │   │   ├── clone.ts           # clone repo (--depth=1)
│       │   │   ├── files.ts           # read changed files content
│       │   │   └── index.ts
│       │   ├── analyzer/
│       │   │   └── dry-run.ts         # log what WOULD happen
│       │   └── index.ts
│       ├── Dockerfile
│       ├── package.json
│       └── tsconfig.json
├── docker-compose.yml
├── docker-compose.test.yml            # for integration tests
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .env.example
├── .reviewer.yml.example
├── .gitignore
├── package.json                       # workspace root
└── README.md
```

## Types (shared package)

```typescript
// ReviewJob — dispatcher → worker via BullMQ
interface ReviewJob {
  readonly repo: string;          // "org/repo"
  readonly prNumber: number;
  readonly headRef: string;
  readonly baseRef: string;
  readonly sender: string;
  readonly isReReview: boolean;
  readonly changedFiles?: readonly string[];  // optional — v1: if absent, worker scans all files. v2+: populated from GitHub PR API.
}

// ReviewerConfig — parsed from .reviewer.yml
interface ReviewerConfig {
  readonly language: string;       // default "en"
  readonly model: string;          // default "claude-sonnet-5"
  readonly maxTokens: number;      // default 200_000
  readonly trigger: string;        // default "@reviewer"
  readonly blocking: 'comment_only' | 'request_changes';
  readonly skip: readonly string[];          // glob patterns
  readonly conventionsFile: string;          // default "CLAUDE.md"
  readonly rules: readonly ReviewRule[];
}

// Finding — LLM output (v2+)
interface Finding {
  readonly severity: 'critical' | 'high' | 'medium' | 'low';
  readonly file: string;
  readonly line: number;
  readonly finding: string;
  readonly suggestion?: string;
  readonly ruleId?: string;
}

// LLMAdapter — interface for future implementations
interface LLMAdapter {
  review(context: ReviewContext): Promise<ReviewResult>;
}
```

## Config (.reviewer.yml)

```yaml
reviewer:
  language: en
  model: claude-sonnet-5
  max_tokens: 200000
  trigger: "@reviewer"
  blocking: comment_only
  skip:
    - "**/Migrations/**"
    - "*.Designer.cs"
    - "**/*.snap"
    - "**/node_modules/**"
  conventions_file: CLAUDE.md
  rules: []  # custom rules are v2+
```

Parsed with Zod. Missing file → use defaults. Invalid file → structured error, job fails.

## Dry Run Behavior

```bash
$ docker compose up -d
$ curl -X POST localhost:3000/review \
    -H "Content-Type: application/json" \
    -d '{"repo":"octocat/Hello-World","prNumber":1,"headRef":"main","baseRef":"main~1","sender":"test"}'

# Response: 202 Accepted
# { "jobId": "review-octocat-Hello-World-1", "status": "queued" }

# Worker logs:
# [worker] Processing job: review-octocat-Hello-World-1
# [worker] Cloning octocat/Hello-World (depth=1)...
# [worker] Clone complete: 2.3MB
# [worker] Files in repo: 42
# [worker] Files after skip patterns: 38
# [worker] Config: using defaults (.reviewer.yml not found)
# [worker] DRY RUN — would send 15k tokens to claude-sonnet-5
# [worker] DRY RUN — would post PR comment with findings
# [worker] Cleanup: removed clone dir
# [worker] Job completed in 4.2s

$ curl localhost:3000/status/review-octocat-Hello-World-1
# { "id": "review-octocat-Hello-World-1", "status": "completed", "duration": 4200 }
```

## Error Handling

| Error | Response / Behavior |
|---|---|
| Invalid payload | 400 `{ code: "VALIDATION", message: "...", details: [...] }` |
| Repo not found / clone fails | Job status `failed`, error logged |
| Redis unavailable | Dispatcher returns 503 |
| Worker crash | BullMQ retry (max 2), then dead letter queue |
| Job timeout | 10 min deadline, BullMQ marks failed |

Structured errors everywhere: `{ code, message, details }`.

## Testing Strategy

| Level | What | Tool |
|---|---|---|
| Unit | Config parser, payload validation, job ID generation | vitest |
| Integration | Dispatcher → Redis → Worker end-to-end | vitest + testcontainers (Redis) |
| Smoke | `docker compose up` + `curl` + verify logs | Manual / CI script |

Coverage target: 80%+ on shared + dispatcher + worker.

## What is NOT in v1 (out-of-scope)

- LLM API calls (Claude, GPT, any)
- GitHub comment/review posting
- GitHub webhook signature validation
- GitHub App authentication
- .reviewer.yml `rules[]` pattern matching
- Kubernetes Job creation
- Re-review via comment trigger
- Multi-model hybrid strategy (Haiku triage → Sonnet)
- Token cost tracking / budget alerts
- Dashboard / UI

## Future phases (reference only)

| Phase | Scope |
|---|---|
| v2 — LLM Integration | Claude adapter impl, prompt builder, structured output, GitHub comment posting |
| v3 — MCP Agentic Review | Semble MCP + filesystem tools inside worker container. Claude explores codebase via tool calls (search, find_related, read_file) instead of fixed context. Enables call-site analysis, pattern consistency checks, and deep context without pre-computing everything. Requires investigating Semble standalone viability in Docker. |
| v4 — GitHub Integration | Webhook signature validation, GitHub App auth, re-review trigger |
| v5 — Deep Context | git log history of touched files, pattern comparison across repo, learning from past reviews |
| v6 — Production | K8s Job migration, monitoring, cost tracking, multi-repo |
