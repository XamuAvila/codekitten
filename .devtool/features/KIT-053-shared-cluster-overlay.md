---
id: "KIT-053"
status: "in-progress"
priority: "high"
assignee: ""
epic: "v10-shared-cluster-deploy"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
completedAt: null
labels: ["k8s", "deploy", "docs"]
order: "a1"
---

# Shared-Cluster Overlay + Deploy Path

## User Story

See [US-042](../../docs/stories/US-042-deploy-on-a-cluster-you-dont-own.md).

## Technical Refinement

### Files

**Created:**
- `deploy/shared-cluster/kustomization.yaml` — `resources: [../../k8s]`, three
  patches.
- `deploy/shared-cluster/service-clusterip-patch.yaml` — dispatcher Service →
  `ClusterIP`.
- `deploy/shared-cluster/pvc-storageclass-patch.yaml` — `kitten-semble-index`
  gains `storageClassName`.
- `deploy/shared-cluster/ingress.yaml` — template with placeholder host,
  `ingressClassName` and TLS secret, each commented as a value the operator
  must replace.
- `deploy/shared-cluster/README.md` — what the overlay changes, what the
  operator must supply, and the PVC caveat.

**Modified:**
- `.github/workflows/deploy.yml:78` — `kubectl apply -k k8s` becomes
  `kubectl apply -k "${KUSTOMIZE_PATH}"`, with
  `KUSTOMIZE_PATH: ${{ vars.KUSTOMIZE_PATH || 'k8s' }}` in the job `env` (epic
  D11).
- `docs/configuration.md` — `REVIEWER_POD_SCHEDULING` in the dispatcher table,
  a subsection covering the three scheduling fields with the
  ServiceAccount-must-exist caveat, and `KUSTOMIZE_PATH` in the deployment
  tooling table.
- `docs/deployment.md` — a shared-cluster section, plus troubleshooting rows for
  `FailedScheduling`, PVC `Pending`, and the overlay being reverted by CI.
- `docs/architecture.md` — note that the Pod spec is generated in code and which
  fields an operator can influence.
- `README.md` — one line in the deployment options pointing at the overlay.
- `CHANGELOG.md` — Unreleased/Added entries.

### Why the base cannot move

17 references to `k8s/…` paths exist across scripts, workflows and docs, so
relocating the base into `k8s/base/` would break all of them:

| Consumer | References |
|---|---|
| `scripts/minikube-setup.sh` | lines 50, 58, 72, 128, 133, 134, 156, 157 — applies eight manifests by path |
| `scripts/eks-setup.sh` | lines 61, 164, 211 — RBAC file, namespace, `apply -k` |
| `.github/workflows/deploy.yml` | line 78 — `apply -k k8s` |
| `docs/configuration.md` | lines 351, 375, 379, 409 |
| `docs/deployment.md` | lines 117, 118, 217 |

This is the concrete backing for design decisions 1 and 2: the overlay adapts
the base from outside; nothing under `k8s/` moves or changes.

### Consumes

- `PodConfig.scheduling` from KIT-052 — documented here, not implemented here.
- The existing `k8s/kustomization.yaml` (v9) as the overlay base.

### Produces

- A deploy path for clusters Kitten does not own, and the documentation that
  makes the two fatal failure modes discoverable before they happen.

### Design decisions

1. **The overlay is a sibling of `k8s/`, never a child** (epic D9). Verified
   during the brainstorm with kustomize v5.8.1: nesting fails with
   `cycle detected: candidate root '…/k8s' contains visited root
   '…/k8s/overlays/shared-cluster'`. The sibling layout renders correctly and
   keeps every documented `k8s/…` path valid.
2. **The base is not modified** (epic D5, D6). `minikube service` requires
   `NodePort`, and it is used by the README quickstart, `AGENTS.md` and three
   E2E scripts. Any `storageClassName` value would be wrong on some cluster.
3. **`KUSTOMIZE_PATH` defaults to `k8s`.** The dedicated-cluster path from v9
   keeps working with no repository variable set; only shared-cluster operators
   set it. Without this the CI silently reverts the overlay on every push.
4. **The Ingress ships as a template, not a configured resource.** Hostnames,
   ingress classes and certificates belong to the cluster owner. A file with
   invented values would look configured and fail confusingly.
5. **Patch by name, verified not to leak.** The Service patch targets
   `kitten-dispatcher`; the brainstorm probe confirmed the `redis` Service is
   untouched (it already declares `type: ClusterIP` in
   `k8s/redis-service.yaml:9`).

### Risks

1. **`spec.storageClassName` is immutable on a bound PVC**, so applying the
   overlay to a cluster where `kitten-semble-index` already exists is expected
   to be rejected. **Unverified without a live cluster.** Verify first, before
   writing the docs: apply the base, then the overlay, and record the actual
   error. The remedy is to delete and recreate the PVC — the index is derived
   data, rebuilt incrementally.
2. `vars.KUSTOMIZE_PATH` is empty rather than unset in some GitHub
   configurations; `|| 'k8s'` covers both, but confirm the rendered value in a
   workflow run before closing.
3. The docs touched here describe KIT-052's variable. If the two cards land in
   separate commits, the doc commit must not precede the code commit — the
   same-commit rule cuts both ways.

## Implementation Plan

**Step 1 first**: risk 1 is unverified and it decides what the documentation
must say, so it is settled before any file is written.

1. - [x] Settle risk 1 on minikube.
   Command: `kubectl --context=minikube apply -k k8s`, then edit the PVC's
   `storageClassName` in place and re-apply.
   Expected: record the exact outcome — either a field-immutable rejection, or
   an accepted no-op. Whatever happens is what step 8 documents.
   **Recorded outcome (2026-08-05):** changing `spec.storageClassName` on the
   **bound** PVC is rejected verbatim as
   `The PersistentVolumeClaim "kitten-semble-index" is invalid: spec: Forbidden:
   spec is immutable after creation except resources.requests and
   volumeAttributesClassName for bound claims`. Patching back to the same value
   the PVC already stores is an accepted no-op (`patched (no change)`). The
   remedy is deleting the PVC — the index is derived data — and re-applying.
2. - [x] Create `deploy/shared-cluster/kustomization.yaml` with
   `resources: [../../k8s]` plus the three patch files.
   Command: `kubectl kustomize deploy/shared-cluster > /tmp/overlay.yaml`.
   Expected: renders without error.
3. - [x] Assert the overlay's effect.
   Command: `grep -c 'type: ClusterIP' /tmp/overlay.yaml && grep -n 'storageClassName' /tmp/overlay.yaml && grep -c 'kind: Ingress' /tmp/overlay.yaml`.
   Expected: two `ClusterIP` Services (`kitten-dispatcher` patched, `redis`
   already so in the base), one `storageClassName`, one Ingress.
4. - [x] Assert the base did not change.
   Command: `kubectl kustomize k8s | grep -A8 'name: kitten-dispatcher' | grep -c 'type: NodePort'` and
   `kubectl kustomize k8s | grep -c storageClassName`.
   Expected: `1` and `0` respectively.
   **Command correction:** the card's original `grep -A1` cannot work —
   kustomize's rendered Service block places `type:` about eight lines below
   `name:` (verified against the live render), so `-A1` yields `0` even when
   the base is unchanged. `-A8` gives the intended `1`.
5. - [x] Confirm the overlay is applyable.
   Command: `kubectl --context=minikube apply --dry-run=client -k deploy/shared-cluster`.
   Expected: every resource reports `configured` or `created (dry run)`, no error.
6. - [x] Commit: `feat: shared-cluster kustomize overlay`
7. - [x] Parameterize the deploy workflow: add
   `KUSTOMIZE_PATH: ${{ vars.KUSTOMIZE_PATH || 'k8s' }}` to the job `env` and
   change line 78 to `kubectl apply -k "${KUSTOMIZE_PATH}"`.
   Command: `python3 -c "import yaml;yaml.safe_load(open('.github/workflows/deploy.yml'));print('valid')"`.
   Expected: prints `valid`, and `grep -n 'apply -k' .github/workflows/deploy.yml`
   shows the variable, not a literal `k8s`.
8. - [x] Commit: `feat(ci): make the deploy kustomize path configurable`
9. - [x] `docs/configuration.md`: add `REVIEWER_POD_SCHEDULING` to the
   dispatcher table, a scheduling subsection carrying the
   ServiceAccount-must-exist caveat, and `KUSTOMIZE_PATH` to the deployment
   tooling table. Expected: the three new entries exist and no existing row is
   contradicted.
10. - [x] `docs/deployment.md`: a shared-cluster section plus three
    troubleshooting rows — `FailedScheduling`, PVC `Pending` blocking the Pod,
    and CI reverting the overlay when `KUSTOMIZE_PATH` is unset. Expected: the
    PVC row states the outcome recorded in step 1, verbatim.
11. - [x] `docs/architecture.md` and `README.md`: note that the reviewer Pod
    spec is generated in code, which three fields an operator can influence, and
    one line pointing at the overlay.
12. - [x] `CHANGELOG.md`: Unreleased/Added entries for the overlay, the
    scheduling variable and `KUSTOMIZE_PATH`.
13. - [x] Verify no doc link broke.
    Command: the link check from the docs work — every relative link in
    `README.md`, `docs/*.md` resolves to an existing file.
    Expected: zero broken.
14. - [x] `pnpm test && pnpm lint` green (no runtime code touched); commit:
    `docs: shared-cluster deployment and reviewer Pod scheduling`

## How to Test

- **Automated**: `kubectl kustomize deploy/shared-cluster` renders without
  error; `kubectl apply --dry-run=client -k deploy/shared-cluster` parses;
  `kubectl kustomize k8s` still yields the `NodePort` form; `pnpm test && pnpm
  lint` stay green.
- **Manual verification**: on minikube, `kubectl apply -k deploy/shared-cluster`
  then `kubectl get svc kitten-dispatcher -n kitten` shows `ClusterIP`, and
  `kubectl get pvc kitten-semble-index -n kitten` shows the pinned class.
  `kubectl port-forward svc/kitten-dispatcher 3001:3001 -n kitten` plus
  `curl localhost:3001/health` answers `{"status":"ok",...}`.
- **Negative check**: rendering the **base** must still produce `type:
  NodePort` and a PVC with no `storageClassName` — the overlay must not leak
  upward. And `kubectl kustomize` from a nested path such as
  `k8s/overlays/shared-cluster` must not exist as a directory at all, so nobody
  reintroduces the cycle.
- **Done means**: the overlay renders and applies, the base renders unchanged,
  `deploy.yml` honors `KUSTOMIZE_PATH` with `k8s` as default, and every doc
  listed under Files describes what actually shipped.
