---
id: v9-eks-deploy
title: "v9: Automated EKS Deploy"
status: active
created: "2026-08-05"
---

# v9: Automated EKS Deploy

> The Kitten stack runs on a real EKS cluster with **one-time setup** and
> **automatic CI deploys**. The minikube path (v2) stays untouched and green;
> the EKS path reuses the same manifests, RBAC, Secrets and Pod orchestration —
> only the image supply and the bootstrapping differ.

## Problem

The only deployable environment today is minikube: `scripts/minikube-setup.sh`
builds the three images into minikube's own docker daemon and applies the
manifests with `kubectl --context=minikube`. Moving to EKS breaks in four
places:

1. **Images do not exist outside minikube.** `kitten-dispatcher:latest`,
   `kitten-reviewer:latest` and `kitten-semble-sidecar:latest` would be
   resolved against `docker.io` on EKS nodes. No CI pipeline, no registry push.
2. **Tag `latest` + `imagePullPolicy: IfNotPresent`** — a node that already
   pulled `latest` never pulls the new build. Idempotent deploys need an
   immutable tag (commit SHA).
3. **Secrets** are seeded by `minikube-setup.sh` only; `k8s/secret.yaml` is a
   `REPLACE_ME` placeholder template. No EKS bootstrap exists.
4. **Cluster-side authorization for CI** — GitHub Actions needs OIDC + an IAM
   role mapped into the cluster (aws-auth) with RBAC to apply manifests.

## Solution (v9 scope)

Two layers, configured once and then automatic:

- **`scripts/eks-setup.sh` — run once, manually.** Assumes a live EKS cluster
  (admin kubeconfig). Associates the OIDC provider, creates the GitHub Actions
  deploy IAM role (ECR push + `eks:DescribeCluster`), maps that role into the
  cluster via `eksctl create iamidentitymapping` → group `kitten-ci-deploy`,
  applies `k8s/eks-deploy-rbac.yaml` (that group's RBAC), creates the real
  Secrets from exported env vars, creates the ECR repos (idempotent), and does
  the first `kubectl apply -k k8s`.
- **GitHub Actions — automatic thereafter.** `ci.yml` (lint + test + build on
  PRs) and `deploy.yml` (on push to the deploy branch, `master` by default):
  OIDC → ECR login → build+push the
  three images tagged `${SHA}` → `kubectl apply -k k8s` →
  `kubectl set image`/`set env` to point the deployment at the ECR images →
  rollout status.

### Key decisions

- **Manifests stay where they are.** `k8s/*.yaml` is untouched — the minikube
  path (and every script/doc referencing those paths) keeps working. A new
  `k8s/kustomization.yaml` lists the non-secret resources so CI and
  `eks-setup.sh` can apply with `kubectl apply -k k8s`. `secret.yaml` is
  deliberately NOT in the kustomization — it is a placeholder applied only by
  the setup scripts, which overwrite it with real Secrets; the CI must never
  apply it.
- **Immutable SHA tags, not `Always`.** Each deploy points the dispatcher at
  `…/kitten-*:<sha>` (container image + `REVIEWER_IMAGE` + `SEMBLE_IMAGE` env
  vars). `IfNotPresent` is fine because the tag is unique per build. The
  versioned `k8s/` manifests keep `latest` for the minikube/dev path.
- **No `imagePullSecrets`.** eksctl-managed node groups ship with
  `AmazonEC2ContainerRegistryReadOnly` attached — ECR pulls authenticate via
  the node IAM role.
- **`KUBE_CONTEXT` env var** on the operator scripts
  (`cleanup-pods.sh`, `e2e-test.sh`, `webhook-e2e.sh`, `deep-context-e2e.sh`),
  defaulting to `minikube` — same scripts work against EKS by exporting
  `KUBE_CONTEXT=arn:aws:eks:…`.

### Bootstrapping sequence (eks-setup.sh)

```
admin kubectl (cluster creator)
  → aws eks update-kubeconfig
  → eksctl utils associate-iam-oidc-provider
  → aws iam create-role kitten-gh-actions-deploy
      trust: token.actions.githubusercontent.com, sub repo:<owner>/<repo>:ref:refs/heads/${DEPLOY_BRANCH}  (default master)
      policy: ECR push (3 repos) + eks:DescribeCluster
  → eksctl create iamidentitymapping  role → group kitten-ci-deploy
  → kubectl apply -f k8s/eks-deploy-rbac.yaml   (kitten-ci-deploy RBAC)
  → kubectl apply -k k8s                        (namespace, rbac, redis, pvc, deployment, service)
  → kubectl create secret … kitten-github-token / kitten-llm-keys /
      kitten-webhook-secret / kitten-knowledge-secrets   (from exported env)
  → aws ecr create-repository × 3 (idempotent)
  → echo AWS_ROLE_ARN + GitHub Secrets checklist
```

## Invariant amendments

- **No new cross-job state.** The two designated stores (Semble PVC + Atlas
  knowledge) stay the only persistent state. EKS introduces infrastructure
  only — no runtime behavior change.
- **Same-commit doc rule** applies: `k8s/kustomization.yaml`,
  `k8s/eks-deploy-rbac.yaml`, `scripts/eks-setup.sh`, `.github/workflows/*` and
  the README EKS section ship together.

## Implementation Cards

Execution order (sequential):

| Card | Story | Scope |
|---|---|---|
| [KIT-050](../features/KIT-050-eks-manifests-context.md) | [US-040](../../docs/stories/US-040-eks-automated-deploy.md) | `k8s/kustomization.yaml`, `k8s/eks-deploy-rbac.yaml`, `KUBE_CONTEXT` parametrization across operator scripts |
| [KIT-051](../features/KIT-051-eks-deploy-automation.md) | [US-040](../../docs/stories/US-040-eks-automated-deploy.md) | `scripts/eks-setup.sh`, `.github/workflows/ci.yml` + `deploy.yml`, README EKS section |

## Architecture

```
Deploy time (CI, push main)
  checkout → pnpm install+build (reviewer image needs dist/)
  → OIDC assume kitten-gh-actions-deploy (trust: repo main)
  → ECR login → build+push kitten-dispatcher/reviewer/semble-sidecar:<sha>
  → kubectl apply -k k8s            (non-secret resources; secret.yaml excluded)
  → kubectl set image deployment dispatcher=…/kitten-dispatcher:<sha>
  → kubectl set env REVIEWER_IMAGE=…/kitten-reviewer:<sha> SEMBLE_IMAGE=…/kitten-semble-sidecar:<sha>
  → rollout status

Run time (unchanged, EKS)
  webhook/POST /review → dispatcher (SA default, rbac.yaml) → createNamespacedPod
  → reviewer Pod pulls …/kitten-reviewer:<sha> from ECR via node role
```

## Stack

| Component | Technology | Notes |
|---|---|---|
| Registry | Amazon ECR | 3 private repos, immutable SHA tags |
| CI | GitHub Actions (ubuntu-latest) | OIDC, `configure-aws-credentials@v4`, `amazon-ecr-login@v2` |
| Image param | `kubectl set image` / `kubectl set env` | kustomize `images:` cannot rewrite env-var values |
| Kustomize | `kubectl apply -k k8s` (built-in) | groups non-secret resources; no overlay needed |
| Bootstrapping | `eksctl` (OIDC + iamidentitymapping) | prerequisites: aws, eksctl, kubectl |
| Cluster RBAC for CI | Role+RoleBinding `kitten-ci-deploy` | mapped via aws-auth group (eksctl) |

## Error handling

| Error | Behavior |
|---|---|
| `eks-setup.sh` run without EKS cluster/creds | Clear prereq error before any mutation |
| OIDC provider / role / mapping already exist | Idempotent (`|| true`, `--no-duplicate-arg`) |
| Role trust not matching repo/branch | Deploy fails at OIDC step with clear AWS message |
| ECR repo missing | `create-repository` idempotent in setup; CI assumes it exists |
| Image build/push fails | Deploy aborts before any `kubectl` — cluster untouched |
| `kubectl apply -k k8s` forbidden | Missing `eks-deploy-rbac.yaml`/iamidentitymapping — message points at setup |
| Secrets missing in cluster | Deployment `CreateContainerConfigError` — re-run setup with env vars |

Structured errors everywhere: `{ code, message, details }`.

## Recorded decisions (v9 brainstorm — 2026-08-05)

| # | Question | Decision |
|---|---|---|
| D1 | Automate as CI or local script? | **Both**: `eks-setup.sh` (one-time bootstrap, manual) + GitHub Actions (repeat deploys, automatic). The user picked this over script-only or CI-only. |
| D2 | New epic or card-only? | **New epic** `v9-eks-deploy` (user decision); infra work does not belong to v8's security scope. |
| D3 | How to inject ECR image names? | **`kubectl set image` + `kubectl set env`** in the deploy workflow. kustomize `images:` cannot rewrite `REVIEWER_IMAGE`/`SEMBLE_IMAGE` env-var values, and `replacements` can't derive the sidecar URI from the dispatcher image. Simpler, declarative-enough, and idempotent. |
| D4 | Image tags | **Immutable `${SHA}` tags**; keep `latest` in versioned manifests for minikube/dev. `IfNotPresent` remains correct because tags are unique. |
| D5 | `imagePullSecrets`? | **Not needed** — eksctl node groups attach `AmazonEC2ContainerRegistryReadOnly`; ECR auth via node IAM role. |
| D6 | Kustomize layout | **Single `k8s/kustomization.yaml`**, no base/overlay tree. Overlay can't reference `../` files, and no per-env divergence justifies moving 8 manifests (which would break every doc/script path). |
| D7 | CI RBAC scope | **ClusterRole+ClusterRoleBinding `kitten-ci-deploy`** (namespaces get/list; full CRUD on deployments/services/pods/PVC; secrets/configmaps read-only). Cluster-wide for simplicity of `apply -k k8s` (namespace resource); documented trade-off. |
| D8 | Secrets applied by CI? | **No.** `eks-setup.sh` creates real Secrets once; `secret.yaml` placeholder is excluded from the kustomization so CI can never overwrite them. |
| D9 | NodePort vs LoadBalancer | **Unchanged (NodePort)**. Exposing the dispatcher publicly for the GitHub webhook is out of scope (user's operational call); the deploy path works with port-forward/NodePort. |

## What is NOT in v9 (out-of-scope)

- Creating the EKS cluster itself (eksctl/Terraform) — the setup assumes an
  existing cluster and admin kubeconfig.
- Exposing the dispatcher publicly (Ingress/ALB/LoadBalancer for the webhook).
- Secret rotation / central secret management (External Secrets, Vault).
- Helm packaging / GitOps (ArgoCD, Flux) — CI applies manifests directly.
- Fargate or node-group tuning, autoscaling, cost controls.
- Multi-cluster (staging/prod) promotion.

## Testing strategy

| Level | What |
|---|---|
| Static | `kustomize build k8s` renders all resources (no secret.yaml); shellcheck on `eks-setup.sh` and modified scripts |
| Dry-run | `kubectl apply --dry-run=client -k k8s` parses cleanly |
| Unit (repo) | `pnpm test && pnpm lint` stay green (no runtime code touched) |
| E2E (manual, once) | Run `eks-setup.sh` against the EKS cluster → push to `main` → deploy.yml runs → `kubectl -n kitten get pods` shows dispatcher running → `curl /health` ok → submit a review → reviewer Pod spawns from the ECR image |

Coverage target: no runtime packages touched — the repo test suite must remain
green unchanged.

## Dependency verification (2026-08-05)

No new runtime dependencies. CI-only tooling (actions) is pinned to major
versions: `aws-actions/configure-aws-credentials@v4`,
`aws-actions/amazon-ecr-login@v2`, `pnpm/action-setup@v4`.
