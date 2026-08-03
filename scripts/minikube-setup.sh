#!/usr/bin/env bash
set -euo pipefail

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

# Every kubectl call pins --context=minikube. Never rely on the ambient current
# context: a developer's kubeconfig may point at a production cluster, and this
# script creates namespaces, RBAC and secrets.
K="kubectl --context=minikube"

# ─── Resolve project root (script lives in <root>/scripts/) ──────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ─── 1. Check minikube is installed ──────────────────────────────────────────
if ! command -v minikube &> /dev/null; then
  error "minikube is not installed. Install it from https://minikube.sigs.k8s.io/docs/start/"
fi

MINIKUBE_VERSION="$(minikube version --short | sed 's/^v//')"
MINIKUBE_MAJOR="$(echo "${MINIKUBE_VERSION}" | cut -d. -f1)"
MINIKUBE_MINOR="$(echo "${MINIKUBE_VERSION}" | cut -d. -f2)"

if [[ "${MINIKUBE_MAJOR}" -lt 1 ]] || { [[ "${MINIKUBE_MAJOR}" -eq 1 ]] && [[ "${MINIKUBE_MINOR}" -lt 30 ]]; }; then
  error "minikube >= 1.30 required (found v${MINIKUBE_VERSION})"
fi
success "minikube v${MINIKUBE_VERSION} detected"

# ─── 2. Start minikube if not running ────────────────────────────────────────
if minikube status --format='{{.APIServer}}' 2>/dev/null | grep -q "Running"; then
  success "minikube is already running"
else
  info "Starting minikube with docker driver..."
  minikube start --driver=docker
  success "minikube started"
fi

# ─── 3. Apply namespace ─────────────────────────────────────────────────────
info "Applying namespace..."
${K} apply -f "${PROJECT_ROOT}/k8s/namespace.yaml"
success "Namespace 'kitten' applied"

# ─── 4. Apply RBAC (dispatcher needs to create Pods) ────────────────────────
# Without this the dispatcher gets HTTP 403 from the K8s API:
#   "pods is forbidden: User system:serviceaccount:kitten:default cannot create
#    resource pods in the namespace kitten"
info "Applying RBAC (Role + RoleBinding for Pod management)..."
${K} apply -f "${PROJECT_ROOT}/k8s/rbac.yaml"
success "RBAC applied"

# ─── 5. Apply GitHub token secret ───────────────────────────────────────────
# If GITHUB_TOKEN is exported, create the secret from it. Otherwise apply the
# placeholder template so the manifests are complete but non-functional.
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  info "Creating secret from \$GITHUB_TOKEN..."
  ${K} create secret generic kitten-github-token \
    --from-literal=token="${GITHUB_TOKEN}" \
    -n kitten --dry-run=client -o yaml | ${K} apply -f -
  success "Secret 'kitten-github-token' created from environment"
else
  info "Applying placeholder secret..."
  ${K} apply -f "${PROJECT_ROOT}/k8s/secret.yaml"
  warn "Secret holds the placeholder REPLACE_ME — reviews will fail to clone."
  warn "Re-run with: GITHUB_TOKEN=<your-token> ./scripts/minikube-setup.sh"
fi

# ─── 5b. Apply LLM provider keys secret ──────────────────────────────────────
# If any LLM key is exported, create the secret from them; otherwise the
# placeholder from k8s/secret.yaml (applied above) is used.
if [[ -n "${ANTHROPIC_API_KEY:-}" || -n "${OPENAI_API_KEY:-}" || -n "${DEEPSEEK_API_KEY:-}" ]]; then
  info "Creating kitten-llm-keys secret from environment..."
  ${K} create secret generic kitten-llm-keys \
    --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
    --from-literal=OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
    --from-literal=DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-}" \
    -n kitten --dry-run=client -o yaml | ${K} apply -f -
  success "Secret 'kitten-llm-keys' created from environment"
fi

# ─── 6. Apply Redis deployment + service ─────────────────────────────────────
info "Applying Redis deployment and service..."
${K} apply -f "${PROJECT_ROOT}/k8s/redis-deployment.yaml"
${K} apply -f "${PROJECT_ROOT}/k8s/redis-service.yaml"
success "Redis deployment and service applied"

# ─── 7. Build images inside minikube's docker daemon ────────────────────────
# minikube has its own docker daemon; images built on the host are not visible
# to the cluster. Pods use imagePullPolicy: IfNotPresent against this daemon.
info "Building dispatcher image inside minikube..."
minikube image build -t kitten-dispatcher:latest -f "${PROJECT_ROOT}/packages/dispatcher/Dockerfile" "${PROJECT_ROOT}"
success "Dispatcher image built"

info "Building reviewer image inside minikube..."
minikube image build -t kitten-reviewer:latest -f "${PROJECT_ROOT}/packages/reviewer/Dockerfile" "${PROJECT_ROOT}"
success "Reviewer image built"

# ─── 8. Apply dispatcher deployment + service ───────────────────────────────
info "Applying dispatcher deployment and service..."
${K} apply -f "${PROJECT_ROOT}/k8s/dispatcher-deployment.yaml"
${K} apply -f "${PROJECT_ROOT}/k8s/dispatcher-service.yaml"
${K} rollout restart deployment/kitten-dispatcher -n kitten
success "Dispatcher deployment and service applied"

# ─── 9. Wait for rollout ────────────────────────────────────────────────────
info "Waiting for dispatcher rollout (timeout: 120s)..."
${K} rollout status deployment/kitten-dispatcher -n kitten --timeout=120s
success "Dispatcher rollout complete"

# ─── 10. Print summary ──────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Kitten K8s infrastructure is ready!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Namespace:  kitten"
echo "  Pods:"
${K} get pods -n kitten --no-headers | while read -r line; do
  echo "    ${line}"
done
echo ""
echo "  Services:"
${K} get svc -n kitten --no-headers | while read -r line; do
  echo "    ${line}"
done
echo ""

DISPATCHER_URL="$(minikube service kitten-dispatcher -n kitten --url 2>/dev/null || echo 'N/A')"
echo -e "  Dispatcher URL: ${BLUE}${DISPATCHER_URL}${NC}"
echo -e "  Health check:   ${BLUE}curl ${DISPATCHER_URL}/health${NC}"
echo -e "  Run E2E:        ${BLUE}IDLE_TIMEOUT=30 ./scripts/e2e-test.sh${NC}"
echo ""
