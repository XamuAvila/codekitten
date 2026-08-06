---
id: "KIT-050"
status: "done"
priority: "high"
assignee: ""
epic: "v9-eks-deploy"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
completedAt: "2026-08-05"
labels: ["infra", "eks", "kustomize", "scripts"]
order: "g0"
---

# EKS Manifests + Operator Script Context

## User Story

See [US-040](../../docs/stories/US-040-eks-automated-deploy.md) (AC-4, AC-5, AC-6).

## Technical Refinement

### Files

**Created:**
- `k8s/kustomization.yaml` — groups the non-secret resources (`namespace`,
  `rbac`, `dispatcher-deployment`, `dispatcher-service`, `redis-deployment`,
  `redis-service`, `semble-index-pvc`). **`secret.yaml` deliberately excluded** so
  `kubectl apply -k k8s` (CI) can never overwrite the real Secrets with the
  `REPLACE_ME` placeholder.
- `k8s/eks-deploy-rbac.yaml` — ClusterRole + ClusterRoleBinding `kitten-ci-deploy`:
  namespaces get/list; full CRUD on deployments/replicasets/statefulsets,
  pods, services, PVCs; secrets/configmaps read-only; `pods/log` get. The group
  is populated by `eksctl create iamidentitymapping` in `eks-setup.sh`.

**Modified:**
- `scripts/cleanup-pods.sh`, `scripts/e2e-test.sh`, `scripts/webhook-e2e.sh`,
  `scripts/deep-context-e2e.sh` — replace the hardcoded
  `kubectl() { command kubectl --context=minikube "$@"; }` with
  `KUBE_CONTEXT="${KUBE_CONTEXT:-minikube}"`; default unchanged, so the
  minikube dev loop is untouched.

### Consumes

- Existing `k8s/*.yaml` manifests (no content changes) — this card only wraps
  them in a kustomization and keeps them reachable by the same paths.

### Produces

- `kubectl apply -k k8s` as the canonical "apply all non-secret infra" command
  used by both `eks-setup.sh` and `deploy.yml` (KIT-051).
- `kitten-ci-deploy` RBAC group that `eks-setup.sh` maps the IAM role into.

### Design decisions

1. **No base/overlay kustomize tree.** There is no per-env divergence worth
   moving 8 manifests for, and moving them would break every doc/script path —
   17 references across `minikube-setup.sh`, `eks-setup.sh`, `deploy.yml`,
   `docs/configuration.md` and `docs/deployment.md`. A single kustomization at
   the root of `k8s/` suffices (epic D6).

   **Correction (2026-08-05, v10 brainstorm).** This decision originally read
   "an overlay at `k8s/overlays/eks/` cannot reference `../` resources". That
   rationale is imprecise, and the corrected form matters for anyone adding an
   overlay later. Tested with kustomize v5.8.1:
   - A **nested** overlay (`k8s/overlays/<name>/` with `resources: [../..]`)
     fails with `cycle detected: candidate root '…/k8s' contains visited root
     '…/k8s/overlays/<name>'`. The problem is the nesting, not the `../`.
   - A **sibling** overlay (`deploy/<name>/` with `resources: [../../k8s]`)
     renders correctly.

   The decision above stands unchanged — it is the reason it stands that was
   wrong. v10 (KIT-053) adds a sibling overlay on exactly this basis; see
   `.devtool/epics/v10-shared-cluster-deploy.md` D9.
2. **ClusterRole (not Role) for the CI deploy RBAC.** The kustomization applies
   a `Namespace` object, which is cluster-scoped; a namespaced Role can't cover
   it. Trade-off accepted and documented (epic D7).
3. **`KUBE_CONTEXT` env defaulting to `minikube`** keeps `minikube-setup.sh`
   and all e2e scripts byte-compatible while enabling EKS via
   `export KUBE_CONTEXT=<eks-context>`.

### Risks

- `kubectl apply -f k8s/` (directory form) auto-detects `kustomization.yaml` and
  switches to kustomize — a subtle behavior change if someone uses directory
  form. Scripts already use explicit file paths, so no current caller is
  affected; the kustomization is only used via `-k`.

## Implementation Plan

1. [ ] Create `k8s/kustomization.yaml` — test: `kustomize build k8s` lists exactly the 8 non-secret objects (7 manifests — `rbac.yaml` yields Role + RoleBinding) and no Secret kind, expected: PASS; `kubectl apply --dry-run=client -k k8s` parses cleanly.
2. [ ] Create `k8s/eks-deploy-rbac.yaml` — test: renders via kustomize (kept out of the kustomization so setup applies it standalone), expected: PASS.
3. [ ] Parametrize `KUBE_CONTEXT` in the four operator scripts — test: `shellcheck` clean; `grep -c 'KUBE_CONTEXT' scripts/*.sh` shows 4, expected: 4; default behavior unchanged.
4. [ ] Commit: `feat: add EKS kustomization + ci-deploy RBAC + KUBE_CONTEXT scripts`

## How to Test

- **Automated**: `kustomize build k8s | grep -c 'kind: Secret'` → 0;
  `kustomize build k8s | grep -c '^kind:'` → 8 (Namespace, Role, RoleBinding, 2×Service, PVC, 2×Deployment); `shellcheck scripts/cleanup-pods.sh scripts/e2e-test.sh scripts/webhook-e2e.sh scripts/deep-context-e2e.sh scripts/eks-setup.sh` → no errors.
- **Manual verification**: `kubectl apply -k k8s` against minikube applies the same 8 objects the old per-file apply did; `kubectl get pods -n kitten` unchanged.
- **Negative check**: `kustomize build k8s` must NOT contain `kind: Secret` (proves the CI can never clobber real Secrets).
- **Done means**: `kustomize build k8s` renders 8 objects, no Secret; the four operator scripts honor `KUBE_CONTEXT` with a `minikube` default; `pnpm test && pnpm lint` green.

## Verification record (2026-08-05)

| Criterion | Result |
|---|---|
| `kubectl kustomize k8s \| grep -c '^kind:'` | **8** — Namespace, Role, RoleBinding, 2× Service, PVC, 2× Deployment |
| `kubectl kustomize k8s \| grep -c '^kind: Secret'` | **0** — CI can never clobber the real Secrets |
| `KUBE_CONTEXT` in the four operator scripts | **4/4** — `cleanup-pods.sh`, `e2e-test.sh`, `webhook-e2e.sh`, `deep-context-e2e.sh` |
| `kubectl --context=minikube apply --dry-run=server -k k8s` | all 8 objects accepted by the API server |
| `pnpm test && pnpm lint` | green (386 tests, no lint issues) |
| `shellcheck` | **NOT RUN** — not installed on the machine that closed this card. The criterion is unverified, not passed. Run it before relying on it. |

Closed alongside the fix for a defect this card's incompleteness caused: v10's
`deploy/shared-cluster/` overlay and the committed `deploy.yml` both resolve
`k8s/kustomization.yaml`, which this card produces. Until it was committed, a
clean checkout could not render either — see the v10 epic's Implementation
Cards note.
