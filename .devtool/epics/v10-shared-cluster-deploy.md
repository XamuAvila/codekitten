---
id: v10-shared-cluster-deploy
title: "v10: Shared-Cluster Deployment"
status: done
created: "2026-08-05"
---

# v10: Shared-Cluster Deployment

> Kitten becomes deployable on a cluster it does not own. The operator gains
> control over **where reviewer Pods land** and a ready-made overlay for
> clusters that already have their own ingress and storage conventions. The
> minikube path (v2) and the EKS path (v9) stay untouched and green; nothing in
> the product learns the name of any deployment.

## Problem

v9 made Kitten deployable on a dedicated EKS cluster. It did not make Kitten a
good tenant of a cluster that already runs something else. Three gaps, found
while assessing a real shared cluster:

1. **Reviewer Pods cannot be steered.** `buildPodManifest` emits no
   `nodeSelector`, no `tolerations`, no `serviceAccountName` — and the Pod spec
   is built in TypeScript, so **no kustomize overlay can reach it**. On a
   cluster whose node groups are partitioned by taint, review Pods land
   wherever the scheduler puts them, competing with production workloads. A
   pull-request burst becomes node pressure on someone else's service.
2. **The dispatcher Service is `NodePort`.** Correct for `minikube service`,
   unreachable on a cluster whose nodes sit in private subnets behind an
   existing ingress controller.
3. **The Semble index PVC declares no `storageClassName`.** It relies on a
   default StorageClass existing. Where none is marked default the PVC stays
   `Pending` — and because the reviewer Pod mounts it, **the Pod never
   schedules at all**. This is a hard failure, not a degradation, and it is
   invisible until someone reads the PVC events.

Gap 1 is the only one that requires code. Gaps 2 and 3 are one line of YAML
each — but they have no home today, because the base manifests must keep
serving the documented minikube quickstart.

## Solution (v10 scope)

Two layers, matching the two kinds of gap:

- **`PodConfig.scheduling` — code.** One optional, Zod-validated field carrying
  `nodeSelector`, `tolerations` and `serviceAccountName`, supplied to the
  dispatcher as JSON in a single environment variable and spread into the Pod
  spec when present.
- **`deploy/shared-cluster/` — manifests.** A kustomize overlay over the
  existing `k8s/` base that patches the Service to `ClusterIP`, adds an
  `Ingress` template and pins `storageClassName` on the PVC. The base is not
  modified. The overlay is a **sibling** of `k8s/`, not a child — see D9.

### Key decisions

- **Configuration object, not Strategy.** The variation between deployments is
  **data** (which node label, which toleration), not **behavior**. There is one
  algorithm for building a review Pod and every deployment uses it. A
  `PodManifestStrategy` with per-deployment implementations would duplicate the
  whole construction to change two fields, put deployment names inside a
  white-label product, and require a code change plus a release for every new
  cluster. Contrast with `LLMAdapter`, where Strategy earns its keep: Anthropic
  and OpenAI genuinely differ in wire format (`input_schema` vs
  `function.parameters`, `tool_choice: {type:"tool"}` vs `{type:"function"}`,
  `tool_use` blocks vs `tool_calls`). That is behavior. `nodeSelector` is a value.
- **One JSON environment variable, not flat variables.** `nodeSelector` is a
  map and `tolerations` is a list of objects; neither survives a flat string
  without a bespoke parser, and a bespoke parser cannot express `operator` or
  `tolerationSeconds`. `REVIEWER_POD_SCHEDULING` carries the whole object and is
  validated by a single Zod schema at the boundary — the same shape as
  `.reviewer.yml` and `.reviewer-mcp.json` parsing.
- **Fail fast at boot, deliberately breaking the epic error-table pattern.**
  See [Invariant and error-table amendments](#invariant-and-error-table-amendments).
- **The base manifests keep serving minikube.** `dispatcher-service.yaml` stays
  `NodePort` because `minikube service` — used by the README quickstart,
  `AGENTS.md`, `e2e-test.sh`, `webhook-e2e.sh` and `deep-context-e2e.sh` —
  requires it. Shared-cluster differences live in the overlay.
- **Absent scheduling produces a byte-identical Pod spec.** The three fields are
  conditionally spread. This is the regression contract: the 15 existing tests
  in `packages/dispatcher/tests/k8s/manifest.test.ts` must pass **without
  edits**. A test that needs changing means the implementation is wrong.
- **Scheduling is dispatcher-local, not shared.** `PodSchedulingSchema` lives in
  `packages/dispatcher/src/k8s/`, beside `PodConfig`. `@kitten/shared` holds
  contracts crossing package boundaries; the reviewer never sees this type.

## Types

```ts
// packages/dispatcher/src/k8s/scheduling.ts
//
// strictObject at every level: an unknown key is a VALIDATION error, never a
// silent strip — same rationale as RawReviewerSchema (parse-config.ts) and
// MCPConfigSchema (mcp-config.ts). A typo in a scheduling key must not be
// swallowed, because the visible symptom would be Pods on the wrong nodes.

const TolerationSchema = z.strictObject({
  key: z.string().min(1).optional(),
  operator: z.enum(["Equal", "Exists"]).optional(),
  value: z.string().optional(),
  effect: z.enum(["NoSchedule", "PreferNoSchedule", "NoExecute"]).optional(),
  tolerationSeconds: z.number().int().nonnegative().optional(),
});

export const PodSchedulingSchema = z.strictObject({
  nodeSelector: z.record(z.string(), z.string()).optional(),
  tolerations: z.array(TolerationSchema).readonly().optional(),
  serviceAccountName: z.string().min(1).optional(),
});

export type PodScheduling = z.infer<typeof PodSchedulingSchema>;

/**
 * Parses REVIEWER_POD_SCHEDULING. Empty/absent → undefined (current behavior).
 * Invalid JSON or schema violation → AppError VALIDATION; the caller exits.
 */
export function parsePodScheduling(json: string | undefined): PodScheduling | undefined;
```

Every `TolerationSchema` field is optional because Kubernetes accepts a
toleration such as `{ "operator": "Exists" }` on its own — an empty toleration
tolerates everything. Narrowing this would reject valid Kubernetes input.

**Type friction to expect during implementation.** `z.array(...).readonly()`
infers `readonly Toleration[]`, but `V1PodSpec.tolerations` is declared
`Array<V1Toleration>` (verified in `@kubernetes/client-node@1.4.0`,
`dist/gen/models/V1PodSpec.d.ts:175`). Assigning the former to the latter is a
compile error. `buildPodManifest` copies with a spread — `[...tolerations]` —
keeping the config object immutable per the repo standard while satisfying the
mutable K8s type. `nodeSelector` needs no such copy: `z.record` infers
`Record<string, string>`, which matches the declared shape.

`PodConfig` grows by exactly one optional field:

```ts
export interface PodConfig {
  readonly namespace: string;
  readonly image: string;
  readonly idleTimeoutMs: number;
  readonly redisUrl: string;
  readonly sembleImage?: string;
  readonly sembleIndexPvc?: string;
  /** Scheduling controls for the reviewer Pod (v10). Absent → unchanged spec. */
  readonly scheduling?: PodScheduling;
}
```

## Invariant and error-table amendments

- **No new cross-job state.** The two designated stores (Semble index PVC,
  Atlas `knowledge` collection) remain the only state crossing a job boundary.
  v10 changes where a Pod runs, never what persists.
- **Error-table exception — this epic fails fast where v3–v7 degrade.** The
  established pattern is that an optional capability whose configuration is
  missing or broken logs a warning and the review proceeds: missing knowledge
  secrets, an absent Semble sidecar, an invalid `.reviewer.yml`, an invalid
  `.reviewer-mcp.json`. **`REVIEWER_POD_SCHEDULING` deliberately does not follow
  it.** Those capabilities degrade into a *less informed* review, which is a
  smaller harm than failing. Ignoring broken scheduling degrades into review
  Pods scheduled onto production nodes — precisely the outcome the setting
  exists to prevent, and invisible until it causes an incident on a workload
  that is not Kitten's. Absent is fine and means "no constraints". Present and
  invalid is an operator error that must stop the rollout.
- **Same-commit doc rule** applies: `docs/configuration.md` (the new variable
  and the overlay), `docs/deployment.md` (shared-cluster section and the PVC
  `Pending` failure mode), `docs/architecture.md` (the Pod-spec surface) and
  `README.md` ship with the code that changes them.

## Implementation Cards

**Prerequisite — KIT-050 (epic v9).** The overlay resolves `resources:
[../../k8s]`, which requires `k8s/kustomization.yaml`. That file is KIT-050's
deliverable, not v10's.

This dependency was not respected on the first pass: `deploy/shared-cluster/`
and `deploy.yml` were committed while `k8s/kustomization.yaml` stayed
untracked, so a clean checkout could render neither — US-042 AC-1 was false on
`master` even though the epic was marked done. Fixed by committing and closing
KIT-050. Anyone reordering or re-running this epic must land KIT-050 first, and
must verify the overlay from a **clean checkout** (`git archive HEAD`), not
from a working tree where untracked files paper over the gap.

Execution order (sequential — KIT-053 documents the variable KIT-052 introduces):

| Card | Story | Scope |
|---|---|---|
| [KIT-052](../features/done/KIT-052-pod-scheduling-config.md) | [US-041](../../docs/stories/US-041-reviewer-pods-land-on-intended-nodes.md) | `scheduling.ts` (schema + `parsePodScheduling`), `PodConfig.scheduling`, conditional spread in `buildPodManifest`, boot wiring in `dispatcher/src/index.ts` with fail-fast, and moving `zod` to `dependencies` (D10) |
| [KIT-053](../features/done/KIT-053-shared-cluster-overlay.md) | [US-042](../../docs/stories/US-042-deploy-on-a-cluster-you-dont-own.md) | `deploy/shared-cluster/` (ClusterIP patch, Ingress template, PVC `storageClassName`), `KUSTOMIZE_PATH` in `deploy.yml` (D11), docs alignment across `configuration.md`, `deployment.md`, `architecture.md`, `README.md` |

## Architecture

```
Boot (dispatcher/src/index.ts)
  REVIEWER_POD_SCHEDULING (env, JSON)
    │
    ├─ absent/empty ──► undefined ──────────────┐
    │                                           │
    └─ present ──► parsePodScheduling()         │
                     │                          │
                     ├─ invalid ──► console.error({code,message,details})
                     │                └─► process.exit(1)   (rollout blocked,
                     │                                       previous ReplicaSet
                     │                                       keeps serving)
                     └─ valid ─────────────────►┤
                                                ▼
                                    PodConfig.scheduling?

Per review (k8s/manifest.ts)
  buildPodManifest(job, config)
    spec: {
      restartPolicy: "Never",
      containers: [...],                      // unchanged
      ...(scheduling?.nodeSelector       ? { nodeSelector }       : {}),
      ...(scheduling?.tolerations        ? { tolerations }        : {}),
      ...(scheduling?.serviceAccountName ? { serviceAccountName } : {}),
      ...(withSidecar ? { volumes: [...] } : {}),
    }
```

Manifest layering:

```
k8s/                                  base — NodePort Service, PVC without a
  kustomization.yaml                  storageClassName. Serves minikube and the
  dispatcher-service.yaml             v9 EKS path unchanged. Paths referenced by
  semble-index-pvc.yaml               README, AGENTS.md and every script stay put.
  …
deploy/shared-cluster/                overlay — SIBLING of k8s/, never a child.
  kustomization.yaml                    resources: [../../k8s]
  service-clusterip-patch.yaml        patches only what a tenant of someone
  pvc-storageclass-patch.yaml         else's cluster must change.
  ingress.yaml
```

Applied with `kubectl apply -k deploy/shared-cluster`. The v9 command
(`kubectl apply -k k8s`) keeps working untouched for dedicated clusters.

## Stack

| Component | Technology | Notes |
|---|---|---|
| Schema/validation | `zod` (already a dependency) | `strictObject`, mirrors the existing config parsers |
| Pod types | `@kubernetes/client-node` `V1Toleration` | The schema mirrors the K8s type; no new dependency |
| Config transport | Single env var `REVIEWER_POD_SCHEDULING` | JSON, read once at boot |
| Manifest layering | `kubectl apply -k` (kustomize built into kubectl; verified against v5.8.1) | Overlay references the base with `resources: [../../k8s]` |
| Tests | `vitest` | Unit only — no cluster required |

No new runtime dependencies.

## Error handling

| Error | Behavior |
|---|---|
| `REVIEWER_POD_SCHEDULING` absent or empty | `undefined`. Pod spec identical to today. No log noise. |
| Invalid JSON | `AppError VALIDATION` with the parser message in `details`; dispatcher logs it and exits 1. |
| Unknown key (e.g. `nodeSelectors`) | `AppError VALIDATION` listing the offending path; exit 1. `strictObject` is what catches this. |
| Invalid `effect` or `operator` value | `AppError VALIDATION` naming the field and the allowed values; exit 1. |
| Valid scheduling, no node matches | Not Kitten's error. The Pod stays `Pending`; `kubectl describe pod` reports `FailedScheduling`. Documented in the deployment troubleshooting table. |
| `serviceAccountName` names an SA that does not exist | Not Kitten's error, and **Kitten creates no ServiceAccount**. The Pod is rejected with `error looking up service account kitten/<name>`. The reviewer needs no Kubernetes permissions at all, so the only reason to set this is to move off the namespace `default` SA. Documented in `configuration.md` alongside the field. |
| PVC `Pending` for lack of a StorageClass | Reviewer Pod never schedules. Documented, with the overlay's `storageClassName` patch as the fix and `SEMBLE_INDEX_PVC` unset as the escape hatch. |
| Overlay applied over an **existing** PVC | `spec.storageClassName` is immutable on a bound PVC, so the patch is expected to be rejected. The index is derived data: delete the PVC and re-apply. **Verified on minikube (2026-08-05):** the apply is rejected verbatim with `spec: Forbidden: spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims` (plus an RFC 1123 error when the placeholder is still in place); patching to the already-stored value is an accepted no-op. Recorded in the KIT-053 card and the deployment troubleshooting table. |

Structured errors everywhere: `{ code, message, details }`.

## Recorded decisions (v10 brainstorm — 2026-08-05)

| # | Question | Decision |
|---|---|---|
| D1 | Strategy pattern for per-deployment Pod construction? | **No.** The variation is data, not behavior — one algorithm, different values. Strategy would duplicate the construction, embed deployment names in a white-label product, and demand a release per cluster. Revisit only if a deployment needs a structurally different workload (`Job`, KEDA `ScaledJob`, Fargate profile), which would be two genuine algorithms. |
| D2 | What becomes configurable? | **Scheduling only** — `nodeSelector`, `tolerations`, `serviceAccountName`. These are the only fields that are impossible to influence from outside the code today. Resources and Secret names stay hardcoded; their defaults are livable and widening the surface without a demonstrated need is speculative. |
| D3 | How do the values reach the dispatcher? | **One env var holding JSON** (`REVIEWER_POD_SCHEDULING`), Zod-validated at boot. Flat variables would need two bespoke parsers and could not express `operator`/`tolerationSeconds`; a mounted ConfigMap would add a volume to every deployment for a value that changes at rollout frequency. |
| D4 | Invalid value → degrade or fail? | **Fail fast, exit 1.** Explicitly breaks the v3–v7 error-table pattern; rationale recorded under [Invariant and error-table amendments](#invariant-and-error-table-amendments). |
| D5 | Change the base Service to `ClusterIP`? | **No.** `minikube service` requires `NodePort` and is used by the documented quickstart and three E2E scripts. Breaking the dev loop for a production convenience is the wrong trade; the overlay patches it instead. |
| D6 | Set `storageClassName` in the base PVC? | **No.** Any value would be wrong somewhere (`gp3-csi` on one cluster, `standard` on minikube). The base stays unset — correct wherever a default StorageClass exists — and the overlay pins it. The failure mode is documented because it is silent and fatal. |
| D7 | Epic scope | **Code plus generic manifests.** Registry, IAM, external secret wiring, ingress hostnames and DNS belong to whoever owns the target cluster, not to this repository. |
| D8 | Where does the schema live? | **`packages/dispatcher/src/k8s/`**, beside `PodConfig`. `@kitten/shared` is for contracts crossing package boundaries; the reviewer never sees this type. |
| D9 | Where does the overlay live? | **`deploy/shared-cluster/`, a sibling of `k8s/`** — not `k8s/overlays/shared-cluster/`. Verified by probe during this brainstorm (kustomize v5.8.1, 2026-08-05): a nested overlay fails with `cycle detected: candidate root '…/k8s' contains visited root '…/k8s/overlays/shared-cluster'`. The sibling layout renders correctly, patching `kitten-dispatcher` to `ClusterIP` and the PVC to a pinned `storageClassName` while leaving the `redis` Service untouched. This also preserves v9 D6's constraint: no file under `k8s/` moves, so every doc and script path stays valid. |
| D10 | `zod` is a `devDependency` of `@kitten/dispatcher` | **Move it to `dependencies` as part of KIT-052.** Pre-existing debt surfaced while planning: `webhook/events.ts` already does `import { z } from "zod"` at runtime, and it only works because the dispatcher Dockerfile runs `pnpm install --frozen-lockfile` without `--prod`. v10 adds a second runtime import, so the epic fixes the declaration rather than deepening the smell. |
| D11 | The v9 deploy workflow would silently revert the overlay | **`deploy.yml` gains a `KUSTOMIZE_PATH` repository variable, defaulting to `k8s`.** `.github/workflows/deploy.yml:78` hardcodes `kubectl apply -k k8s`; on a shared cluster that re-applies the base Service (`NodePort`) and drops the PVC patch on **every** deploy — v10's manifests undone by v9's automation, with no error anywhere. Making the path a variable is the smallest fix that keeps the dedicated-cluster default untouched. Folded into KIT-053. |
| D12 | `automountServiceAccountToken: false` on the reviewer Pod | **Out of v10 — carded in v8 as KIT-054.** Found during this brainstorm: the reviewer Pod runs as the namespace `default` ServiceAccount, which `k8s/rbac.yaml:20-22` binds to the `kitten-pod-manager` Role (`create/delete/get/list/watch` on pods). Its token is automounted, so the container executing LLM-directed tool calls carries a credential that can create and destroy Pods. Not exploitable today — no tool performs arbitrary HTTP — but it is credential minimization, the same concern as US-039 AC-3 (the Semble subprocess not inheriting Pod secrets). It belongs to the security epic, not to a deployment epic. |

## What is NOT in v10 (out-of-scope)

- Configurable Pod **resources** (requests/limits) for the reviewer or the
  sidecar — still hardcoded in `manifest.ts` (D2).
- Configurable **Secret names** — `kitten-github-token`, `kitten-llm-keys` and
  `kitten-knowledge-secrets` stay fixed (D2).
- `imagePullSecrets`, `affinity`, `priorityClassName`, `topologySpreadConstraints`
  and any other Pod-spec field beyond the three named above.
- `automountServiceAccountToken: false` on the reviewer Pod — real finding,
  carded in v8 as KIT-054 because it is credential minimization, not deployment
  (D12).
- Scheduling controls for the **dispatcher** Deployment. v10 steers reviewer
  Pods only. An operator who needs the dispatcher pinned can patch it in their
  own overlay; a first-class knob waits for a demonstrated need.
- Creating a `ServiceAccount` for the reviewer. `serviceAccountName` selects an
  existing one; nothing in Kitten provisions it.
- A `ResourceQuota` or any concurrency ceiling on simultaneous reviewer Pods.
  Real gap, separate concern — carded independently if pursued.
- Anything specific to a named deployment: registry repositories, IAM roles,
  External Secrets manifests, ingress hostnames, DNS records.
- Helm packaging or GitOps (ArgoCD, Flux).
- Exposing the dispatcher publicly on the v9 EKS path — the overlay ships an
  Ingress **template**, not a configured hostname or certificate.

## Testing strategy

| Level | What |
|---|---|
| Unit — `parsePodScheduling` | absent/empty → `undefined`; valid JSON → typed object; malformed JSON → `VALIDATION`; unknown key → `VALIDATION`; invalid `effect`/`operator` → `VALIDATION`; toleration with only `operator: "Exists"` → accepted |
| Unit — `buildPodManifest` | without `scheduling`, `spec` carries none of the three fields; with `scheduling`, each field is present and equal to the input |
| Regression | The 15 existing tests in `manifest.test.ts` pass **unedited**. This is the contract that absent scheduling changes nothing. |
| Static | `kubectl kustomize deploy/shared-cluster` renders with `kitten-dispatcher` as `ClusterIP` and the PVC carrying `storageClassName`, and leaves the `redis` Service untouched; `kubectl apply --dry-run=client -k deploy/shared-cluster` parses |
| Regression (v9) | `kubectl kustomize k8s` still renders the dedicated-cluster form — `kitten-dispatcher` as `NodePort`, PVC without a `storageClassName`. The overlay must not leak into the base. |
| Repo-wide | `pnpm test && pnpm lint` green |

TDD is mandatory: each test above is written and observed failing before the
implementation that satisfies it. Coverage target 80%+, as everywhere.

## Dependency verification (2026-08-05)

No new packages. `@kubernetes/client-node` is already a direct dependency of
`@kitten/dispatcher`, and kustomize ships inside `kubectl` (verified against
v5.8.1).

One **declaration** changes: `zod` moves from `devDependencies` to
`dependencies` in `packages/dispatcher/package.json` (D10). It is already
imported at runtime by `packages/dispatcher/src/webhook/events.ts`, so this
corrects an existing mis-declaration rather than adding a dependency.
