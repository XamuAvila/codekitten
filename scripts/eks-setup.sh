#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Kitten EKS one-time bootstrap (v9).
#
# Run ONCE against a live EKS cluster (you must hold admin kubeconfig). It:
#   1. Wires the GitHub OIDC provider to an IAM role the Actions workflow can
#      assume (ECR push + eks:DescribeCluster), trusted for the deploy branch
#      only (DEPLOY_BRANCH, default `master`).
#      of GITHUB_REPO.
#   2. Maps that role into the cluster (aws-auth) as group `kitten-ci-deploy`
#      and applies k8s/eks-deploy-rbac.yaml (that group's RBAC).
#   3. Applies the namespace, then creates the real Secrets from exported env
#      vars (never the placeholder), then applies the remaining base
#      infrastructure with kubectl apply -k k8s.
#   4. Creates the ECR repositories (idempotent).
#
# Everything is idempotent — safe to re-run to repair or refresh.
#
# Usage:
#   EKS_CLUSTER=my-cluster EKS_REGION=us-east-1 GITHUB_REPO=owner/repo \
#   GITHUB_TOKEN=... ANTHROPIC_API_KEY=... DEEPSEEK_API_KEY=... \
#   ./scripts/eks-setup.sh
#
# Prerequisites: aws, eksctl, kubectl, admin kubeconfig for the cluster.
# =============================================================================

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ─── Required inputs ────────────────────────────────────────────────────────
EKS_CLUSTER="${EKS_CLUSTER:?Export EKS_CLUSTER (EKS cluster name)}"
EKS_REGION="${EKS_REGION:?Export EKS_REGION (AWS region, e.g. us-east-1)}"
GITHUB_REPO="${GITHUB_REPO:?Export GITHUB_REPO as owner/repo (GitHub repo for the OIDC trust)}"
ROLE_NAME="${ROLE_NAME:-kitten-gh-actions-deploy}"
CI_RBAC_FILE="${CI_RBAC_FILE:-}"
# Branch allowed to assume the deploy role. MUST match the branch filter in
# .github/workflows/deploy.yml — a mismatch means the workflow either never
# fires or is rejected by STS with no obvious error. This repo's default
# branch is `master`; override when deploying from a differently named branch.
DEPLOY_BRANCH="${DEPLOY_BRANCH:-master}"

# ─── Prerequisite binaries ───────────────────────────────────────────────────
for cmd in aws eksctl kubectl; do
  command -v "$cmd" >/dev/null 2>&1 || error "Prerequisite '$cmd' is not installed"
done

# ─── Resolve project root ────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CI_RBAC="${CI_RBAC_FILE:-${PROJECT_ROOT}/k8s/eks-deploy-rbac.yaml}"

# ─── 1. Point kubectl at the cluster ─────────────────────────────────────────
info "Connecting to EKS cluster '${EKS_CLUSTER}' (region ${EKS_REGION})..."
aws eks update-kubeconfig --name "${EKS_CLUSTER}" --region "${EKS_REGION}" >/dev/null
success "kubeconfig updated for ${EKS_CLUSTER}"

# ─── 2. OIDC provider ────────────────────────────────────────────────────────
info "Associating GitHub OIDC provider (idempotent)..."
eksctl utils associate-iam-oidc-provider \
  --cluster "${EKS_CLUSTER}" --region "${EKS_REGION}" --approve >/dev/null
success "OIDC provider ready"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

# ─── 3. Deploy IAM role ──────────────────────────────────────────────────────
# Trust: GitHub Actions of GITHUB_REPO, ${DEPLOY_BRANCH} only. Nothing else may
# assume the role.
TRUST_POLICY="$(mktemp)"
trap 'rm -f "${TRUST_POLICY}"' EXIT
cat > "${TRUST_POLICY}" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:${GITHUB_REPO}:ref:refs/heads/${DEPLOY_BRANCH}"
        }
      }
    }
  ]
}
EOF

if aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
  info "IAM role '${ROLE_NAME}' exists — refreshing assume-role policy"
  aws iam update-assume-role-policy \
    --role-name "${ROLE_NAME}" --policy-document "file://${TRUST_POLICY}"
else
  info "Creating IAM role '${ROLE_NAME}'..."
  aws iam create-role \
    --role-name "${ROLE_NAME}" --assume-role-policy-document "file://${TRUST_POLICY}" \
    >/dev/null
fi

aws iam put-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-name "${ROLE_NAME}-policy" \
  --policy-document "$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ecr:GetAuthorizationToken", "eks:DescribeCluster"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
        "ecr:InitiateLayerUpload",
        "ecr:PutImage",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload"
      ],
      "Resource": [
        "arn:aws:ecr:${EKS_REGION}:${ACCOUNT_ID}:repository/kitten-dispatcher",
        "arn:aws:ecr:${EKS_REGION}:${ACCOUNT_ID}:repository/kitten-reviewer",
        "arn:aws:ecr:${EKS_REGION}:${ACCOUNT_ID}:repository/kitten-semble-sidecar"
      ]
    }
  ]
}
EOF
)"
success "IAM role '${ROLE_NAME}' ready (${ROLE_ARN})"

# ─── 4. Map role into the cluster + apply CI RBAC ────────────────────────────
info "Mapping '${ROLE_ARN}' to group kitten-ci-deploy (aws-auth)..."
eksctl create iamidentitymapping \
  --cluster "${EKS_CLUSTER}" --region "${EKS_REGION}" \
  --arn "${ROLE_ARN}" --group kitten-ci-deploy --no-duplicate-arg >/dev/null
success "IAM identity mapping ready"

info "Applying CI deploy RBAC (${CI_RBAC})..."
kubectl apply -f "${CI_RBAC}" >/dev/null
success "CI deploy RBAC applied"

# ─── 5. Namespace first (the Secrets below need it to exist) ────────────────
info "Applying namespace..."
kubectl apply -f "${PROJECT_ROOT}/k8s/namespace.yaml" >/dev/null
success "Namespace 'kitten' ready"

# ─── 6. Secrets (real values, from exported env vars) ────────────────────────
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  kubectl create secret generic kitten-github-token \
    --from-literal=token="${GITHUB_TOKEN}" \
    -n kitten --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  success "Secret 'kitten-github-token' created from environment"
else
  warn "GITHUB_TOKEN not exported — create 'kitten-github-token' manually:"
  warn "  kubectl create secret generic kitten-github-token --from-literal=token=<token> -n kitten"
fi

if [[ -n "${ANTHROPIC_API_KEY:-}" || -n "${OPENAI_API_KEY:-}" || -n "${DEEPSEEK_API_KEY:-}" ]]; then
  kubectl create secret generic kitten-llm-keys \
    --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
    --from-literal=OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
    --from-literal=DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-}" \
    -n kitten --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  success "Secret 'kitten-llm-keys' created from environment"
else
  warn "No LLM key exported — create 'kitten-llm-keys' manually (reviewers will fail at the LLM step until then)"
fi

WEBHOOK_SECRET="${WEBHOOK_SECRET:-$(openssl rand -hex 20)}"
kubectl create secret generic kitten-webhook-secret \
  --from-literal=secret="${WEBHOOK_SECRET}" \
  -n kitten --dry-run=client -o yaml | kubectl apply -f - >/dev/null
success "Secret 'kitten-webhook-secret' applied (value: ${WEBHOOK_SECRET})"

if [[ -n "${MONGODB_URI:-}" && -n "${VOYAGE_API_KEY:-}" ]]; then
  kubectl create secret generic kitten-knowledge-secrets \
    --from-literal=MONGODB_URI="${MONGODB_URI}" \
    --from-literal=VOYAGE_API_KEY="${VOYAGE_API_KEY}" \
    --from-literal=VOYAGE_BASE_URL="${VOYAGE_BASE_URL:-}" \
    -n kitten --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  success "Secret 'kitten-knowledge-secrets' created from environment"
else
  warn "MONGODB_URI/VOYAGE_API_KEY not exported — knowledge store disabled (remember/corrections/few-shot off)"
fi

# ─── 7. Apply remaining base infrastructure ──────────────────────────────────
# Namespace and Secrets are already in place, so the dispatcher Deployment can
# start without CreateContainerConfigError. kubectl apply -k k8s never touches
# secret.yaml (excluded from the kustomization on purpose).
info "Applying base infrastructure (kubectl apply -k k8s)..."
kubectl apply -k "${PROJECT_ROOT}/k8s"
success "Base infrastructure applied"

# ─── 8. ECR repositories (idempotent) ────────────────────────────────────────
for repo in kitten-dispatcher kitten-reviewer kitten-semble-sidecar; do
  if aws ecr describe-repositories --repository-names "${repo}" --region "${EKS_REGION}" >/dev/null 2>&1; then
    info "ECR repository '${repo}' already exists"
  else
    aws ecr create-repository \
      --repository-name "${repo}" --region "${EKS_REGION}" \
      --image-scanning-configuration scanOnPush=true >/dev/null
    success "ECR repository '${repo}' created"
  fi
done

# ─── 9. Summary ──────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Kitten EKS bootstrap complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Cluster:      ${EKS_CLUSTER} (${EKS_REGION})"
echo "  Deploy role:  ${ROLE_ARN}"
echo ""
echo -e "${YELLOW}  GitHub repo settings to configure (once):${NC}"
echo "    Secrets:    AWS_ROLE_ARN = ${ROLE_ARN}"
echo "    Variables:  AWS_REGION   = ${EKS_REGION}"
echo "    Variables:  EKS_CLUSTER  = ${EKS_CLUSTER}"
echo ""
echo -e "${BLUE}  Next: push to ${DEPLOY_BRANCH} — .github/workflows/deploy.yml deploys automatically.${NC}"
echo ""
