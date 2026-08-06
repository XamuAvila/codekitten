# US-040 — Automated EKS Deploy (One-Time Setup + CI)

**As a** maintainer operating Kitten on AWS,
**I want** the stack to be deployable to EKS with a one-time bootstrap and automatic deploys afterwards
**so that** pushing to `main` ships new versions without anyone touching the cluster or a minikube-specific workflow.

## Acceptance Criteria

### AC-1 — One-time bootstrap script
**Given** a live EKS cluster and admin kubeconfig
**When** I run `./scripts/eks-setup.sh` with `EKS_CLUSTER`, `EKS_REGION`, `GITHUB_REPO` and the secret env vars exported
**Then** the script creates the OIDC provider, the GitHub Actions IAM role, the cluster RBAC for that role, the Secrets, and the ECR repositories — idempotently — and prints the `AWS_ROLE_ARN` plus the GitHub Secrets checklist.

### AC-2 — CI deploy on push to main
**Given** `AWS_ROLE_ARN`, `AWS_REGION`, `EKS_CLUSTER` and the OIDC trust set in the GitHub repo
**When** a commit lands on `main`
**Then** the `deploy.yml` workflow assumes the role, builds and pushes the three images to ECR tagged with the commit SHA, applies the manifests, and rolls the dispatcher out pointing at those ECR images.

### AC-3 — Reviewer Pods pull from ECR
**Given** the dispatcher deployed via CI
**When** a review is submitted
**Then** the reviewer Pod is created with `REVIEWER_IMAGE`/`SEMBLE_IMAGE` pointing at ECR (`…/kitten-reviewer:<sha>`, `…/kitten-semble-sidecar:<sha>`) and starts from the ECR image — no `ImagePullBackOff` from unresolvable `latest`.

### AC-4 — CI never overwrites Secrets
**Given** the `k8s/kustomization.yaml`
**When** `kubectl apply -k k8s` runs
**Then** `k8s/secret.yaml` (the `REPLACE_ME` placeholder) is NOT among the rendered resources, so the CI cannot clobber the real Secrets created by the setup script.

### AC-5 — Operator scripts work against EKS
**Given** `KUBE_CONTEXT` exported (e.g. the EKS context name)
**When** I run `cleanup-pods.sh`, `e2e-test.sh`, `webhook-e2e.sh` or `deep-context-e2e.sh`
**Then** they target that context instead of the hardcoded `minikube` (default remains `minikube`).

### AC-6 — Existing dev loop unchanged
**Given** the minikube path
**When** `scripts/minikube-setup.sh` runs
**Then** it works exactly as before (same manifests, same context) — the EKS additions never regress the local path.

## Test reminders

- `kustomize build k8s` renders 7 resources and excludes `secret.yaml`
- `kubectl apply --dry-run=client -k k8s` parses cleanly
- shellcheck clean on `scripts/eks-setup.sh` and modified scripts
- `pnpm test && pnpm lint` green (no runtime code touched)
- E2E (once, manual): setup → push main → deploy → review spawns from ECR
