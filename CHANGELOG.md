# Changelog

All notable changes to Kitten are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Kitten is developed epic by epic; each epic ships a complete vertical slice. Epic specs
live in `.devtool/epics/`, the stories they implement in `docs/stories/`.

---

## [Unreleased]

### Added

- **v10 — Shared-cluster deployment** *(in progress)*. Kitten becomes a well-behaved
  tenant of a cluster it does not own.
  - `REVIEWER_POD_SCHEDULING` — a JSON environment variable on the dispatcher
    steering where reviewer Pods are scheduled: `nodeSelector`, `tolerations` and
    `serviceAccountName`, Zod-validated at boot. Absent → unchanged Pod spec;
    present and invalid → the dispatcher exits 1 (rollout blocked).
  - `deploy/shared-cluster/` — a kustomize overlay (a sibling of `k8s/`) that
    patches the dispatcher Service to `ClusterIP`, pins the Semble index PVC's
    `storageClassName` and ships an Ingress template.
  - `KUSTOMIZE_PATH` in `deploy.yml` (default `k8s`) so CI deploys can apply the
    overlay instead of silently reverting it.
- **Open-source documentation set** — `LICENSE` (Apache-2.0), `CONTRIBUTING.md`,
  `SECURITY.md`, this changelog, and `docs/`: `architecture.md`, `api.md`,
  `configuration.md`, `deployment.md`, `agentic-review.md`, `deep-context.md`. `README.md`
  rewritten.
- **v9 — Automated EKS deploy** *(in progress)*. `scripts/eks-setup.sh` bootstraps a
  live EKS cluster idempotently: GitHub OIDC provider, a narrowly-trusted IAM deploy
  role (ECR push + `eks:DescribeCluster`), `aws-auth` mapping to the `kitten-ci-deploy`
  group, base infrastructure via `kubectl apply -k k8s`, real Secrets from exported
  environment variables, and the three ECR repositories.
  - `k8s/kustomization.yaml` — the canonical "apply all infra" entrypoint, deliberately
    excluding `secret.yaml` so CI can never clobber live Secrets.
  - `k8s/eks-deploy-rbac.yaml` — ClusterRole/Binding for the deploy group; read-only on
    Secrets and ConfigMaps.
  - `.github/workflows/ci.yml` — lint, test and build on pull requests and pushes.
  - `.github/workflows/deploy.yml` — builds and pushes the three images to ECR tagged
    with the commit SHA, applies the manifests and rolls out the dispatcher.
  - `KUBE_CONTEXT` support in `cleanup-pods.sh`, `e2e-test.sh`, `webhook-e2e.sh` and
    `deep-context-e2e.sh` (default `minikube`).

### Fixed

- The CI and deploy workflows triggered on `main`, and the IAM trust policy in
  `eks-setup.sh` admitted only `refs/heads/main` — but the repository's default branch
  is `master`, so the deploy could never fire. Both now target `master`, and the trust
  branch is configurable via `DEPLOY_BRANCH`.
- Both workflows used `pnpm/action-setup@v4` with no `version` input while
  `package.json` declares no `packageManager` field, which the action requires one of.
  Pinned to `version: 11`.
- `scripts/eks-setup.sh` was committed without the executable bit, so the documented
  `./scripts/eks-setup.sh` invocation failed.
- `.reviewer.yml.example` used the pre-v3 key `max_tokens`, which the strict config
  schema rejects — copying the example silently produced a `VALIDATION` error and a
  review that ran on defaults.

### In progress

- **v8 — Agent security guardrails.** `.gitignore` and sensitive-path exclusion applied
  at every ingestion layer, secret rejection in the knowledge store, follow-up output
  guards, and prompt-injection resistance. Known gaps this epic closes are documented in
  [SECURITY.md](SECURITY.md#known-limitations).

---

## [0.0.1] — 2026-08-05

First tagged release. Everything below shipped across epics v1–v7.

### Added

#### Review engine

- **Real LLM reviews** producing structured `Finding[]` through native provider
  structured output — Anthropic tool use, OpenAI `json_schema`.
- **Multi-vendor support.** `provider` selects the SDK, `base_url` selects the API key,
  from an exact-match table (Anthropic, DeepSeek's Anthropic-compatible endpoint,
  OpenAI). An unmapped URL fails fast rather than sending a key to an arbitrary host.
- **Inline diff comments.** Findings anchoring inside a diff hunk become inline review
  comments; the rest go into a Markdown table in the review body, so none are lost.
- **Chunked multi-round review** for PRs over the token budget, with cross-chunk
  consolidation (dedup on `file:line`, highest severity wins) and per-chunk failure
  containment.
- **Custom review rules** from `.reviewer.yml`, with attribution validated against the
  declared rule ids.
- **Configurable output language**, with machine-readable fields explicitly excluded
  from translation.
- **Blocking review mode** (`comment_only` / `request_changes`), with a visible,
  explained downgrade when GitHub rejects a self-authored change request.

#### The agent

- **One ephemeral Pod per review**, `restartPolicy: Never`, isolated clone, cleanup
  guaranteed in a `finally` block.
- **Agent lifecycle** — the Pod stays alive after posting, answers follow-up questions
  with the review still in context, and shuts down on an idle timer or SIGTERM.
- **`force` and `stop` commands**, with `stop` aborting between chunks or agentic turns.
- **Live re-review on push** — a new commit on a PR with a live Pod re-runs the pipeline
  in that same Pod; concurrent pushes collapse into at most one queued re-run.

#### Agentic review (opt-in)

- **Multi-turn exploration loop** driven by `.reviewer-mcp.json`, bounded by `maxTurns`,
  with a forced finalize turn, self-correction on invalid findings, and real per-turn
  token accounting.
- **Seven read-only tools** — `read_file`, `search`, `find_related`, `list_directory`,
  `git_log`, `git_blame`, `semantic_search` — each root-confined and individually capped.
- **Path confinement** rejecting traversal, absolute escapes and symlinks pointing
  outside the clone.
- **Regex timeout guard** — search matching runs inside a `vm.Script` with a 2-second
  budget, because catastrophic backtracking is uninterruptible from plain JavaScript.

#### GitHub integration

- **Signature-validated webhook** (`POST /webhook/github`), HMAC-SHA-256 over the exact
  raw bytes with a timing-safe comparison. No secret configured means `503`, never
  "accept everything".
- **Automatic review** on `opened`, `reopened` and `synchronize`.
- **Comment commands** — `@reviewer force | stop | remember <fact> | <question>`, with a
  mandatory bot filter so the reviewer cannot trigger itself.

#### Deep context

- **Git history tools** — enabled by the deliberate choice of a full, non-shallow clone.
- **Semantic code search** through a Semble sidecar sharing the clone volume, with the
  index persisted on a PVC keyed by repository and base branch.
- **Repository knowledge store** — MongoDB Atlas Vector Search with Voyage
  `voyage-code-3` embeddings, written by `@reviewer remember` and by human replies on
  findings, retrieved top-K by similarity to the diff and injected into both review
  paths as calibration that can only remove noise, never lower the precision bar.

#### Infrastructure

- Dispatcher HTTP API: `/health`, `/review`, `/status/:jobId`, `/review/:jobId/message`.
- Redis for job status and pub/sub command delivery.
- `scripts/minikube-setup.sh` plus three end-to-end suites and a Pod cleanup script.
- Docker Compose stack with a vector-search-capable local MongoDB and an opt-in
  cloudflared tunnel profile.

### Fixed

- The clone now checks out the PR head branch, so everything read from the worktree —
  `.reviewer.yml`, `.reviewer-mcp.json`, the conventions file, every agentic tool read —
  sees the head rather than the default branch.
- The agentic prompt is guarded by `max_context_tokens`, truncating an oversized diff
  and inviting `force` instead of overflowing.
- Token accounting in the agentic loop reports real usage summed across turns.

### Security

- Clone URLs carry the token, so every clone error path replaces it with `***` before
  the message is built.
- Tool results are never logged; tool inputs are logged truncated.
- Kubernetes Secrets are referenced via `secretKeyRef`; `k8s/secret.yaml` holds only
  placeholders.
- Dispatcher RBAC is scoped to Pod management in the `kitten` namespace.

### Known limitations

Documented in full in [SECURITY.md](SECURITY.md#known-limitations). In short: repository
exclusions are enforced only in the agentic tool layer, the knowledge store accepts
unfiltered text, follow-up answers are not scanned before posting, repository files are
treated as trusted prompt input, the operational endpoints are unauthenticated, and
every posted comment carries a `[KITTEN-TEST]` marker.

---

[Unreleased]: https://github.com/XamuAvila/codekitten/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/XamuAvila/codekitten/releases/tag/v0.0.1
