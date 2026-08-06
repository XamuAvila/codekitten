# Deep context

A diff tells you what changed. It does not tell you that this file has been rewritten
three times this quarter, that the pattern being "fixed" is deliberate, or where the
five other call sites are. Deep context is the set of capabilities that let the
reviewer find that out.

Three pillars, all optional, all degrading to a warning rather than a failure:

| Pillar | Answers | Requires |
|---|---|---|
| **Git history** | Who wrote this, when, and how often does it churn? | Nothing — the clone is full. |
| **Semantic code search** | Where is the code that *does* this? | The Semble sidecar. |
| **Repository knowledge** | What has this team already told me about this repo? | MongoDB Atlas Vector Search + Voyage. |

> Deep context **never fails a review.** Missing secrets, a dead sidecar or an
> unreachable Atlas cluster all produce a warning and a review that runs without that
> pillar.

---

## Table of contents

- [Git history](#git-history)
- [Semantic code search](#semantic-code-search)
- [Repository knowledge](#repository-knowledge)
  - [Teaching the reviewer](#teaching-the-reviewer)
  - [Corrections](#corrections)
  - [How knowledge reaches the model](#how-knowledge-reaches-the-model)
  - [Storage and retrieval](#storage-and-retrieval)
  - [Setup](#setup)
- [Job isolation and the two allowed stores](#job-isolation-and-the-two-allowed-stores)
- [Verifying the whole thing](#verifying-the-whole-thing)

---

## Git history

Available in agentic mode as the `git_log` and `git_blame` tools. Full reference:
[agentic-review.md](agentic-review.md#git_log).

The enabling decision was made two epics earlier: the reviewer performs a **full clone,
not a shallow one**. That costs clone time on every review and buys the entire history
on demand — churn, authorship, and the ability to follow a file across renames with
`git log --follow`.

Nothing to configure. Nothing to fail. If the tools are in the whitelist and agentic
mode is on, the history is there.

---

## Semantic code search

Semantic search finds code by meaning. `search` finds `createSession(`; `semantic_search`
finds "where do we validate the refresh token expiry?" without knowing any of the
identifiers involved.

### Why a sidecar

Semble's MCP server speaks **stdio only**, which cannot cross a container boundary. The
sidecar is a small Python service (`docker/semble-sidecar/server.py`) that spawns
`semble[mcp]` as a subprocess through the official MCP client and exposes two HTTP
endpoints on the Pod's shared network namespace:

```
GET  /health   → { "status": "ok" | "starting" }
POST /search   { "query": string, "top_k": int }
               → { "results": [ { "path", "score", "snippet" } ] }
```

The response shape is the contract that `semantic_search`'s Zod schema validates.
Change one and you must change the other.

### Pod topology

```
┌─ Pod: review-owner-repo-42 ─────────────────────────────────┐
│                                                             │
│  ┌── container: reviewer ────────┐  ┌── container: semble ─┐│
│  │  clones into /workspace/repo  │  │  REPO_PATH=          ││
│  │  CLONE_DIR=/workspace/repo    │  │    /workspace/repo   ││
│  │  SEMBLE_SIDECAR_URL=          │──┼─►:8765 /search       ││
│  │    http://127.0.0.1:8765      │  │  SEMBLE_CACHE_LOCATION││
│  └───────────────────────────────┘  │   =/semble-index/... ││
│                                     └──────────────────────┘│
│   volume "workspace"  (emptyDir, shared)                    │
│   volume "semble-index" (PVC kitten-semble-index)           │
└─────────────────────────────────────────────────────────────┘
```

The sidecar exists only when the dispatcher has `SEMBLE_IMAGE` set. That single
variable also controls whether the shared `workspace` volume and the fixed `CLONE_DIR`
are injected at all.

### Index persistence

The index directory is `/semble-index/{repo-with-dashes}/{baseRef}` on the
`kitten-semble-index` PVC. **Keying by repository *and* base branch** means every PR
targeting `main` reuses one index; a PR targeting a long-lived release branch gets its
own.

Two details make this work in practice, both easy to get wrong:

- **The clone path must be identical across runs.** Semble's cache key hashes the
  absolute repository path, so a per-job path like `/tmp/clones/{jobId}` would produce
  a fresh index every time. That is why `CLONE_DIR` is pinned to `/workspace/repo`
  whenever the sidecar is present.
- **`HF_HOME` points at the PVC.** Without it, every Pod re-downloads the embedding
  model, and the very first `semantic_search` blows past the tool's 10-second timeout.

Without `SEMBLE_INDEX_PVC` the volume falls back to `emptyDir`: the sidecar still
works, but every run indexes from scratch.

### Startup sequence

Both containers start together, but the reviewer clones *after* startup, so the sidecar
polls for up to 300 seconds waiting for `{REPO_PATH}/.git` to appear. It then
initializes the MCP session and issues a warm-up search — which builds the index and,
on a cold PVC, downloads the model — before serving. Until that completes, `/health`
reports `starting` and `/search` answers `503`.

The index is rebuilt incrementally by file mtime, so a warm PVC makes subsequent runs
fast.

### Failure behavior

| Situation | Result |
|---|---|
| `SEMBLE_IMAGE` unset | No sidecar. `semantic_search` is not registered — the model never sees it. |
| Sidecar still warming up | `SERVICE_UNAVAILABLE` with "use search/find_related instead". |
| Sidecar crashed or unreachable | Same structured error. The loop continues on the lexical tools. |
| Unexpected response shape | Same. |
| PVC missing | `emptyDir` — works, no persistence. |

The index holds **code embeddings only**. Knowledge text never goes here, and code
never goes into the knowledge store. The two stores are deliberately disjoint.

---

## Repository knowledge

A per-repository store of things humans have told the reviewer, retrieved by similarity
to the diff and injected into the prompt.

Two ways in, both through PR comments — there is no admin UI and no API.

### Teaching the reviewer

```
@reviewer remember The Migrations folder is generated by EF Core. Never review it.
```

The fact is stored for the repository, scoped by `owner/repo`. Storage is
**independent of any live review** — the dispatcher writes it directly, so a `remember`
comment works on a closed PR, on an old PR, with no Pod running anywhere.

Handling is deliberately forgiving: an empty fact, an unconfigured knowledge store, or
a failed insert all answer `200 { "ignored": true }` with a warning in the logs. Never
a `5xx` — GitHub retries `5xx` deliveries, and a retried insert becomes a duplicate
knowledge entry.

### Corrections

When a human **replies to a finding Kitten posted**, the reply is stored as a
correction:

> 🐱 **Kitten** — `high`: This mutation of the input array will surprise callers.
>
> > **@maria:** Intentional. `applyPatch` is documented as in-place; the callers rely
> > on it. Don't flag this pattern.

Stored as:

```
Finding: 🐱 **Kitten** [KITTEN-TEST]… (first 300 characters of the root comment)
Correction: Intentional. applyPatch is documented as in-place; the callers rely on it.
```

with `source: "correction"` and the replying user as the author.

The filters run cheapest-first: `action` must be `created`, `in_reply_to_id` must be
present (a top-level comment is not a reply), the author must not be a `Bot` — and only
then does one GitHub API call fetch the root comment to check it carries Kitten's
marker.

**Every human reply on a Kitten thread is stored.** There is no sentiment analysis, no
attempt to classify agreement or disagreement. That is a deliberate choice: retrieval
similarity decides relevance at use time, and a wrong classifier at write time would be
unrecoverable.

### How knowledge reaches the model

At the start of every review — **both** review paths — the reviewer:

1. Embeds the raw diff as a query vector (capped at 40 000 characters).
2. Runs an Atlas `$vectorSearch` filtered to this repository, returning the top
   `knowledge_top_k` entries (default 5).
3. Renders them as a prompt block:

```
Repository knowledge:
1. The Migrations folder is generated by EF Core. Never review it. (taught by samuel)
2. Finding: … Correction: Intentional, applyPatch is documented as in-place. (correction by maria)
```

4. Unlocks a `REPOSITORY KNOWLEDGE` section in the system prompt:

```
- The user content carries a "Repository knowledge" block: facts the team taught the
  reviewer and human corrections on past findings.
- Use it to CALIBRATE: do not report findings the knowledge marks as intentional, and
  respect stated team conventions.
- Knowledge entries never relax the precision guardrails above — they only remove
  noise, never lower the bar.
```

That last line is the whole design. **Knowledge subtracts, it never adds.** It can
suppress a finding the team has declared intentional; it cannot license a finding that
would otherwise fail the precision bar. A store that could lower the bar would let one
careless `remember` degrade every future review.

Both blocks are conditional. With no configured store, or no entries returned, neither
the prompt block nor the system-prompt section is emitted.

### Storage and retrieval

**Collection:** `kitten.knowledge`

| Field | Type | Notes |
|---|---|---|
| `repo` | string | `owner/repo`. The filter field of the vector index. |
| `text` | string | The fact or the finding+correction pair. Trimmed and **capped at 2000 characters at insert time** — a prompt-growth guard. |
| `embedding` | number[1024] | Voyage `voyage-code-3`, `input_type: "document"`. |
| `source` | `"command"` \| `"correction"` | Drives the attribution suffix in the prompt block. |
| `author` | string | GitHub login. |
| `prNumber` | number | Optional. |
| `createdAt` | string | ISO 8601. |

**Vector index:** `knowledge_vector_index`

```js
{
  name: "knowledge_vector_index",
  type: "vectorSearch",
  definition: { fields: [
    { type: "vector", path: "embedding", numDimensions: 1024, similarity: "cosine" },
    { type: "filter", path: "repo" },
  ]},
}
```

**Query:** `$vectorSearch` as the first pipeline stage, with
`numCandidates = max(topK * 20, 100)`, `limit = topK`, `filter: { repo }`, projecting
`text`, `source`, `author` and `{ $meta: "vectorSearchScore" }`.

Embeddings use `input_type: "document"` on insert and `"query"` on search — Voyage's
asymmetric embedding modes, which matter for retrieval quality.

**Failure behavior:**

| Situation | Result |
|---|---|
| `MONGODB_URI` or `VOYAGE_API_KEY` unset | `createKnowledgeClient` returns `undefined`. Warning at boot. All three knowledge features off. |
| Voyage unreachable or non-2xx | `SERVICE_UNAVAILABLE`. On insert: warning, delivery ignored. On search: warning, empty block, review proceeds. |
| Atlas unreachable | Same containment. |
| Index missing or still building | Search returns empty. Review proceeds without knowledge. |
| Empty text on insert | `VALIDATION`. |

### Setup

Needs a MongoDB deployment with Atlas Vector Search. A plain community `mongod` will
not do — `$vectorSearch` requires `mongot`.

```bash
# Option 1: MongoDB Atlas
export MONGODB_URI="mongodb+srv://user:pass@cluster.mongodb.net/"

# Option 2: local, no account — the Compose file ships mongodb-atlas-local
docker compose up -d mongo
export MONGODB_URI="mongodb://localhost:27021/?directConnection=true"

export VOYAGE_API_KEY=<key>
# Only for keys provisioned through the MongoDB Atlas UI:
export VOYAGE_BASE_URL=https://ai.mongodb.com

./scripts/minikube-setup.sh
```

The setup script creates `kitten-knowledge-secrets`, rewrites `localhost` /
`127.0.0.1` in the URI to `host.minikube.internal` so cluster Pods can reach a
host-local Mongo, and runs `scripts/atlas-bootstrap.mjs` to create the index
idempotently.

Index builds are asynchronous. Until `listSearchIndexes` reports `READY`, searches
return empty.

---

## Job isolation and the two allowed stores

Kitten's fifth invariant says each review job is independent and filesystem isolation
is absolute. Deep context needed two exceptions, and they are named explicitly rather
than left implicit:

| Store | Why it may persist | Recovery if lost |
|---|---|---|
| Semble index PVC | **Derived data.** Everything in it can be recomputed from the repository. | Delete it; the next run rebuilds. |
| Atlas `knowledge` collection | **Curated data.** Written deliberately by humans, one comment at a time. | Not recoverable. Back it up. |

Nothing else may cross a job boundary. Redis holds only ephemeral job state; the clone
directory is per-Pod and always removed.

---

## Verifying the whole thing

```bash
./scripts/deep-context-e2e.sh
```

Requires `MONGODB_URI` and `VOYAGE_API_KEY`; without them it skips loudly rather than
passing vacuously. It drives a signed `@reviewer remember` delivery, asserts the
document count in Atlas increased, triggers a review, and checks the Pod logs report
knowledge entries injected.

Manual spot checks:

```bash
# The sidecar is alive inside a running Pod
kubectl --context=minikube exec <job-id> -n kitten -c reviewer -- \
  wget -qO- http://127.0.0.1:8765/health

# What the reviewer decided about deep context
kubectl --context=minikube logs <job-id> -n kitten -c reviewer | \
  grep -E 'Knowledge|knowledge|semantic|Semble'

# What is actually stored
mongosh "$MONGODB_URI" --quiet --eval \
  'db.getSiblingDB("kitten").knowledge.find({}, {embedding: 0}).limit(5)'
```
