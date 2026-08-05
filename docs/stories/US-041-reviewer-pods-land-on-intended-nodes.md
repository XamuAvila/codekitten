# US-041 — Reviewer Pods Land on the Intended Nodes

**As a** platform operator running Kitten on a cluster shared with other workloads,
**I want** to control which nodes reviewer Pods are scheduled onto
**so that** a burst of pull requests cannot compete for capacity with the production services running beside it.

## Context

The reviewer Pod spec is built in TypeScript (`packages/dispatcher/src/k8s/manifest.ts`),
not in a YAML manifest, so no kustomize overlay can reach it. Today it carries no
`nodeSelector`, no `tolerations` and no `serviceAccountName`: on a cluster whose node
groups are partitioned by taint, review Pods land wherever the scheduler puts them.

## Acceptance Criteria

### AC-1 — Scheduling constraints reach the Pod
**Given** the dispatcher is started with `REVIEWER_POD_SCHEDULING` set to a valid JSON object declaring `nodeSelector`, `tolerations` and `serviceAccountName`
**When** a review is dispatched and the Pod manifest is built
**Then** the resulting Pod spec carries each of those three fields with exactly the values supplied.

### AC-2 — No configuration means no change
**Given** the dispatcher is started without `REVIEWER_POD_SCHEDULING`, or with it set to an empty string
**When** a review is dispatched and the Pod manifest is built
**Then** the Pod spec contains none of the three fields, and is otherwise identical to the spec produced before this story.

### AC-3 — An invalid value stops the rollout
**Given** `REVIEWER_POD_SCHEDULING` is set but is not parseable — malformed JSON, an unknown key, or a value outside the allowed set for `effect` or `operator`
**When** the dispatcher starts
**Then** it logs a structured error carrying the code `VALIDATION`, a message, and details naming the offending field, and exits with a non-zero status without serving any request.

### AC-4 — Partial configuration is accepted
**Given** `REVIEWER_POD_SCHEDULING` declares only one of the three fields — for example `nodeSelector` alone
**When** the Pod manifest is built
**Then** that field is present and the other two are absent, with no error.

### AC-5 — Kubernetes-valid tolerations are not rejected
**Given** a toleration expressed as `{ "operator": "Exists" }`, which Kubernetes accepts on its own to tolerate every taint
**When** the value is parsed
**Then** it is accepted, because the schema must not be narrower than the Kubernetes API it feeds.

### AC-6 — The operator can see where a Pod landed
**Given** a review Pod created with scheduling constraints on a real cluster
**When** the operator runs `kubectl get pod <job-id> -n kitten -o wide`
**Then** the node shown belongs to the node group targeted by the configuration; and when no node matches, `kubectl describe pod` reports `FailedScheduling` rather than the Pod running somewhere unintended.

## Out of Scope

- Configurable Pod resources (requests/limits) — still hardcoded.
- Configurable Secret names.
- `affinity`, `priorityClassName`, `topologySpreadConstraints`, `imagePullSecrets`.
- Creating the ServiceAccount that `serviceAccountName` refers to.
- Scheduling controls for the dispatcher Deployment.

## Notes

AC-1 to AC-5 are provable with unit tests and no cluster. AC-6 is the manual
verification that the spec fields actually produce the intended placement — it is the
only criterion that requires a real cluster, and it is what makes this story a slice of
value rather than a schema exercise.
