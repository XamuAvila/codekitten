# US-042 — Deploy on a Cluster You Do Not Own

**As a** platform operator deploying Kitten into an existing cluster that already has its own ingress controller and storage conventions,
**I want** a ready-made manifest layer that adapts Kitten to those conventions without editing its base manifests
**so that** I can install it as a well-behaved tenant and still take upstream updates.

## Context

The base manifests target a cluster Kitten owns: the dispatcher Service is `NodePort`
because the documented quickstart drives it with `minikube service`, and the Semble
index PVC declares no `storageClassName` because minikube has a default one. Both
assumptions break on a borrowed cluster — the second one fatally, since a `Pending`
PVC prevents the reviewer Pod from scheduling at all.

## Acceptance Criteria

### AC-1 — The overlay renders the shared-cluster form
**Given** the shared-cluster overlay
**When** the operator runs `kubectl kustomize` against it
**Then** the output contains the dispatcher Service as `ClusterIP`, the Semble index PVC carrying an explicit `storageClassName`, and an Ingress resource — and every other resource is byte-identical to the base.

### AC-2 — The base is untouched
**Given** the overlay exists
**When** the operator renders the base with `kubectl kustomize k8s`
**Then** the dispatcher Service is still `NodePort` and the PVC still declares no `storageClassName`, so the minikube quickstart and the dedicated-cluster deploy path behave exactly as before.

### AC-3 — CI deploys do not revert the overlay
**Given** a cluster deployed from the overlay and a CI pipeline that applies manifests on every push
**When** a deploy runs
**Then** it applies the overlay rather than the base, and the Service type and PVC storage class survive the deploy unchanged.

### AC-4 — The ingress is a template, not a guess
**Given** the Ingress shipped by the overlay
**When** an operator opens it
**Then** the host, the ingress class and the TLS secret are clearly marked as values they must replace, and the file documents that DNS and certificate provisioning are theirs to arrange.

### AC-5 — The fatal failure mode is documented
**Given** an operator whose cluster marks no StorageClass as default
**When** they consult the deployment documentation
**Then** they find that the PVC stays `Pending`, that this stops the reviewer Pod from scheduling at all rather than merely disabling semantic search, and both remedies: pin `storageClassName`, or leave `SEMBLE_INDEX_PVC` unset to fall back to `emptyDir`.

### AC-6 — Installing on a real shared cluster works end to end
**Given** a cluster with an ingress controller and a named StorageClass
**When** the operator applies the overlay and points DNS at their ingress
**Then** `GET /health` answers over the ingress, and a submitted review creates a Pod that reaches `reviewing`.

## Out of Scope

- Registry repositories, IAM roles, external secret wiring, DNS records and
  certificates — these belong to whoever owns the target cluster.
- Helm packaging or GitOps.
- Any overlay named after a specific organization.

## Notes

AC-1 through AC-4 are provable with `kubectl kustomize` and no cluster. AC-6 is the
manual end-to-end verification. AC-3 exists because the deploy automation currently
hardcodes the base path — without it, this story's manifests would be silently undone
on the next push.
