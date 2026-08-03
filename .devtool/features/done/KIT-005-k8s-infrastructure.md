---
id: "KIT-005"
status: "done"
priority: "high"
assignee: ""
epic: "v2-github-integration"
dueDate: null
created: "2026-08-03"
modified: "2026-08-03"
completedAt: "2026-08-03"
labels: ["infra", "k8s"]
order: "b0"
---

# K8s Infrastructure

## User Story

See [US-005](../../docs/stories/US-005-k8s-infrastructure.md).

## Technical Refinement

### Files

**Created:**
- `k8s/namespace.yaml` — Kubernetes namespace `kitten` for all project resources
- `k8s/redis-deployment.yaml` — single-replica Redis pod (image `redis:7-alpine`)
- `k8s/redis-service.yaml` — ClusterIP service exposing Redis on port 6379 within the cluster
- `k8s/dispatcher-deployment.yaml` — dispatcher pod with env vars for `REDIS_URL`, `K8S_NAMESPACE`, `REVIEWER_IMAGE`, `GITHUB_TOKEN` (from secret)
- `k8s/dispatcher-service.yaml` — NodePort service exposing dispatcher on port 3001 (accessible from host via minikube)
- `k8s/secret.yaml` — template for `kitten-github-token` Secret with placeholder value (base64-encoded `REPLACE_ME`)
- `packages/reviewer/Dockerfile` — multi-stage Node.js 20-alpine image with git installed, copies built `@kitten/reviewer` and `@kitten/shared` packages
- `scripts/minikube-setup.sh` — idempotent setup script: starts minikube, creates namespace, applies all manifests, builds Docker images inside minikube

**Modified:**
- None — this is a greenfield infrastructure card.

### Consumes

Nothing — this is the first card in v2. It only references the existing project structure (monorepo layout, existing Dockerfiles as pattern reference).

### Produces

Consumed by KIT-006:
- K8s namespace `kitten` — dispatcher creates Pods in this namespace
- Redis deployment + service — dispatcher connects to `redis://redis.kitten.svc.cluster.local:6379`
- `kitten-github-token` Secret — Pod manifests reference this via `secretKeyRef`
- `REVIEWER_IMAGE` — dispatcher uses this env var to set the container image in Pod manifests

Consumed by KIT-007:
- `packages/reviewer/Dockerfile` — reviewer code runs inside this container image
- minikube cluster — end-to-end testing environment

### Design decisions

1. **minikube over kind/k3s** — minikube is the most widely documented local K8s tool, has built-in `minikube image build` for building images directly into the cluster (no registry needed). Rejected: kind (requires `kind load docker-image`, less intuitive), k3s (heavier, linux-only).
2. **Separate YAML files over Helm/kustomize** — v2 has 6 manifests total. Helm templating adds complexity without value at this scale. Plain `kubectl apply -f k8s/` is sufficient. Rejected: Helm chart (overkill for dev-only manifests), kustomize (unnecessary layer).
3. **NodePort for dispatcher** — allows `minikube service` or direct `curl` from the host without an ingress controller. Port 3001 matches the existing `PORT` convention. Rejected: LoadBalancer (requires metallb on minikube), Ingress (needs an ingress controller install).
4. **Redis without persistence** — dev/test only. No PersistentVolumeClaim. Pod death = data loss (acceptable for review status that is ephemeral). Rejected: StatefulSet with PVC (production concern, not v2).
5. **Secret template with placeholder** — `secret.yaml` is committed with `REPLACE_ME` base64-encoded. The setup script prints a warning to replace it. Real token is never committed. Rejected: external-secrets-operator (heavyweight for dev).
6. **Multi-stage Dockerfile for reviewer** — stage 1 copies `packages/reviewer/dist` and `packages/shared/dist`, stage 2 runs `node`. Keeps image small (~180MB). `git` installed via `apk add` for clone operations. Rejected: single-stage (larger image with build tools).
7. **Idempotent setup script** — `minikube status` check before `minikube start`, `kubectl get namespace` before `kubectl create namespace`. Safe to re-run. Rejected: one-shot script that errors on second run.

### Risks

1. **minikube version differences** — `minikube image build` API changed between versions. Script should pin minimum version (≥1.30) and check on startup.
2. **DNS resolution inside cluster** — Redis service must be accessible as `redis.kitten.svc.cluster.local`. If minikube DNS addon is not enabled, Pods can't resolve this. Setup script should enable the DNS addon explicitly.
3. **Image build cache** — `minikube image build` does not share Docker cache with the host. First build is slow. Subsequent builds use minikube's internal cache.

## Implementation Plan

1. - [ ] **Create namespace manifest:** Write `k8s/namespace.yaml` with `apiVersion: v1`, `kind: Namespace`, `metadata.name: kitten`. Verify: `kubectl apply -f k8s/namespace.yaml && kubectl get namespace kitten` — expected: `kitten   Active`.
2. - [ ] **Create Redis deployment + service:** Write `k8s/redis-deployment.yaml` (1 replica, `redis:7-alpine`, port 6379, resource limits 128Mi/100m) and `k8s/redis-service.yaml` (ClusterIP, port 6379, selector `app: kitten-redis`). Verify: `kubectl apply -f k8s/redis-deployment.yaml -f k8s/redis-service.yaml -n kitten && kubectl get pods -n kitten` — expected: `kitten-redis-xxx   1/1   Running`.
3. - [ ] **Create secret template:** Write `k8s/secret.yaml` with `kind: Secret`, `metadata.name: kitten-github-token`, `data.token: REPLACE_ME` (base64). Verify: `kubectl apply -f k8s/secret.yaml -n kitten && kubectl get secret kitten-github-token -n kitten` — expected: secret exists.
4. - [ ] **Create dispatcher deployment + service:** Write `k8s/dispatcher-deployment.yaml` (1 replica, image `kitten-dispatcher:latest`, `imagePullPolicy: IfNotPresent`, envs: `PORT=3001`, `REDIS_URL=redis://redis.kitten.svc.cluster.local:6379`, `K8S_NAMESPACE=kitten`, `REVIEWER_IMAGE=kitten-reviewer:latest`, `GITHUB_TOKEN` from secretKeyRef, resource limits 256Mi/200m). Write `k8s/dispatcher-service.yaml` (NodePort, port 3001, selector `app: kitten-dispatcher`). Verify: `kubectl apply -f k8s/dispatcher-deployment.yaml -f k8s/dispatcher-service.yaml -n kitten && kubectl get pods -n kitten` — expected: dispatcher pod Running.
5. - [ ] Commit: `feat: add K8s manifests for namespace, Redis, dispatcher, and secret`
6. - [ ] **Create reviewer Dockerfile:** Write `packages/reviewer/Dockerfile` — multi-stage: stage 1 (`node:20-alpine`) copies `packages/reviewer/dist/`, `packages/reviewer/package.json`, `packages/shared/dist/`, `packages/shared/package.json`, root `package.json`, `pnpm-workspace.yaml`, installs production deps with `pnpm install --prod --frozen-lockfile`; stage 2 installs `git` via `apk add --no-cache git`, copies from stage 1, sets `CMD ["node", "packages/reviewer/dist/index.js"]`. Verify: `docker build -f packages/reviewer/Dockerfile -t kitten-reviewer:latest .` — expected: build succeeds, image size < 250MB.
7. - [ ] Commit: `feat: add reviewer Dockerfile`
8. - [ ] **Create minikube setup script:** Write `scripts/minikube-setup.sh` with sections: (a) check minikube installed and version ≥1.30, (b) `minikube start --driver=docker` if not running, (c) enable DNS addon, (d) `kubectl apply -f k8s/namespace.yaml`, (e) `kubectl apply -f k8s/secret.yaml -n kitten`, (f) `kubectl apply -f k8s/redis-deployment.yaml -f k8s/redis-service.yaml -n kitten`, (g) build dispatcher image `minikube image build -t kitten-dispatcher:latest -f packages/dispatcher/Dockerfile .`, (h) build reviewer image `minikube image build -t kitten-reviewer:latest -f packages/reviewer/Dockerfile .`, (i) `kubectl apply -f k8s/dispatcher-deployment.yaml -f k8s/dispatcher-service.yaml -n kitten`, (j) `kubectl rollout status deployment/kitten-dispatcher -n kitten --timeout=60s`, (k) print summary with access URL. Make executable: `chmod +x scripts/minikube-setup.sh`.
9. - [ ] Commit: `feat: add minikube setup script`
10. - [ ] **Full verification:** Run `./scripts/minikube-setup.sh`. Verify all pods running: `kubectl get pods -n kitten` — expected: `kitten-redis-xxx 1/1 Running`, `kitten-dispatcher-xxx 1/1 Running`. Verify health: `curl $(minikube service kitten-dispatcher -n kitten --url)/health` — expected: `{"status":"ok","redis":"connected"}`. Verify secret exists: `kubectl get secret kitten-github-token -n kitten` — expected: listed.
11. - [ ] Commit: `test: verify minikube setup end-to-end`

## How to Test

- **Automated**: No unit tests for infrastructure manifests. Verification is via kubectl commands:
  - `kubectl get namespace kitten` — exists, Active
  - `kubectl get pods -n kitten` — Redis and dispatcher pods Running
  - `kubectl get svc -n kitten` — Redis (ClusterIP:6379) and dispatcher (NodePort:3001)
  - `kubectl get secret kitten-github-token -n kitten` — exists
  - `curl $(minikube service kitten-dispatcher -n kitten --url)/health` — `{"status":"ok","redis":"connected"}`
- **Manual verification**:
  1. `./scripts/minikube-setup.sh` — runs without errors on a fresh minikube
  2. `kubectl get pods -n kitten` — both pods `1/1 Running`
  3. `curl $(minikube service kitten-dispatcher -n kitten --url)/health` — returns ok
  4. Re-run `./scripts/minikube-setup.sh` — idempotent, no errors on second run
- **Negative check**: Delete the namespace (`kubectl delete namespace kitten`), re-run setup script — should recreate everything cleanly. Stop minikube (`minikube stop`), re-run script — should start minikube and proceed.
- **Done means**: `./scripts/minikube-setup.sh` completes on a machine with minikube installed, resulting in namespace `kitten` with running Redis + dispatcher pods, accessible health endpoint returning `{"status":"ok","redis":"connected"}`, and `kitten-github-token` secret present.
