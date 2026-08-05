# Deployment

Two supported ways to run Kitten: a Docker Compose stack for fast iteration on the HTTP
layer, and a Kubernetes deployment (minikube locally) that can actually run reviews.

---

## Table of contents

- [Prerequisites](#prerequisites)
- [Option A — Docker Compose](#option-a--docker-compose)
- [Option B — Kubernetes / minikube](#option-b--kubernetes--minikube)
- [Option C — Amazon EKS with CI deploys](#option-c--amazon-eks-with-ci-deploys)
- [Option D — a cluster you do not own](#option-d--a-cluster-you-do-not-own)
- [Wiring the GitHub webhook](#wiring-the-github-webhook)
- [Enabling the knowledge store](#enabling-the-knowledge-store)
- [End-to-end verification](#end-to-end-verification)
- [Operations](#operations)
- [Troubleshooting](#troubleshooting)
- [Production considerations](#production-considerations)

---

## Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Node.js | >= 20 | building, testing |
| pnpm | >= 9 | workspace |
| Docker + Compose | recent | both options |
| minikube | >= 1.30 | Option B (enforced by the setup script) |
| kubectl | matching your cluster | Options B and C |
| `aws` CLI + `eksctl` | recent | Option C |
| `openssl` | any | webhook signature generation in the E2E scripts |

Credentials:

- **GitHub token** — `repo` scope (classic), or `Contents: read` + `Pull requests:
  write` (fine-grained). Needed to clone and to post reviews.
- **At least one LLM API key** — Anthropic, OpenAI or DeepSeek.
- **Optional:** MongoDB Atlas connection string + Voyage API key, for the knowledge
  store.

---

## Option A — Docker Compose

Dispatcher + Redis + a local Atlas-capable MongoDB. Good for iterating on routes,
validation, webhook signatures and health checks.

> **Reviews cannot run here.** The dispatcher creates reviewer Pods through the
> Kubernetes API. Without a cluster, `POST /review` returns
> `503 SERVICE_UNAVAILABLE`. That is expected, not a misconfiguration.

```bash
docker compose up -d --build

curl http://localhost:3001/health
# → {"status":"ok","redis":"connected"}

docker compose logs -f dispatcher
docker compose down
```

**Services:**

| Service | Image | Ports | Notes |
|---|---|---|---|
| `redis` | `redis:7-alpine` | internal | `redis-cli ping` healthcheck. |
| `mongo` | `mongodb/mongodb-atlas-local:latest` | `27021 → 27017` | Includes `mongot`, so `$vectorSearch` works — plain community `mongod` does not. Port 27021 avoids clashing with other local Mongo containers. |
| `dispatcher` | built from `packages/dispatcher/Dockerfile` | `3001` | Waits for both healthchecks. |
| `tunnel` | `cloudflare/cloudflared:latest` | host network | Opt-in `webhook` profile. See below. |

The dispatcher image builds from source inside the container (`pnpm install && pnpm
build`), so no host-side build step is required for Compose.

Knowledge-store variables are passed through from your shell:

```bash
MONGODB_URI="mongodb://mongo:27017/?directConnection=true" \
VOYAGE_API_KEY=<key> \
  docker compose up -d --build
```

`MONGODB_URI` already defaults to the local `mongo` service; `VOYAGE_API_KEY` defaults
to empty, which leaves the knowledge store off with a warning.

---

## Option B — Kubernetes / minikube

### 1. Build the TypeScript first

```bash
pnpm install
pnpm build
```

> ⚠️ **Not optional.** The reviewer image copies `packages/shared/dist/` and
> `packages/reviewer/dist/` from the build context, and `dist/` is gitignored. Skipping
> `pnpm build` makes `minikube image build` fail on the `COPY` step. (The dispatcher
> image compiles internally and does not have this dependency.)

### 2. Run the setup script

```bash
GITHUB_TOKEN=<token> \
ANTHROPIC_API_KEY=<key> \
DEEPSEEK_API_KEY=<key> \
MONGODB_URI=<atlas-uri> \
VOYAGE_API_KEY=<key> \
  ./scripts/minikube-setup.sh
```

Only `GITHUB_TOKEN` and one LLM key are required. What the script does, in order:

1. Verifies minikube >= 1.30 and starts it with the Docker driver if it is not running.
2. Applies `k8s/namespace.yaml`.
3. Applies `k8s/rbac.yaml` — a `Role` granting `create/delete/get/list/watch` on Pods
   plus `get` on `pods/log`, bound to the namespace's `default` ServiceAccount. Without
   it the dispatcher gets `403: pods is forbidden`.
4. Creates `kitten-github-token` from `$GITHUB_TOKEN`, or applies the placeholder
   template with a loud warning.
5. Creates `kitten-llm-keys` from whichever of the three key variables are exported.
6. Creates `kitten-webhook-secret`, generating one with `openssl rand -hex 20` if
   `WEBHOOK_SECRET` is not exported. **The value is echoed once** — copy it now.
7. If both knowledge variables are present: creates `kitten-knowledge-secrets`
   (rewriting `localhost`/`127.0.0.1` in the URI to `host.minikube.internal` so Pods
   can reach a host-local Mongo) and bootstraps the Atlas vector index.
8. Applies the Semble index PVC and the Redis Deployment/Service.
9. Builds all three images **inside minikube's own Docker daemon** — images built on
   the host are invisible to the cluster, and Pods use `imagePullPolicy: IfNotPresent`.
10. Applies the dispatcher Deployment/Service, restarts the rollout, waits up to 120s,
    and prints the dispatcher URL.

Every `kubectl` call in the script pins `--context=minikube`. Do the same by hand: this
creates namespaces, RBAC and Secrets, and a developer kubeconfig may be pointing at
production.

### 3. Submit a review

```bash
DISPATCHER_URL=$(minikube service kitten-dispatcher -n kitten --url)

curl -X POST "$DISPATCHER_URL/review" \
  -H "Content-Type: application/json" \
  -d '{"repo":"owner/repo","prNumber":2,"headRef":"feature","baseRef":"main","sender":"me"}'
# → {"jobId":"review-owner-repo-2","status":"queued"}

kubectl --context=minikube logs -f review-owner-repo-2 -n kitten
curl "$DISPATCHER_URL/status/review-owner-repo-2"
```

Expected log progression:

```
[reviewer] Starting review for owner/repo PR #2
[reviewer] Subscribed to review:review-owner-repo-2:messages (pre-pipeline)
[reviewer] Cloning owner/repo...
[reviewer] Clone complete: 4.2MB
[reviewer] Diff: 3 files changed, +82 -14
[reviewer] PR files: 3
[reviewer] Config loaded: language=en, model=deepseek-v4-flash, skip=4 patterns
[reviewer] LLM review complete: 5 findings
[reviewer] PR review posted: 4 inline, 1 in table, event=COMMENT
[reviewer] Job completed in 41.3s
[reviewer] Agent started for job review-owner-repo-2, idle timeout 600000ms
```

With the sidecar there is a second container; add `-c reviewer` or `-c semble` to
`kubectl logs`.

### 4. Iterating

After changing TypeScript, rebuild and re-run the setup script — it rebuilds the images
and restarts the rollout:

```bash
pnpm build && ./scripts/minikube-setup.sh
```

Re-running is safe: every step is idempotent, and Secrets are re-created from whatever
is currently exported. **Exporting nothing on a re-run replaces the webhook secret with
a freshly generated one**, which breaks any webhook already configured on GitHub. Pass
`WEBHOOK_SECRET=<existing>` to keep it stable.

---

## Option C — Amazon EKS with CI deploys

Production-shaped deployment: the cluster is bootstrapped once by a script, and every
push to the deploy branch builds images, pushes them to ECR and rolls out the
dispatcher through GitHub Actions.

**Kitten does not create the cluster.** Bring your own EKS cluster (`eksctl`, Terraform
or the console) with a node group, then bootstrap what runs inside it.

### One-time bootstrap

```bash
EKS_CLUSTER=my-cluster \
EKS_REGION=us-east-1 \
GITHUB_REPO=owner/repo \
GITHUB_TOKEN=<token> \
ANTHROPIC_API_KEY=<key> DEEPSEEK_API_KEY=<key> \
MONGODB_URI=<atlas-uri> VOYAGE_API_KEY=<key> \
  ./scripts/eks-setup.sh
```

Requires an admin kubeconfig for the cluster and the `aws`, `eksctl` and `kubectl`
binaries. Every step is idempotent — re-run it to repair or refresh.

| Step | What it does |
|---|---|
| 1 | `aws eks update-kubeconfig` — points `kubectl` at the cluster. |
| 2 | Associates the GitHub OIDC provider with the cluster (`eksctl utils associate-iam-oidc-provider`). |
| 3 | Creates/refreshes the IAM role `kitten-gh-actions-deploy`. Trust is narrow: `sts:AssumeRoleWithWebIdentity` only for `repo:<owner>/<repo>:ref:refs/heads/<DEPLOY_BRANCH>`. Permissions are ECR push on the three Kitten repositories plus `eks:DescribeCluster`. |
| 4 | Maps the role into the cluster (`aws-auth` → group `kitten-ci-deploy`) and applies `k8s/eks-deploy-rbac.yaml`. |
| 5 | Applies `k8s/namespace.yaml` first, so the Secrets below have somewhere to live. |
| 6 | Creates the real Secrets from exported environment variables. Prints the webhook secret once. |
| 7 | Applies the rest of the infrastructure with `kubectl apply -k k8s`. |
| 8 | Creates the three ECR repositories with scan-on-push. |

Order matters in steps 5–7: the namespace and Secrets exist **before** the dispatcher
Deployment is applied, so the Pod never starts in `CreateContainerConfigError`.

Configurable inputs beyond the required three:

| Variable | Default | Purpose |
|---|---|---|
| `ROLE_NAME` | `kitten-gh-actions-deploy` | IAM role name. |
| `DEPLOY_BRANCH` | `master` | The **only** branch allowed to assume the deploy role. |
| `CI_RBAC_FILE` | `k8s/eks-deploy-rbac.yaml` | Override the CI RBAC manifest. |
| `WEBHOOK_SECRET` | generated | Pass an existing value to keep it stable across re-runs. |

The script finishes by printing the three GitHub repository settings to configure once:

| Kind | Name | Value |
|---|---|---|
| Secret | `AWS_ROLE_ARN` | `arn:aws:iam::<account>:role/kitten-gh-actions-deploy` |
| Variable | `AWS_REGION` | your region |
| Variable | `EKS_CLUSTER` | your cluster name |

> ⚠️ **`DEPLOY_BRANCH` and the workflow trigger must match.** The IAM trust policy names
> one branch and `.github/workflows/deploy.yml` triggers on one branch. If they diverge,
> the deploy either never fires or is rejected by STS with an error that does not point
> at the cause. Both default to `master`, this repository's default branch.

### What the CI does

`.github/workflows/ci.yml` — on pull requests and pushes to `master`: `pnpm lint`,
`pnpm test`, `pnpm build`.

`.github/workflows/deploy.yml` — on pushes to `master` and on manual dispatch:

1. Checks out, installs and runs `pnpm build`. **Required** — the reviewer image copies
   pre-built `packages/*/dist`, which is gitignored.
2. Assumes `AWS_ROLE_ARN` through OIDC (`permissions: id-token: write`). No long-lived
   AWS keys are stored in GitHub.
3. Logs in to ECR, builds the three images and pushes them tagged with `${GITHUB_SHA}`.
4. `kubectl apply -k k8s`, then `kubectl set image` on the dispatcher and `kubectl set
   env` to point `REVIEWER_IMAGE` / `SEMBLE_IMAGE` at the new SHA tags, then waits for
   the rollout (180s timeout).

**`k8s/secret.yaml` is deliberately excluded from `k8s/kustomization.yaml`.** It holds
`REPLACE_ME` placeholders; including it would let every CI deploy clobber the live
Secrets. Secrets are owned by `eks-setup.sh` alone, and the CI's RBAC is read-only on
them.

Images are pulled by reviewer Pods from ECR through the node group's instance role —
no `imagePullSecrets` needed with eksctl-created node groups. Images must be `amd64`
unless your nodes are Graviton.

Because the manifests pin `image: kitten-dispatcher:latest`, the `apply -k` step briefly
resets the Deployment to that tag before `set image` corrects it. The rollout converges
on the SHA-tagged image; the intermediate ReplicaSet is discarded.

### Targeting EKS with the operator scripts

`cleanup-pods.sh`, `e2e-test.sh`, `webhook-e2e.sh` and `deep-context-e2e.sh` all pin
their `kubectl` context and **default to `minikube`**. Point them at EKS explicitly:

```bash
export KUBE_CONTEXT=arn:aws:eks:us-east-1:123456789012:cluster/my-cluster
./scripts/cleanup-pods.sh
```

`minikube-setup.sh` is minikube-only by design and has no such override.

Note that the E2E scripts still resolve `DISPATCHER_URL` through `minikube service`
when it is not exported. On EKS, export it yourself:

```bash
export DISPATCHER_URL=https://<your-ingress-host>
```

---

## Option D — a cluster you do not own

Kitten as a tenant of a cluster that already runs other workloads and has its own
ingress controller and storage conventions. The ready-made overlay in
[`deploy/shared-cluster/`](../deploy/shared-cluster/README.md) adapts the base
manifests **without editing them**, so you can keep taking upstream updates.

### What the overlay changes

| Resource | Base (`kubectl apply -k k8s`) | Overlay (`kubectl apply -k deploy/shared-cluster`) |
|---|---|---|
| `kitten-dispatcher` Service | `NodePort` (for `minikube service`) | `ClusterIP` — reached only through the cluster's ingress |
| `kitten-semble-index` PVC | no `storageClassName` (default class assumed) | explicit `storageClassName` — you supply the value |
| Ingress | none | template for the dispatcher — you supply host, class, TLS secret |

Everything else is byte-identical to the base. The overlay is a **sibling** of `k8s/`
— nesting it under `k8s/overlays/` breaks kustomize with a `cycle detected` error.

### Applying

```bash
# 1. Replace the placeholders: the StorageClass in
#    deploy/shared-cluster/pvc-storageclass-patch.yaml, and the host, ingress
#    class and TLS secret in deploy/shared-cluster/ingress.yaml.
# 2. Apply the overlay:
kubectl apply -k deploy/shared-cluster
# 3. Point DNS at your ingress, then verify:
kubectl get svc kitten-dispatcher -n kitten       # type ClusterIP
kubectl get pvc kitten-semble-index -n kitten     # Bound, with your class
kubectl port-forward svc/kitten-dispatcher 3001:3001 -n kitten
curl localhost:3001/health                         # {"status":"ok",...}
```

Hostnames, ingress classes, certificates and DNS belong to whoever owns the cluster —
the overlay ships a template, not a configured hostname (epic D7).

### Keep CI from reverting it

`deploy.yml` applies `KUSTOMIZE_PATH`, which defaults to `k8s`. Without changing it,
every CI deploy re-applies the base Service (`NodePort`) and drops the PVC patch —
v10's manifests silently undone by v9's automation. Set the `KUSTOMIZE_PATH`
**repository variable** to `deploy/shared-cluster` for this cluster.

### Steering reviewer Pods

On a shared cluster you usually also want review Pods to land on specific nodes — a
burst of pull requests must not compete with production workloads. That is the
dispatcher's `REVIEWER_POD_SCHEDULING` environment variable
([configuration.md](configuration.md#reviewer-pod-scheduling)): node constraints,
taint tolerations and the Pod's ServiceAccount are injected into the Pod manifest at
creation, since the Pod spec is built in code no overlay can reach.

---

## Wiring the GitHub webhook

The dispatcher must be reachable from GitHub. For local development, use the
`cloudflared` quick tunnel bundled in the Compose file — it needs no Cloudflare account
and points at the **minikube** dispatcher (the one that can actually run reviews), not
the Compose one:

```bash
TUNNEL_TARGET=$(minikube service kitten-dispatcher -n kitten --url) \
  docker compose --profile webhook up -d tunnel

docker compose logs tunnel | grep trycloudflare
# → https://<random>.trycloudflare.com
```

Then, in the repository you want reviewed — **Settings → Webhooks → Add webhook**:

| Field | Value |
|---|---|
| Payload URL | `https://<public-host>/webhook/github` |
| Content type | `application/json` |
| Secret | the value printed by `minikube-setup.sh` |
| Events | *Let me select individual events* → **Pull requests**, **Issue comments**, **Pull request review comments** |

What each event buys you:

| Event | Enables |
|---|---|
| Pull requests | Automatic review on open/reopen, in-place re-review on push. |
| Issue comments | `@reviewer force` / `stop` / `remember` / questions. |
| Pull request review comments | Correction capture from replies on findings. |

Verify from GitHub's **Recent Deliveries** tab: a `200 {"ignored":true}` means the
signature passed and the event was simply not one Kitten acts on. A `401` means the
secret does not match. A `503` means `WEBHOOK_SECRET` is not set on the dispatcher.

---

## Enabling the knowledge store

Optional. Without it, `@reviewer remember`, correction capture and knowledge-calibrated
reviews are all off — with a warning, never a failure.

**Requirements:** a MongoDB deployment with Atlas Vector Search (Atlas cluster, or the
`mongodb-atlas-local` container from the Compose file), and a Voyage API key.

```bash
# Local, no Atlas account:
docker compose up -d mongo
export MONGODB_URI="mongodb://localhost:27021/?directConnection=true"
export VOYAGE_API_KEY=<key>

# Voyage keys provisioned through MongoDB Atlas ("AI Models" in the Atlas UI)
# only work against this host. Keys created at voyageai.com need no override.
export VOYAGE_BASE_URL=https://ai.mongodb.com

./scripts/minikube-setup.sh
```

The setup script runs `scripts/atlas-bootstrap.mjs`, which idempotently creates the
`knowledge_vector_index` on `kitten.knowledge`:

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

Index builds are asynchronous. Until it reaches `READY`, searches return empty and
reviews simply run without knowledge. Poll with `listSearchIndexes`.

Running the bootstrap by hand:

```bash
MONGODB_URI="mongodb://localhost:27021/?directConnection=true" \
  node scripts/atlas-bootstrap.mjs
```

---

## End-to-end verification

Three suites, all requiring a running minikube stack. They target
`XamuAvila/kitten-test-repo` PR #2 by default — point them at your own fixture repo by
editing the script constants.

```bash
# Full lifecycle: submit → Pod → review → follow-up → idle shutdown → Pod exit
IDLE_TIMEOUT=30 ./scripts/e2e-test.sh

# Signed webhook deliveries: ignored event, bad signature → 401,
# pull_request opened → Pod, synchronize → in-place re-review, @reviewer stop → cancelled
./scripts/webhook-e2e.sh

# Knowledge round-trip: @reviewer remember → Atlas insert → injected into the next review
# (skips loudly without MONGODB_URI / VOYAGE_API_KEY)
./scripts/deep-context-e2e.sh
```

`e2e-test.sh` asserts `followUpCount == 1` after one follow-up. A `2` means the
dispatcher started double-counting on publish — a regression the assertion exists to
catch.

---

## Operations

**Removing finished Pods.** Reviewer Pods have `restartPolicy: Never` and stay in
`Succeeded`/`Failed` after exiting, holding their logs:

```bash
./scripts/cleanup-pods.sh                          # minikube context, namespace kitten
K8S_NAMESPACE=kitten ./scripts/cleanup-pods.sh     # explicit namespace
KUBE_CONTEXT=<eks-context> ./scripts/cleanup-pods.sh   # target EKS instead
```

**Inspecting jobs:**

```bash
kubectl --context=minikube get pods -n kitten -l app=kitten-reviewer
kubectl --context=minikube logs <job-id> -n kitten -c reviewer
kubectl --context=minikube logs <job-id> -n kitten -c semble
kubectl --context=minikube exec -it deploy/redis -n kitten -- redis-cli KEYS 'review:*'
```

**Cancelling a stuck review.** Prefer the API — it lets the Pod shut down cleanly and
report `cancelled`:

```bash
curl -X POST "$DISPATCHER_URL/review/<job-id>/message" \
  -H "Content-Type: application/json" \
  -d '{"message":"stop","sender":"ops"}'
```

Deleting the Pod directly sends SIGTERM, which the agent handles as a clean shutdown to
`completed` — but only after the review is past the pipeline stage.

**Rotating the webhook secret:** re-run `minikube-setup.sh` with the new
`WEBHOOK_SECRET` exported, then update it in the GitHub webhook settings. The
dispatcher reads it at startup, so the rollout restart the script performs is required.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `POST /review` → `503 Cannot create review pod` | No Kubernetes API (Compose), RBAC missing, or a Pod with that name already exists. | Use minikube; apply `k8s/rbac.yaml`; delete the previous Pod. |
| `minikube image build` fails on `COPY packages/*/dist` | `pnpm build` was not run. | `pnpm build`, then re-run the setup script. |
| Pod `CrashLoopBackOff`, logs show `Missing required env vars` | Pod created by an older dispatcher, or a Secret is absent. | Re-run `minikube-setup.sh`. |
| `[reviewer] Fatal: [AUTH_FAILED] Missing DEEPSEEK_API_KEY for base_url ...` | The repo's `base_url` maps to a key that was never seeded. | Export that key and re-run the setup script. |
| `[reviewer] Fatal: [NOT_FOUND] Repository not found or inaccessible` | Bad/expired GitHub token, or no access to the repo. | Check the token's scopes; note the error deliberately masks the token as `***`. |
| Review runs but ignores `.reviewer.yml` | The file is invalid — the parse error is swallowed and defaults are used. | Validate the YAML and the key names; unknown keys are rejected. |
| `Agentic mode enabled` never logged despite `.reviewer-mcp.json` | Invalid JSON or an unknown key → warning + fallback to monolithic. | Check the Pod logs for `Invalid .reviewer-mcp.json`. |
| `semantic_search` never appears | `SEMBLE_IMAGE` unset, or the tool is not in the `tools` whitelist. | Set `SEMBLE_IMAGE`; check `.reviewer-mcp.json`. |
| First `semantic_search` returns `SERVICE_UNAVAILABLE` | The sidecar is still building the index / downloading the embedding model. | Ensure `HF_HOME` points at the PVC so the model is cached across runs. |
| `Knowledge store disabled` at boot | `MONGODB_URI` or `VOYAGE_API_KEY` missing. | Seed `kitten-knowledge-secrets`. |
| `remember` acknowledged but nothing is retrieved | Vector index still building, or built with the wrong dimensions. | `listSearchIndexes` must show `READY` with `numDimensions: 1024`. |
| Webhook → `401` | Secret mismatch, or a proxy re-serialized the body. | Confirm the secret; the HMAC covers the exact raw bytes. |
| Webhook → `503` | `WEBHOOK_SECRET` unset on the dispatcher. | Seed the Secret and restart the rollout. |
| Review posted as `COMMENT` despite `request_changes` | GitHub rejects a change request on your own PR. | Expected — the posted note says so. Use a separate bot account to gate merges. |
| CI/deploy workflow never runs | The push went to a branch the trigger does not list. | The trigger and `DEPLOY_BRANCH` both default to `master`; keep them in sync. |
| Deploy fails at "Configure AWS credentials" with an STS trust error | The pushed branch is not the one in the IAM trust policy, or `AWS_ROLE_ARN` is unset/wrong. | Re-run `eks-setup.sh` with the right `DEPLOY_BRANCH`; check the repo Secret. |
| Workflow fails on the `pnpm/action-setup` step | No `version` input and no `packageManager` field in `package.json` — the action cannot resolve a version. | Both workflows pin `version: 11`; keep it, or add `packageManager` to `package.json`. |
| Deploy pushes images but the rollout times out | Nodes cannot pull from ECR, or the images are the wrong architecture. | Confirm the node role has `AmazonEC2ContainerRegistryReadOnly`; build `amd64` images for x86 node groups. |
| `kubectl apply -k k8s` wiped a Secret | Should be impossible — `secret.yaml` is excluded from the kustomization. | If it happened, something re-added it; re-run `eks-setup.sh` to restore the real Secrets. |
| Reviewer Pod stays `Pending`; `kubectl describe pod` reports `FailedScheduling` | `REVIEWER_POD_SCHEDULING` constrains the Pod to nodes that do not exist / are not schedulable. | Correct behavior, not a bug — no matching node means no Pod. Add the label/taint or fix the constraint. |
| PVC `kitten-semble-index` stays `Pending` | The cluster marks no StorageClass as default, and the overlay's `storageClassName` is not pinned. Because the reviewer Pod mounts the PVC, **the Pod never schedules at all** — a hard failure, invisible until you read the PVC events. | Pin `storageClassName` in `deploy/shared-cluster/pvc-storageclass-patch.yaml` and re-apply, or leave `SEMBLE_INDEX_PVC` unset on the dispatcher to fall back to `emptyDir`. |
| Overlay apply fails on the PVC with `spec: Forbidden: spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims` | `spec.storageClassName` cannot change on an already-bound PVC. | The index is derived data — `kubectl delete pvc kitten-semble-index -n kitten`, then re-apply. Semble rebuilds it incrementally. |
| Every CI deploy reverts the Service to `NodePort` / drops the overlay's PVC patch | `KUSTOMIZE_PATH` is unset, so `deploy.yml` applies the base (`k8s`). | Set the `KUSTOMIZE_PATH` repository variable to `deploy/shared-cluster`. |

---

## Production considerations

Kitten is `0.0.1` and has been exercised on minikube. Before running it against real
repositories at scale, at minimum:

- **Authenticate the operational endpoints.** `POST /review`, `GET /status/:jobId` and
  `POST /review/:jobId/message` have no authentication. Only `/webhook/github` verifies
  its caller. Restrict them to in-cluster traffic or put an authenticating ingress in
  front.
- **Remove the `[KITTEN-TEST]` marker** from posted comments before letting real
  reviewers see them (`packages/reviewer/src/github/`).
- **Use a dedicated bot account** for the GitHub token, so `request_changes` works and
  the reviewer's own comments are correctly identified as `Bot`.
- **Give Redis persistence or accept the loss.** Job status lives only in Redis; losing
  it orphans live Pods from the dispatcher's view (they still exit on their idle timer).
- **Cap concurrency.** Nothing limits how many reviewer Pods can exist at once. A busy
  organization can exhaust the node pool; use a `ResourceQuota` on the namespace.
- **Watch the LLM spend.** Budgets are per review, not per repository or per day. There
  is no global cost ceiling.
- **Scope the token per repository.** The reviewer receives one token with access to
  everything that token can reach.
