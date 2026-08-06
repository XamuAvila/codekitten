# HTTP API

The dispatcher exposes five endpoints. All request and response bodies are JSON.
There is no authentication on the operational endpoints — the dispatcher is expected
to be reachable only from inside the cluster, or fronted by an ingress that
authenticates. The webhook endpoint authenticates every delivery by HMAC signature.

Base URL in a minikube setup:

```bash
DISPATCHER_URL=$(minikube service kitten-dispatcher -n kitten --url)
```

---

## Table of contents

- [`GET /health`](#get-health)
- [`POST /review`](#post-review)
- [`GET /status/:jobId`](#get-statusjobid)
- [`POST /review/:jobId/message`](#post-reviewjobidmessage)
- [`POST /webhook/github`](#post-webhookgithub)
- [Error format](#error-format)
- [Shared types](#shared-types)

---

## `GET /health`

Liveness probe. **Always answers `200`**, even when Redis is unreachable — the
dispatcher itself is up, and a failing dependency is reported in the body rather than
by failing the request.

**Response `200`**

```json
{ "status": "ok", "redis": "connected" }
```

`redis` is `"connected"` when `PING` returns `PONG`, `"disconnected"` on any other
result or on a thrown error.

```bash
curl "$DISPATCHER_URL/health"
```

---

## `POST /review`

Submits a review. Creates the reviewer Pod synchronously through the Kubernetes API,
writes the initial status to Redis, and returns immediately — the review itself runs
asynchronously inside the Pod.

**Request body** — validated against `ReviewJobSchema`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `repo` | `string` | yes | `owner/repo` form. |
| `prNumber` | `integer > 0` | yes | |
| `headRef` | `string` | yes | Branch name, not a SHA. Checked out by the clone. |
| `baseRef` | `string` | yes | Branch name. One side of the three-dot diff. |
| `sender` | `string` | yes | Who requested the review. Recorded, not authenticated. |
| `isReReview` | `boolean` | no | Defaults to `false`. |
| `changedFiles` | `string[]` | no | Reserved; the reviewer fetches the file list from the GitHub API. |

**Response `202`**

```json
{ "jobId": "review-owner-repo-2", "status": "queued" }
```

`jobId` is deterministic: `review-{owner}-{repo}-{prNumber}`, lowercased with `/`
replaced by `-` (Kubernetes requires lowercase RFC 1123 names). The same PR always
produces the same job id, which is what makes comment commands routable without any
lookup table.

**Errors**

| Status | Code | Cause |
|---|---|---|
| `400` | `VALIDATION` | Body fails the schema, or is not valid JSON. |
| `503` | `SERVICE_UNAVAILABLE` | Pod creation failed. Includes no Kubernetes API available (Docker Compose), RBAC denial, and **a Pod with that name already existing** — a live review for the same PR. |

```bash
curl -X POST "$DISPATCHER_URL/review" \
  -H "Content-Type: application/json" \
  -d '{"repo":"owner/repo","prNumber":2,"headRef":"feature","baseRef":"main","sender":"me"}'
```

---

## `GET /status/:jobId`

Reads the job status from Redis (`review:{jobId}:status`).

**Response `200`** — a `ReviewJobStatus`:

```json
{
  "jobId": "review-owner-repo-2",
  "status": "reviewing",
  "podName": "review-owner-repo-2",
  "createdAt": "2026-08-05T12:00:00.000Z",
  "completedAt": "2026-08-05T12:04:31.000Z",
  "durationMs": 271000,
  "followUpCount": 1
}
```

| Field | Notes |
|---|---|
| `status` | `queued` → `running` → `reviewing` → `completed` \| `failed` \| `cancelled`. |
| `completedAt` | Present only in terminal states. |
| `durationMs` | Optional. |
| `followUpCount` | Incremented by the **Pod** when it consumes a message, not by the dispatcher when it publishes one. |

**Errors**

| Status | Code | Cause |
|---|---|---|
| `404` | `NOT_FOUND` | No Redis key for that job id. |

---

## `POST /review/:jobId/message`

Sends a follow-up message to a live reviewer Pod through Redis pub/sub. Publication is
fire-and-forget: a `200` means "published", not "delivered and processed". The
dispatcher first checks the stored status and refuses jobs in a terminal state.

Receiving a message resets the Pod's idle timer.

**Request body**

| Field | Type | Required |
|---|---|---|
| `message` | `string` (non-empty) | yes |
| `sender` | `string` (non-empty) | yes |

**Recognized messages** — matched case-insensitively after trimming:

| Message | Effect |
|---|---|
| `force` | Re-run the full review with no token budget (`ignoreBudget`), and `forceMaxTurns` in agentic mode. |
| `stop` | Cancel. Aborts an in-flight review between chunks or agentic turns; on an already-finished review, reports `cancelled`, posts a cancellation comment and exits. |
| anything else | Treated as a question. Answered by the LLM using the original review context (system prompt, user prompt, numbered findings), single-turn. The answer is posted as a PR comment. |

**Response `200`**

```json
{ "status": "sent" }
```

**Errors**

| Status | Code | Cause |
|---|---|---|
| `400` | `VALIDATION` | Missing or empty `message` / `sender`. |
| `404` | `NOT_FOUND` | Unknown job, or the job is `completed` / `failed` / `cancelled`. |

```bash
curl -X POST "$DISPATCHER_URL/review/review-owner-repo-2/message" \
  -H "Content-Type: application/json" \
  -d '{"message":"why is that a critical?","sender":"dev"}'
```

---

## `POST /webhook/github`

The GitHub webhook entrypoint. **The signature is verified before the payload is
interpreted in any way.**

**Request headers**

| Header | Required | Notes |
|---|---|---|
| `X-Hub-Signature-256` | yes | `sha256=<hex>`, HMAC-SHA-256 of the raw body with `WEBHOOK_SECRET`. Compared with a timing-safe comparison after an explicit length check. |
| `X-GitHub-Event` | yes | Event name. Anything unhandled is acknowledged as ignored. |
| `X-GitHub-Delivery` | no | Logged for correlation. |

The HMAC covers the **exact raw bytes** received, captured by the body parser's
`verify` hook — never re-serialized JSON, which would change whitespace and key order
and break every signature.

### Handled events

#### `pull_request`

Acted on when `action` is `opened`, `reopened` or `synchronize` **and** the PR state is
`open`. Everything else is ignored.

If a job for that PR exists in Redis in a non-terminal state, the dispatcher publishes
`re_review` rather than creating a second Pod. If nobody is subscribed — the Redis key
outlived the Pod — it dispatches a fresh Pod with `isReReview: true` instead.

| Situation | Response |
|---|---|
| New review dispatched | `202 { "jobId": "...", "status": "queued" }` |
| Re-review published to the live Pod | `202 { "jobId": "...", "status": "re_review" }` |
| Unhandled action, closed PR, malformed payload | `200 { "ignored": true }` |

#### `issue_comment`

Requires `action: "created"`, the issue to actually be a pull request, and the comment
author **not** to be a `Bot`. The bot filter is mandatory: Kitten posts comments
itself, and without it a trigger word inside its own output would re-trigger it.

The comment body must **start with** the trigger word (case-insensitive prefix match;
`TRIGGER_WORD`, default `@reviewer`). The remainder is the command:

| Command | Behavior | Response |
|---|---|---|
| `force` / `stop` | Published as a `follow_up` to the Pod. | `202 { "jobId": "...", "status": "sent" }` |
| `remember <fact>` | Written to the knowledge store for the repository. Needs no live Pod. | `202 { "status": "stored" }` |
| anything else | Published as a follow-up question. | `202 { "jobId": "...", "status": "sent" }` |
| `remember` with empty text, no live Pod, knowledge store unconfigured, or an insert failure | Ignored — never a `5xx`, because GitHub would retry it into duplicate knowledge entries. | `200 { "ignored": true }` |

#### `pull_request_review_comment`

Correction capture. A **human** reply on a review-comment thread whose root comment
carries Kitten's marker is stored as knowledge with `source: "correction"`, attributed
to the replying user.

The filters run cheapest-first: `action === "created"`, then `in_reply_to_id` present
(top-level comments are not replies), then the author is not a `Bot`, and only then one
GitHub API call to fetch the root comment and check the marker. Every human reply on a
Kitten thread is stored — there is no sentiment parsing; retrieval similarity decides
relevance at use time.

| Situation | Response |
|---|---|
| Correction stored | `202 { "status": "stored" }` |
| Not a reply, bot author, root is not a Kitten finding, knowledge unconfigured, or the lookup/insert failed | `200 { "ignored": true }` |

#### Any other event

`200 { "ignored": true }`.

### Webhook errors

| Status | Code | Cause |
|---|---|---|
| `401` | `AUTH_FAILED` | Missing, malformed or non-matching signature. |
| `503` | `SERVICE_UNAVAILABLE` | `WEBHOOK_SECRET` is not configured. A webhook that accepts unsigned deliveries is worse than no webhook. |

### Sending a signed delivery by hand

```bash
BODY='{"action":"opened", ...}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $NF}')"

curl -X POST "$DISPATCHER_URL/webhook/github" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-GitHub-Delivery: manual-1" \
  -H "X-Hub-Signature-256: $SIG" \
  -d "$BODY"
```

`./scripts/webhook-e2e.sh` does exactly this against fixtures in
`scripts/fixtures/webhook/`.

---

## Error format

Every error response has the same shape:

```json
{
  "code": "VALIDATION",
  "message": "Invalid payload",
  "details": [
    { "field": "prNumber", "code": "invalid_type", "message": "Expected number, received string" }
  ]
}
```

`details` is present only when the error carries structured context.

**Code → status mapping:**

| `AppError` code | HTTP |
|---|---|
| `VALIDATION` | `400` |
| `AUTH_FAILED` | `401` |
| `NOT_FOUND` | `404` |
| `DUPLICATE` | `409` |
| `SERVICE_UNAVAILABLE` | `503` |
| `RATE_LIMITED`, `UNPROCESSABLE`, `GITHUB_API_ERROR`, `LLM_OUTPUT_INVALID`, `UNKNOWN_TOOL` | `500` |

The last row lists codes the reviewer raises internally; they have no dispatcher route
that produces them today, so they fall through to the default mapping.

Two special cases:

- **Malformed JSON** in a request body is caught before any route runs and answered
  `400 { "code": "VALIDATION", "message": "Invalid payload — body is not valid JSON" }`.
- **Any non-`AppError` exception** is logged server-side and answered
  `500 { "code": "INTERNAL", "message": "Internal server error" }`. Internals are never
  echoed back to the caller.

---

## Shared types

Authoritative definitions live in `packages/shared/src/types/` as Zod schemas.

```ts
// The unit of work
interface ReviewJob {
  repo: string;              // "owner/repo"
  prNumber: number;
  headRef: string;
  baseRef: string;
  sender: string;
  isReReview: boolean;       // default false
  changedFiles?: readonly string[];
}

// What the model reports
interface Finding {
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line: number;              // 1-based, new-file side
  finding: string;
  suggestion?: string;       // rendered as a GitHub ```suggestion block
  ruleId?: string;           // only when a declared .reviewer.yml rule was broken
}

// A completed review
interface ReviewResult {
  findings: readonly Finding[];
  contextChecked: readonly string[];
  conventionsStatus: readonly string[];
  metadata: { model: string; inputTokens: number; outputTokens: number; durationMs: number };
}

// Redis: review:{jobId}:status
interface ReviewJobStatus {
  jobId: string;
  status: "queued" | "running" | "reviewing" | "completed" | "failed" | "cancelled";
  podName: string;
  createdAt: string;         // ISO 8601
  completedAt?: string;
  durationMs?: number;
  followUpCount: number;
}

// Redis: channel review:{jobId}:messages
interface PubSubMessage {
  type: "follow_up" | "shutdown" | "re_review";
  payload: { message: string; sender: string } | Record<string, never>;
  timestamp: string;         // ISO 8601
}
```
