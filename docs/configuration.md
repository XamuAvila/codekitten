# Configuration

Kitten is configured at two levels, and the split matters:

| Level | Owned by | Files |
|---|---|---|
| **Review contract** — model, language, budgets, rules, exclusions | The repository being reviewed | `.reviewer.yml`, `.reviewer-mcp.json` at the clone root |
| **Deployment** — where things run, which credentials exist | The Kitten operator | Environment variables and Kubernetes Secrets |

One Kitten deployment therefore serves repositories that each want a different model,
language and budget, without redeploying anything.

---

## Table of contents

- [`.reviewer.yml`](#revieweryml)
  - [Full key reference](#full-key-reference)
  - [Choosing a provider](#choosing-a-provider)
  - [Skip patterns](#skip-patterns)
  - [Custom rules](#custom-rules)
  - [Blocking mode](#blocking-mode)
  - [Parsing behavior](#parsing-behavior)
- [`.reviewer-mcp.json`](#reviewer-mcpjson)
- [Environment variables](#environment-variables)
  - [Dispatcher](#dispatcher)
  - [Reviewer Pod scheduling](#reviewer-pod-scheduling)
  - [Reviewer Pod](#reviewer-pod)
  - [Semble sidecar](#semble-sidecar)
- [Kubernetes Secrets](#kubernetes-secrets)
- [Resource limits](#resource-limits)
- [Configuration decision table](#configuration-decision-table)

---

## `.reviewer.yml`

Placed at the root of the repository being reviewed. Every key is optional; anything
absent falls back to the default. **Keys are `snake_case`, nested under a top-level
`reviewer:` key.**

```yaml
reviewer:
  provider: anthropic
  base_url: https://api.deepseek.com/anthropic
  language: en
  model: deepseek-v4-flash
  max_context_tokens: 1000000
  max_output_tokens: 16000
  max_findings: 20
  max_complexity: 10
  trigger: "@reviewer"
  blocking: comment_only
  skip:
    - "**/Migrations/**"
    - "*.Designer.cs"
    - "**/*.snap"
    - "**/node_modules/**"
  conventions_file: CLAUDE.md
  knowledge_top_k: 5
  rules:
    - id: no-raw-sql
      description: Database access must go through the repository layer, never raw SQL.
```

### Full key reference

| Key | Type | Default | What it does |
|---|---|---|---|
| `provider` | `"anthropic"` \| `"openai"` | `anthropic` | Selects which **SDK** is used. Not which vendor — DeepSeek is `anthropic` plus a DeepSeek `base_url`. |
| `base_url` | URL | `https://api.deepseek.com/anthropic` | The provider endpoint. Also selects which API key env var is read (see below). Omitting it in a file that sets `provider` resolves to that provider's official URL. |
| `language` | non-empty string | `en` | The language of every piece of prose the model writes: finding descriptions, suggestions and follow-up answers. Machine-readable values (`severity`, `file`, `line`) are never translated — the prompt says so explicitly, because a model told to write Portuguese will happily return `severity: "alto"` and fail schema validation. |
| `model` | non-empty string | `deepseek-v4-flash` | Model identifier, passed through verbatim to the provider. |
| `max_context_tokens` | positive integer | `1000000` | Total prompt budget. Exceeding it triggers chunking (monolithic mode) or diff truncation (agentic mode). Estimation is `characters / 4`, with a 90% safety margin applied when packing chunks. |
| `max_output_tokens` | positive integer | `16000` | Per-request output cap sent to the provider. |
| `max_findings` | positive integer | `20` | Stated in the system prompt as a hard ceiling, prioritized by severity. A guardrail against noisy reviews, not a post-filter. |
| `max_complexity` | positive integer | `10` | Cyclomatic complexity threshold the model is told to flag when the complexity actually harms maintainability. |
| `trigger` | non-empty string | `"@reviewer"` | Recorded in the resolved config. **The webhook's trigger word comes from the dispatcher's `TRIGGER_WORD` environment variable**, not from this key — the dispatcher routes comments before any clone exists, so it cannot read this file. |
| `blocking` | `"comment_only"` \| `"request_changes"` | `comment_only` | The GitHub review action. See [Blocking mode](#blocking-mode). |
| `skip` | string[] (globs) | `["**/Migrations/**", "*.Designer.cs", "**/*.snap", "**/node_modules/**"]` | Files excluded from the review. See [Skip patterns](#skip-patterns). |
| `conventions_file` | non-empty string | `CLAUDE.md` | A file read from the clone root and injected into the prompt as "Repository conventions". Absent → the block is omitted. |
| `knowledge_top_k` | positive integer | `5` | How many knowledge entries are retrieved by similarity to the diff and injected as context. |
| `rules` | array of `{ id, description }` | `[]` | Repository-specific review criteria. See [Custom rules](#custom-rules). |

### Choosing a provider

`provider` picks the SDK; `base_url` picks the API key. They are separate because
several vendors ship an Anthropic- or OpenAI-compatible endpoint, and the key must
follow the URL, not the SDK.

| `base_url` | Key read from | `provider` |
|---|---|---|
| `https://api.anthropic.com` | `ANTHROPIC_API_KEY` | `anthropic` |
| `https://api.deepseek.com/anthropic` | `DEEPSEEK_API_KEY` | `anthropic` |
| `https://api.openai.com` | `OPENAI_API_KEY` | `openai` |

Any other `base_url` fails fast with `VALIDATION: No API key mapping for base_url` —
no mapping exists, and guessing would send the wrong vendor your key. A mapped URL
whose key env var is empty fails with `AUTH_FAILED`.

> **DeepSeek note.** DeepSeek's Anthropic-compatible endpoint runs thinking mode by
> default, and its thinking mode rejects forced `tool_choice` with a `400`. The adapter
> sends `thinking: { type: "disabled" }` for that base URL specifically. Nothing to
> configure — but it explains why the DeepSeek path is special-cased in the code.

Example — Anthropic directly:

```yaml
reviewer:
  provider: anthropic
  base_url: https://api.anthropic.com
  model: claude-sonnet-5
```

Example — OpenAI:

```yaml
reviewer:
  provider: openai
  base_url: https://api.openai.com
  model: gpt-4o
```

### Skip patterns

`skip` is a list of [picomatch](https://github.com/micromatch/picomatch) globs matched
with `dot: true`, so dotfiles are matched normally.

> ⚠️ **Known limitation as of `0.0.1`: `skip` only takes effect in the agentic tool
> layer.** The changed-file list is fetched with an empty pattern array
> (`PipelineConfig.skipPatterns` is hardcoded to `[]` in
> `packages/reviewer/src/index.ts`), so in the **monolithic path the exclusions are
> dormant** — every changed file is read and sent to the model regardless of what you
> configure here. The startup log line `skip=N patterns` reports what was parsed, not
> what is enforced. Closing this gap is the first pillar of the in-progress v8 epic;
> see [SECURITY.md](../SECURITY.md#known-limitations).

Where the patterns are enforced today:

| Layer | Enforced? |
|---|---|
| Agentic tools — `read_file`, `search`, `find_related`, `list_directory`, `git_log`, `git_blame` | ✅ yes, on every call |
| `.git/` in the agentic tool layer | ✅ always, regardless of configuration |
| Changed-file list from the GitHub API | ❌ not yet |
| Full-content reads in the monolithic path | ❌ not yet |
| The raw diff | ❌ not yet |
| The Semble index | ❌ not yet — the sidecar honors only the reviewed repo's own ignore files |

`.reviewer-mcp.json`'s `search.skip` is **additive** to this list, not a replacement.

Setting `skip: []` explicitly disables all exclusions, including the defaults.

### Custom rules

```yaml
reviewer:
  rules:
    - id: no-raw-sql
      description: Database access must go through the repository layer, never raw SQL.
    - id: api-versioning
      description: New public endpoints must be added under /v2, never /v1.
```

Both fields are required and must be non-empty. Declared rules become a
"Reviewer rules" block in the prompt and unlock a `REPOSITORY RULES` section in the
system prompt instructing the model to set `ruleId` when a finding exists *because* a
declared rule was broken.

Attribution is validated: a finding citing an id the repository never declared keeps
the finding and **loses only the attribution**, with a warning logged. The finding may
still be real; discarding it would throw away signal.

When `rules` is empty the whole block is omitted from the prompt — asking for `ruleId`
with no valid ids to cite invites invented ones.

Rule ids appear in the PR output next to the severity: `high (no-raw-sql)`.

### Blocking mode

| Value | GitHub review action |
|---|---|
| `comment_only` (default) | `COMMENT` — advisory, does not gate the merge. |
| `request_changes` | `REQUEST_CHANGES` — gates the merge under branch protection. |

GitHub rejects `REQUEST_CHANGES` with a `422` when the review would be submitted by the
same account that opened the pull request. Kitten retries as a `COMMENT` and appends a
visible warning saying the merge is **not** gated — silently downgrading would leave a
maintainer believing they had a gate they do not have.

A `422` caused by anything else (a bad inline anchor, a missing body) fails again on
the retry and propagates. That is deliberate: matching GitHub's error prose to detect
the self-review case would break the moment they reword it.

### Parsing behavior

| Situation | Result |
|---|---|
| File absent | `DEFAULT_CONFIG`, logged as "not found, using defaults". |
| File empty, or parses to `null` | `DEFAULT_CONFIG`. |
| File present without a `reviewer:` key | `DEFAULT_CONFIG`. |
| Invalid YAML | `AppError(VALIDATION)` — **swallowed by the reviewer, which falls back to `DEFAULT_CONFIG`.** |
| **Unknown key** under `reviewer:` | `AppError(VALIDATION)` — the schema is strict, unknown keys are rejected rather than silently stripped. Same swallow-and-default outcome. |
| Wrong type or out-of-range value | `AppError(VALIDATION)`, same outcome. |

> ⚠️ **A malformed `.reviewer.yml` never fails a review — it is silently ignored.**
> The review still runs, but on defaults: possibly the wrong model, the wrong language
> and no exclusions. Validate changes to this file before relying on them. Legacy keys
> from earlier versions (`max_tokens`, replaced by `max_context_tokens` and
> `max_output_tokens`) are exactly the trap this rejects.

---

## `.reviewer-mcp.json`

Opt-in agentic review. Placed at the repository root. **Keys are `camelCase` and there
is no wrapper object** — deliberately different from `.reviewer.yml`, and worth
double-checking when writing one by hand.

This file is *additive*: it widens or narrows tool behavior only. It can never change
the provider, model, language or blocking mode — those stay in `.reviewer.yml`.

Minimal:

```json
{ "enabled": true }
```

Complete, with every default made explicit:

```json
{
  "enabled": true,
  "tools": [
    "read_file", "search", "find_related", "list_directory",
    "git_log", "git_blame", "semantic_search"
  ],
  "maxTurns": 12,
  "forceMaxTurns": 60,
  "read":           { "maxLines": 200, "maxFileBytes": 262144 },
  "search":         { "maxResults": 30, "contextLines": 2, "caseSensitive": false, "skip": [] },
  "findRelated":    { "maxResults": 20 },
  "listDirectory":  { "maxEntries": 100 },
  "gitLog":         { "maxCommits": 20 },
  "gitBlame":       { "maxLines": 200 },
  "semanticSearch": { "maxResults": 10 }
}
```

| Key | Type | Default | What it does |
|---|---|---|---|
| `enabled` | boolean | `false` | `false` (or file absent) → the monolithic review path. |
| `tools` | array of tool names | all seven | Whitelist. A tool not listed is never offered to the model. `semantic_search` is additionally dropped when no Semble sidecar is configured. |
| `maxTurns` | positive integer | `12` | Tool rounds in a normal review. The last round is forced to `report_findings`. |
| `forceMaxTurns` | positive integer | `60` | Turn budget used when a reviewer replies `force`. |
| `read.maxLines` | positive integer | `200` | Lines returned per `read_file` call. |
| `read.maxFileBytes` | positive integer | `262144` (256 KiB) | Byte cap on `read_file` output. Also the size above which `search` skips a file entirely rather than partially matching it. |
| `search.maxResults` | positive integer | `30` | Matches returned per `search`. |
| `search.contextLines` | non-negative integer | `2` | Context lines around each match. |
| `search.caseSensitive` | boolean | `false` | Default case sensitivity. The model may override it per call. |
| `search.skip` | string[] (globs) | `[]` | Extra exclusions, **added to** `.reviewer.yml`'s `skip`. |
| `findRelated.maxResults` | positive integer | `20` | Occurrences returned per `find_related`. |
| `listDirectory.maxEntries` | positive integer | `100` | Entries per `list_directory`. |
| `gitLog.maxCommits` | positive integer | `20` | Commits per `git_log`. |
| `gitBlame.maxLines` | positive integer | `200` | Lines per `git_blame`. |
| `semanticSearch.maxResults` | positive integer | `10` | Results per `semantic_search`. |

**Parsing behavior:** the schema is strict at every level — an unknown key anywhere
raises `VALIDATION`. Invalid JSON or a schema violation is logged as a warning and the
review **falls back to the monolithic path**. A bad config file never fails a review.

Details of the loop and every tool: [agentic-review.md](agentic-review.md).

---

## Environment variables

### Dispatcher

Read once at startup (`packages/dispatcher/src/index.ts`).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | HTTP listen port. |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection. Also injected into every reviewer Pod, so it must be resolvable **from inside the cluster** (`redis://redis.kitten.svc.cluster.local:6379`). |
| `K8S_NAMESPACE` | `kitten` | Namespace where reviewer Pods are created. |
| `REVIEWER_IMAGE` | `kitten-reviewer:latest` | Image for the reviewer container. |
| `POD_IDLE_TIMEOUT_MS` | `600000` (10 min) | How long a Pod stays alive with no follow-up before shutting down. Injected into the Pod. |
| `WEBHOOK_SECRET` | *(unset)* | GitHub webhook HMAC secret. **Unset → `POST /webhook/github` answers `503`**, and a warning is logged at boot. |
| `TRIGGER_WORD` | `@reviewer` | Prefix that turns a PR comment into a command. This is the value that actually governs webhook routing. |
| `GITHUB_TOKEN` | *(unset)* | Used only to fetch the root comment during correction capture. Unset → the lookup runs unauthenticated and will usually fail on a private repo. |
| `SEMBLE_IMAGE` | *(unset)* | Semble sidecar image. **Unset disables the sidecar entirely** — no `semantic_search` tool, no shared workspace volume. |
| `SEMBLE_INDEX_PVC` | *(unset)* | PVC name for the persistent index. Unset → `emptyDir`, i.e. a fresh index every run. |
| `REVIEWER_POD_SCHEDULING` | *(unset)* | JSON steering where reviewer Pods are scheduled — `nodeSelector`, `tolerations` and `serviceAccountName`. Absent/empty → no constraints, the Pod spec is unchanged. **Present and invalid → the dispatcher exits 1 at boot** — see [Reviewer Pod scheduling](#reviewer-pod-scheduling). |
| `MONGODB_URI` | *(unset)* | Knowledge store connection string. |
| `VOYAGE_API_KEY` | *(unset)* | Voyage embeddings key. |
| `VOYAGE_BASE_URL` | `https://api.voyageai.com` | Override for Voyage keys provisioned through MongoDB Atlas, which only work against `https://ai.mongodb.com`. Keys created at voyageai.com need no override. |

`MONGODB_URI` **and** `VOYAGE_API_KEY` must both be set for the knowledge store to
activate. With either missing, `createKnowledgeClient` returns `undefined`, a warning
is logged, and `remember` / correction capture / few-shot injection all stay off.

### Reviewer Pod scheduling

Steers **where reviewer Pods are scheduled** — the only part of the Pod manifest no
kustomize overlay can reach, because it is generated in TypeScript
(`packages/dispatcher/src/k8s/manifest.ts`). One environment variable carrying a JSON
object (v10):

```json
{
  "nodeSelector": { "workload-type": "kitten" },
  "tolerations": [
    { "key": "dedicated", "operator": "Equal", "value": "kitten", "effect": "NoSchedule" }
  ],
  "serviceAccountName": "kitten-reviewer"
}
```

| Field | Type | Meaning |
|---|---|---|
| `nodeSelector` | map of string → string | Pods only schedule on nodes carrying every label. |
| `tolerations` | array of objects | Tolerations for the taints on the target node group. Each may carry `key`, `operator` (`Equal`/`Exists`), `value`, `effect` (`NoSchedule`/`PreferNoSchedule`/`NoExecute`) and `tolerationSeconds`. Every field is optional because Kubernetes accepts e.g. `{ "operator": "Exists" }` alone to tolerate every taint. |
| `serviceAccountName` | non-empty string | The ServiceAccount the Pod runs as. **The ServiceAccount must already exist — Kitten creates none.** The reviewer needs no Kubernetes permissions, so the only reason to set this is to move off the namespace `default` ServiceAccount. A missing account is rejected with `error looking up service account kitten/<name>`. |

Absent or empty `REVIEWER_POD_SCHEDULING` means "no constraints": the Pod spec is
byte-identical to what Kitten shipped before v10. **Present but invalid — malformed
JSON, an unknown key such as `nodeSelectors`, or a value outside the allowed sets —
the dispatcher logs a `VALIDATION` error and exits 1 at boot.** The rollout stalls and
the previous ReplicaSet keeps serving. This deliberately breaks the
degrade-with-a-warning pattern of the optional capabilities above: ignoring broken
scheduling would put review Pods on production nodes — precisely the outcome the
setting exists to prevent.

### Reviewer Pod

Injected by the dispatcher through the Pod manifest. Not something you set by hand,
but worth knowing when reading Pod specs or debugging.

**Required** — all eight must be present or the container logs the missing names and
exits with code 1:

| Variable | Source |
|---|---|
| `REVIEW_JOB_ID` | Pod manifest (the deterministic job id) |
| `REVIEW_REPO` | Pod manifest |
| `REVIEW_PR_NUMBER` | Pod manifest — must parse as a positive integer |
| `REVIEW_HEAD_REF` | Pod manifest |
| `REVIEW_BASE_REF` | Pod manifest |
| `REVIEW_SENDER` | Pod manifest |
| `REDIS_URL` | Pod manifest (copied from the dispatcher's config) |
| `GITHUB_TOKEN` | Secret `kitten-github-token`, key `token` |

**Optional:**

| Variable | Source | Effect when absent |
|---|---|---|
| `POD_IDLE_TIMEOUT_MS` | Pod manifest | Falls back to the built-in 600000 ms. |
| `CLONE_DIR` | Pod manifest, **only when the sidecar is enabled** (`/workspace/repo`) | Falls back to `/tmp/clones/{jobId}`. The fixed path matters because Semble's index key hashes the absolute clone path — it must be identical across runs. |
| `SEMBLE_SIDECAR_URL` | Pod manifest, only with the sidecar (`http://127.0.0.1:8765`) | `semantic_search` is not registered. |
| `ANTHROPIC_API_KEY` | Secret `kitten-llm-keys` | Only needed if a repo targets that base URL. |
| `OPENAI_API_KEY` | Secret `kitten-llm-keys` | idem |
| `DEEPSEEK_API_KEY` | Secret `kitten-llm-keys` | idem |
| `MONGODB_URI` | Secret `kitten-knowledge-secrets` (`optional: true`) | Knowledge disabled with a warning. |
| `VOYAGE_API_KEY` | Secret `kitten-knowledge-secrets` (`optional: true`) | idem |
| `VOYAGE_BASE_URL` | Secret `kitten-knowledge-secrets` (`optional: true`) | Defaults to `https://api.voyageai.com`. |

All three LLM key entries are mounted unconditionally; the reviewer resolves at runtime
which one it actually needs from the repository's `base_url`.

### Deployment tooling

Not read by the application — consumed by the setup scripts and CI workflows.

| Variable | Default | Used by | Purpose |
|---|---|---|---|
| `KUBE_CONTEXT` | `minikube` | `cleanup-pods.sh`, `e2e-test.sh`, `webhook-e2e.sh`, `deep-context-e2e.sh` | The `kubectl` context every call is pinned to. Set it to target EKS. `minikube-setup.sh` is minikube-only and ignores it. |
| `DISPATCHER_URL` | `minikube service …` | the E2E scripts | Base URL of the dispatcher. Required outside minikube. |
| `IDLE_TIMEOUT` | `30` | `e2e-test.sh` | Seconds the test waits for the idle shutdown. |
| `K8S_NAMESPACE` | `kitten` | `cleanup-pods.sh` | Namespace to clean. |
| `EKS_CLUSTER` | — | `eks-setup.sh` | **Required.** Cluster name. |
| `EKS_REGION` | — | `eks-setup.sh` | **Required.** AWS region. |
| `GITHUB_REPO` | — | `eks-setup.sh` | **Required.** `owner/repo` for the OIDC trust. |
| `ROLE_NAME` | `kitten-gh-actions-deploy` | `eks-setup.sh` | IAM deploy role name. |
| `DEPLOY_BRANCH` | `master` | `eks-setup.sh` | The only branch allowed to assume the deploy role. **Must match the trigger in `.github/workflows/deploy.yml`.** |
| `CI_RBAC_FILE` | `k8s/eks-deploy-rbac.yaml` | `eks-setup.sh` | Override the CI RBAC manifest. |
| `KUSTOMIZE_PATH` | `k8s` | `.github/workflows/deploy.yml` | The manifest path CI applies on every push. Set it to `deploy/shared-cluster` for a cluster Kitten does not own, or every deploy reverts the overlay. |
| `WEBHOOK_SECRET` | generated | both setup scripts | Pass an existing value to keep it stable across re-runs. |

**GitHub repository settings** the deploy workflow reads (printed by `eks-setup.sh`):

| Kind | Name | Purpose |
|---|---|---|
| Secret | `AWS_ROLE_ARN` | The role assumed through OIDC. No long-lived AWS keys are stored. |
| Variable | `AWS_REGION` | Region for ECR and EKS calls. |
| Variable | `EKS_CLUSTER` | Cluster the deploy targets. |

### Semble sidecar

| Variable | Default | Purpose |
|---|---|---|
| `REPO_PATH` | `/workspace/repo` | The shared clone path. Set by the Pod manifest to match `CLONE_DIR`. |
| `SEMBLE_CACHE_LOCATION` | *(set by the manifest)* | Index directory: `/semble-index/{repo-with-dashes}/{baseRef}`. |
| `HF_HOME` | `/semble-index/.hf-cache` | Embedding-model cache **on the PVC**. Without this every Pod re-downloads the model and the first search times out. |
| `PORT` | `8765` | Listen port inside the Pod's network namespace. |

---

## Kubernetes Secrets

`k8s/secret.yaml` is a **template with placeholder values** — never apply it as-is in
anything but a throwaway cluster. `scripts/minikube-setup.sh` and `scripts/eks-setup.sh`
create the real Secrets from your exported environment variables.

It is also deliberately **excluded from `k8s/kustomization.yaml`**, so `kubectl apply -k
k8s` — the command both the setup script and the CI deploy run — can never overwrite
live Secrets with the placeholder.

| Secret | Keys | Required | Consumers |
|---|---|---|---|
| `kitten-github-token` | `token` | **yes** | dispatcher + reviewer |
| `kitten-llm-keys` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY` | at least one | reviewer |
| `kitten-webhook-secret` | `secret` | for webhooks | dispatcher (`optional: true`) |
| `kitten-knowledge-secrets` | `MONGODB_URI`, `VOYAGE_API_KEY`, `VOYAGE_BASE_URL` | no | dispatcher + reviewer (`optional: true`) |

Creating them by hand:

```bash
kubectl --context=minikube create secret generic kitten-github-token \
  --from-literal=token="$GITHUB_TOKEN" -n kitten \
  --dry-run=client -o yaml | kubectl --context=minikube apply -f -
```

The GitHub token needs to clone the repository, read pull requests, and post review
comments — `repo` scope on a classic token, or `Contents: read` + `Pull requests:
write` on a fine-grained one.

> `scripts/minikube-setup.sh` prints the webhook secret to stdout once, so you can
> paste it into GitHub. It is the only place that value is ever displayed.

---

## Resource limits

Defined in `k8s/dispatcher-deployment.yaml` and in the Pod manifest builder.

| Container | CPU request | CPU limit | Memory request | Memory limit |
|---|---|---|---|---|
| dispatcher | `100m` | `200m` | `128Mi` | `256Mi` |
| reviewer | `250m` | `1` | `512Mi` | `1Gi` |
| semble sidecar | `100m` | `500m` | `256Mi` | `1Gi` |

The Semble index PVC requests `5Gi` with `ReadWriteOnce`. It holds derived data and is
safe to delete — Semble rebuilds incrementally by file mtime.

Reviewer Pod resources are currently hardcoded in the manifest builder rather than
configurable. Large monorepos may need them raised in
`packages/dispatcher/src/k8s/manifest.ts`.

---

## Configuration decision table

Which knob to reach for:

| You want to… | Change |
|---|---|
| Use a different model for one repo | `.reviewer.yml` → `provider` + `base_url` + `model` |
| Get reviews in another language | `.reviewer.yml` → `language` |
| Stop reviewing generated code | `.reviewer.yml` → `skip` (agentic tool layer only — see the warning above) |
| Enforce a team rule the model does not know | `.reviewer.yml` → `rules` |
| Gate merges on the review | `.reviewer.yml` → `blocking: request_changes` |
| Let the reviewer explore the repo, not just the diff | `.reviewer-mcp.json` → `{"enabled": true}` |
| Let it explore *more* | `.reviewer-mcp.json` → `maxTurns` |
| Reduce cost on large PRs | `.reviewer.yml` → lower `max_context_tokens`, or enable agentic mode |
| Rename the trigger word | dispatcher env → `TRIGGER_WORD` |
| Keep Pods alive longer for conversation | dispatcher env → `POD_IDLE_TIMEOUT_MS` |
| Turn off semantic search | dispatcher env → unset `SEMBLE_IMAGE` |
| Turn off the knowledge store | dispatcher env → unset `MONGODB_URI` / `VOYAGE_API_KEY` |
