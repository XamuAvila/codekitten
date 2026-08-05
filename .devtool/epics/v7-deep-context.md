---
id: v7-deep-context
title: "v7: Deep Context"
status: done
created: "2026-08-05"
---

# v7: Deep Context

> The reviewer gains context beyond the diff and the file tree: git history
> tools, real semantic code search (Semble sidecar with a persistent index),
> and a per-repo knowledge base (MongoDB Atlas Vector Search + Voyage
> embeddings) fed by explicit `@reviewer remember` commands and human
> corrections on findings — retrieved as few-shot examples that calibrate
> every following review.

> Closed 2026-08-05. All six planned cards plus KIT-041 (bug found by the
> e2e: clone never checked out the PR head) shipped; deep-context e2e green
> on minikube against real Voyage + vector-search Mongo. Known deviations
> from the original plan are recorded in each card's execution notes.

## Problem

v4's exploration tools are lexical: `find_related` is identifier matching,
`search` is regex. Three context classes stay out of reach:

1. **Semantic relatedness** — "code that does the same thing with different
   names" is invisible to regex.
2. **Temporal context** — churn, authorship, and the age of a line often
   decide whether a finding matters; the clone has full history nobody uses.
3. **Accumulated repo knowledge** — every review starts from zero. Human
   corrections ("this is intentional, stop flagging it") and team facts
   ("we always use X for Y") are lost the moment the Pod dies (invariant 5).

## Solution (v7 scope)

1. **Git history tools** — `git_log(path)` + `git_blame(path, startLine,
   endLine)` as read-only `McpTool`s in the existing registry (the clone
   already has full history). Same confinement, per-result caps.
2. **Semble sidecar** — a Python (uv) sidecar container in the reviewer Pod
   runs Semble over the shared clone volume; its index lives on a **PVC**
   keyed by repo + base branch, shared across runs (incremental re-index when
   the base moves). New `semantic_search` McpTool talks to the sidecar; the
   lexical `find_related`/`search` stay as fallback when the sidecar is
   absent/unhealthy.
3. **Knowledge base (Atlas + Voyage)** — per-repo `knowledge` collection:
   `{ repo, text, embedding, source: "command" | "correction", author,
   createdAt, prNumber? }`, Voyage code-model embeddings, Atlas Vector Search
   index. Written by: (a) **`@reviewer remember <text>`** PR comments (v5
   comment routing gains the command; the dispatcher writes directly — no
   live Pod needed); (b) **human replies correcting a finding** (webhook
   `pull_request_review_comment` on a reviewer thread → stored with
   `source: "correction"`).
4. **Few-shot retrieval** — at review start (both monolithic and agentic
   paths), top-K knowledge entries by vector similarity to the diff are
   injected as a "Repository knowledge" prompt block. Calibration without
   spending agentic turns.
5. **Degradation** — `MONGODB_URI`/`VOYAGE_API_KEY` unset or Atlas
   unreachable → knowledge pillars disabled with a warning; Semble sidecar
   unhealthy → lexical fallback. A review NEVER fails because deep context
   is unavailable.

## Invariant amendment (job isolation)

Invariant 5 ("no shared state between jobs") is amended in AGENTS.md:
filesystem/clone isolation stays absolute; cross-job state is allowed ONLY
in the two designated stores — the Semble index PVC (derived data, rebuildable
from the repo) and the Atlas knowledge collection (curated data). Nothing
else may persist across jobs.

## Implementation Cards

Execution order (sequential):

| Card | Story | Scope |
|---|---|---|
| [KIT-035](../features/KIT-035-git-history-tools.md) | [US-031](../../docs/stories/US-031-git-history-tools.md) | `git_log` + `git_blame` McpTools |
| [KIT-036](../features/KIT-036-semble-sidecar.md) | [US-032](../../docs/stories/US-032-semantic-code-search.md) | Semble sidecar container, PVC index, `semantic_search` tool, lexical fallback |
| [KIT-037](../features/KIT-037-knowledge-store-remember.md) | [US-033](../../docs/stories/US-033-repository-knowledge.md) | shared Atlas+Voyage client, `remember` comment command |
| [KIT-038](../features/KIT-038-correction-capture.md) | [US-035](../../docs/stories/US-035-corrections-become-knowledge.md) | `pull_request_review_comment` webhook → corrections stored |
| [KIT-039](../features/KIT-039-knowledge-few-shot.md) | [US-034](../../docs/stories/US-034-knowledge-calibrated-reviews.md) | vector retrieval + "Repository knowledge" prompt block in both paths |
| [KIT-040](../features/KIT-040-deep-context-e2e.md) | [US-034](../../docs/stories/US-034-knowledge-calibrated-reviews.md) | e2e (minikube + Atlas), docs, invariant amendment, epic close gate |
| [KIT-041](../features/KIT-041-clone-checkout-headref.md) | bug found during KIT-040 | clone checks out the PR head branch (config/tools read the head, not the base) |

## Architecture

```
Reviewer Pod (v7)
 ├─ container: reviewer (node)      — pipeline + agentic loop
 │    tools: read_file, search, find_related, list_directory   (v4)
 │           git_log, git_blame                                 (KIT-035)
 │           semantic_search ──HTTP──▶ sidecar shim ──MCP/stdio──▶ semble  (KIT-036)
 └─ container: semble (python/uv)   — HTTP shim + Semble over /workspace clone
      index: PVC /semble-index/{repo}/{baseRef}                 (cross-run)

Dispatcher (v7)
 ├─ issue_comment "@reviewer remember <text>" ─▶ knowledge.insert (Atlas+Voyage)
 └─ pull_request_review_comment (human reply on reviewer thread)
      ─▶ knowledge.insert { source: "correction" }

Pipeline start (both paths)
 └─ knowledge.search(diff embedding, topK) ─▶ "Repository knowledge" block
```

## Stack

| Component | Technology | Verify before use |
|---|---|---|
| Semantic code index | Semble 0.5.3 (Python, via `uv`) sidecar; stdio-only MCP bridged by an HTTP shim (`docker/semble-sidecar/server.py`) | verified 2026-08-05 — findings in KIT-036 |
| Embeddings (knowledge) | Voyage `voyage-code-3` (1024 dims) via REST; `VOYAGE_BASE_URL=https://ai.mongodb.com` for Atlas-provisioned keys | verified 2026-08-05 — findings in KIT-037 |
| Vector store | MongoDB Atlas Vector Search, official node driver | index definition syntax — check current Atlas docs (Context7) |
| Secrets | `MONGODB_URI`, `VOYAGE_API_KEY` (cluster secrets, optional) | — |
| Index persistence | K8s PVC mounted in both containers | — |

## Error handling

| Error | Behavior |
|---|---|
| `MONGODB_URI`/`VOYAGE_API_KEY` unset | Knowledge pillars off, warning at boot; reviews unaffected |
| Atlas/Voyage call fails at review time | Warning log, empty knowledge block, review proceeds |
| Semble sidecar down/unhealthy | `semantic_search` returns `{ code: "SERVICE_UNAVAILABLE", message: "use search/find_related" }`; loop continues on lexical tools |
| `remember` with empty text | Ignored delivery + log |
| Correction reply by a bot | Ignored (same bot filter as v5) |
| PVC missing | Semble builds a fresh index in emptyDir (slower, no persistence), warning |

Structured errors everywhere: `{ code, message, details }`.

## Recorded decisions (v7 brainstorm — 2026-08-05)

| # | Question | Decision |
|---|---|---|
| D1 | Scope | All four pillars: git history, semantic code search, knowledge base, few-shot calibration. |
| D2 | Code embeddings engine | **Semble sidecar** (Python/uv container in the Pod, shared clone volume, PVC index keyed by repo+base branch, incremental on base change). Central Semble deployment rejected — cannot reach the Pod's clone. Fat single image rejected — image bloat. |
| D3 | Knowledge store | **Atlas Vector Search + Voyage embeddings** — knowledge (curated facts/corrections), NOT code. Code embeddings stay in Semble. |
| D4 | Feedback signals | Human replies correcting a finding + explicit `@reviewer remember`. Reactions/resolved-threads rejected (noisy) for v7. |
| D5 | Learning application | Few-shot prompt block (top-K vector retrieval vs diff). Tool-based and post-filter rejected. |
| D6 | Invariant 5 | Amended: cross-job state only via designated stores (Semble PVC + Atlas knowledge). Filesystem isolation unchanged. |

## What is NOT in v7 (out-of-scope)

- Reactions (👍/👎) or resolved-thread mining as feedback signals
- Post-review finding suppression/filtering by knowledge
- Knowledge curation UI, TTL/expiry, cross-repo knowledge sharing
- Semble for the KNOWLEDGE base (it indexes code, not curated text)
- Multi-tenant Atlas separation (v6/v8 concern)

## Testing strategy

| Level | What |
|---|---|
| Unit | git tools (caps, confinement, missing history), semantic_search client (sidecar up/down/fallback), knowledge client (insert/search mocked driver), remember/correction parsing, few-shot block building (present/empty/error) |
| Integration | real Voyage embed + real Atlas insert/search against a test cluster (skipped without secrets — v3 DEEPSEEK pattern); Semble sidecar smoke against a fixture repo |
| E2E | minikube: remember via simulated webhook → knowledge in Atlas → next review prompt carries it; semantic_search answers during an agentic review; sidecar killed → review still completes |

Coverage target: 80%+ on touched packages.
