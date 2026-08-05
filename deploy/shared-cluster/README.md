# Shared-Cluster Overlay

Kitten as a well-behaved tenant of a cluster it does not own. This overlay
adapts the [base manifests](../../k8s/) to clusters that already have their
own ingress controller and storage conventions, **without editing the base**.

## What it changes

| Resource | Base (`kubectl apply -k k8s`) | Overlay (`kubectl apply -k deploy/shared-cluster`) |
|---|---|---|
| `kitten-dispatcher` Service | `NodePort` (for `minikube service`) | `ClusterIP` — reached only through the cluster's ingress |
| `kitten-semble-index` PVC | no `storageClassName` (default class assumed) | explicit `storageClassName` — see below |
| Ingress | none | template for the dispatcher — see below |

Every other resource is byte-identical to the base. The overlay is a sibling
of `k8s/`, not a child: a nested `k8s/overlays/…` fails kustomize with
`cycle detected` (epic D9).

## What the operator must supply

1. **`pvc-storageclass-patch.yaml`** — replace `REPLACE_ME` with the name of a
   StorageClass that exists in your cluster. If you skip this, a cluster with
   no default StorageClass leaves the PVC `Pending`, and the reviewer Pod
   **never schedules** — the fix is pinning the class, or unsetting
   `SEMBLE_INDEX_PVC` on the dispatcher to fall back to `emptyDir`.
2. **`ingress.yaml`** — replace the `REPLACE_ME` host, `ingressClassName` and
   TLS `secretName`. DNS and certificate provisioning are yours to arrange;
   this repository ships no hostname and no certificate.

## Applying

```bash
kubectl apply -k deploy/shared-cluster
```

Deploy the dispatcher through your ingress; then verify:

```bash
kubectl get svc kitten-dispatcher -n kitten          # type ClusterIP
kubectl get pvc kitten-semble-index -n kitten        # Bound, with your class
kubectl port-forward svc/kitten-dispatcher 3001:3001 -n kitten
curl localhost:3001/health                            # {"status":"ok",...}
```

## Caveats

- **The PVC exists already?** `spec.storageClassName` is immutable on a bound
  PVC, so the patch is rejected with
  `spec: Forbidden: spec is immutable after creation`. The index is derived
  data — delete the PVC, re-apply, and Semble rebuilds it incrementally.
- **CI deploys** apply `KUSTOMIZE_PATH` (`k8s` by default). Set the
  `KUSTOMIZE_PATH` repository variable to `deploy/shared-cluster` or every
  push reverts the overlay.
- The reviewer Pod's own scheduling (`nodeSelector`, `tolerations`,
  `serviceAccountName`) is configured through the dispatcher's
  `REVIEWER_POD_SCHEDULING` environment variable — see
  [configuration.md](../../docs/configuration.md).
