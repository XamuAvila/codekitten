---
id: "KIT-051"
status: "in-progress"
priority: "high"
assignee: ""
epic: "v9-eks-deploy"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
completedAt: null
labels: ["infra", "eks", "ci", "github-actions", "docs"]
order: "g1"
---

# EKS Bootstrap Script + GitHub Actions Deploy

## User Story

See [US-040](../../docs/stories/US-040-eks-automated-deploy.md) (AC-1, AC-2, AC-3).

## Technical Refinement

### Files

**Created:**
- `scripts/eks-setup.sh` — one-time bootstrap (idempotent), following the
  style of `scripts/minikube-setup.sh` (colors/helpers, `set -euo pipefail`):
  1. Prereq check: `aws`, `eksctl`, `kubectl`; `EKS_CLUSTER`, `EKS_REGION`,
     `GITHUB_REPO` exported.
  2. `aws eks update-kubeconfig --name "$EKS_CLUSTER" --region "$EKS_REGION"`.
  3. `eksctl utils associate-iam-oidc-provider --cluster … --region … --approve`.
  4. Create IAM role `kitten-gh-actions-deploy` (idempotent) with trust policy
     `token.actions.githubusercontent.com`, `aud=sts.amazonaws.com`,
     `sub=repo:${GITHUB_REPO}:ref:refs/heads/main`, and an inline policy:
     ECR `GetAuthorizationToken` + push/upload actions on the three
     `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/kitten-*` repos +
     `eks:DescribeCluster`.
  5. `eksctl create iamidentitymapping --arn "$ROLE_ARN" --group kitten-ci-deploy --no-duplicate-arg`.
  6. `kubectl apply -f k8s/eks-deploy-rbac.yaml` (KIT-050).
  7. Apply order refined during implementation: namespace first, then the real
     Secrets (so the Deployment never starts with `CreateContainerConfigError`),
     then `kubectl apply -k k8s` for the remaining infra.
  8. Create the real Secrets from exported env vars (same pattern as
     `minikube-setup.sh` §5): `kitten-github-token`, `kitten-llm-keys`,
     `kitten-webhook-secret`, `kitten-knowledge-secrets` (optional; the EKS
     `MONGODB_URI` is used as-is — the `localhost` → `host.minikube.internal`
     rewrite is a minikube-only concern).
  9. `aws ecr create-repository` for the three repos (idempotent `|| true`).
  10. Print `AWS_ROLE_ARN` + GitHub Secrets checklist (`AWS_ROLE_ARN`,
      `AWS_REGION`, `EKS_CLUSTER`) and the next step (push to main).
- `.github/workflows/ci.yml` — `pull_request` + `push: main`:
  checkout → `pnpm/action-setup@v4` → `setup-node@v4` (node 22, pnpm cache) →
  `pnpm install --frozen-lockfile` → `pnpm lint` → `pnpm test` → `pnpm build`.
- `.github/workflows/deploy.yml` — `push: main` + `workflow_dispatch`,
  `permissions: { id-token: write, contents: read }`:
  1. checkout, pnpm setup, `pnpm install --frozen-lockfile`, `pnpm build`
     (reviewer image embeds `packages/*/dist` — the multi-stage Dockerfile
     copies pre-built dist, it does not compile).
  2. `aws-actions/configure-aws-credentials@v4` with `role-to-assume:
     ${{ secrets.AWS_ROLE_ARN }}`, `aws-region: ${{ vars.AWS_REGION }}`.
  3. `aws-actions/amazon-ecr-login@v2` (id: `ecr`).
  4. Build+push `kitten-dispatcher`, `kitten-reviewer`,
     `kitten-semble-sidecar` tagged `${GITHUB_SHA}` to `${{ steps.ecr.outputs.registry }}`.
  5. `aws eks update-kubeconfig --name "${{ vars.EKS_CLUSTER }}" --region "${{ vars.AWS_REGION }}"`.
  6. `kubectl apply -k k8s`, then `kubectl -n kitten set image
     deployment/kitten-dispatcher dispatcher=<registry>/kitten-dispatcher:<sha>`
     and `kubectl -n kitten set env deployment/kitten-dispatcher
     REVIEWER_IMAGE=<registry>/kitten-reviewer:<sha>
     SEMBLE_IMAGE=<registry>/kitten-semble-sidecar:<sha>` (epic D3), then
     `kubectl -n kitten rollout status deployment/kitten-dispatcher --timeout=180s`.

**Modified:**
- `README.md` — new "Deploy to AWS EKS" section (one-time setup, GitHub
  Secrets checklist, expected flow), mirroring the local-setup section.
- `docs/stories/INDEX.md` — already updated with US-040 (same commit).

### Consumes

- `k8s/kustomization.yaml` and `k8s/eks-deploy-rbac.yaml` (KIT-050).
- `packages/{dispatcher,reviewer}/Dockerfile`, `docker/semble-sidecar/Dockerfile`.

### Produces

- The `kitten-gh-actions-deploy` IAM role ARN the operator stores as the
  `AWS_ROLE_ARN` GitHub Secret.
- Repeatable, automatic EKS deploys on every push to `main`.

### Design decisions

1. **ECR image tag = `${GITHUB_SHA}`** — immutable, idempotent deploys;
   `IfNotPresent` stays correct (epic D4).
2. **Secrets are never applied by CI** — `secret.yaml` is outside the
   kustomization (KIT-050); `eks-setup.sh` owns Secret creation (epic D8).
3. **`set image`/`set env` instead of kustomize overlays** — kustomize
   `images:` can't rewrite env-var values and `replacements` can't derive the
   sidecar URI (epic D3).
4. **`deploy.yml` does not run `ci.yml` jobs** — the repo previously had no CI;
   the deploy runs its own install+build so the shipped image is guaranteed to
   match the push.
5. **`EKS_CLUSTER`/`AWS_REGION` as repo *variables*** (not secrets), secrets
   only for `AWS_ROLE_ARN` — nothing else in the workflow is sensitive.

### Risks

- OIDC trust subject is pinned to `refs/heads/main` — a PR from a fork cannot
  deploy (good); a workflow error would require editing the trust policy in
  AWS console or re-running setup.
- `amazon-ecr-login` outputs `registry`; if the action version changes the
  output name, the build steps break visibly (pinned to `@v2`).
- Multi-arch not built (amd64 only) — EKS node groups default to amd64; note in
  README.

## Implementation Plan

1. [ ] Create `scripts/eks-setup.sh` — test: `shellcheck scripts/eks-setup.sh` clean; `bash -n` parses; idempotency reviewed (every `aws eksctl` step tolerates existing state), expected: PASS.
2. [ ] Create `.github/workflows/ci.yml` — test: YAML parses (`yq` or python), actions pinned to major versions, expected: PASS.
3. [ ] Create `.github/workflows/deploy.yml` — test: YAML parses; job graph has the 7 steps; `set image`/`set env` commands reference `steps.ecr.outputs.registry`, expected: PASS.
4. [ ] Update `README.md` with the EKS section — test: markdown renders, commands match the script's echo output, expected: PASS.
5. [ ] Commit: `feat: eks one-time setup script + GitHub Actions deploy`

## How to Test

- **Automated**: `bash -n scripts/eks-setup.sh` and `shellcheck scripts/eks-setup.sh` clean; `pnpm test && pnpm lint` green (no runtime code touched); workflow YAMLs parse.
- **Manual verification**: run `EKS_CLUSTER=… EKS_REGION=… GITHUB_REPO=owner/repo ./scripts/eks-setup.sh` against a real cluster → prints `AWS_ROLE_ARN`; push to `main` → `deploy.yml` green; `kubectl -n kitten get pods` shows the dispatcher from the ECR image; submit a review → reviewer Pod starts (no `ImagePullBackOff`).
- **Negative check**: run `kubectl apply -k k8s` twice — idempotent, no diff errors; a `deploy.yml` run with a revoked role fails at the OIDC step before any `kubectl`.
- **Done means**: `eks-setup.sh` completes idempotently on EKS, `deploy.yml` deploys a SHA-tagged dispatcher, and a submitted review spawns a reviewer Pod from ECR.
