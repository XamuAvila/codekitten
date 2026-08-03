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
if minikube status --format='{{.Host}}' 2>/dev/null | grep -q "Running"; then
  success "minikube is already running"
else
  info "Starting minikube with docker driver..."
  minikube start --driver=docker
  success "minikube started"
fi

# ─── 3. Enable DNS addon ────────────────────────────────────────────────────
info "Enabling DNS addon..."
minikube addons enable dns
success "DNS addon enabled"

# ─── 4. Apply namespace ─────────────────────────────────────────────────────
info "Applying namespace..."
kubectl apply -f "${PROJECT_ROOT}/k8s/namespace.yaml"
success "Namespace 'kitten' applied"

# ─── 5. Apply secret ────────────────────────────────────────────────────────
info "Applying secret..."
kubectl apply -f "${PROJECT_ROOT}/k8s/secret.yaml"
warn "Secret uses placeholder token — replace before real usage"
success "Secret 'kitten-github-token' applied"

# ─── 6. Apply Redis deployment + service ─────────────────────────────────────
info "Applying Redis deployment and service..."
kubectl apply -f "${PROJECT_ROOT}/k8s/redis-deployment.yaml"
kubectl apply -f "${PROJECT_ROOT}/k8s/redis-service.yaml"
success "Redis deployment and service applied"

# ─── 7. Build dispatcher image ──────────────────────────────────────────────
info "Building dispatcher image inside minikube..."
minikube image build -t kitten-dispatcher:latest -f "${PROJECT_ROOT}/packages/dispatcher/Dockerfile" "${PROJECT_ROOT}"
success "Dispatcher image built"

# ─── 8. Build reviewer image ────────────────────────────────────────────────
info "Building reviewer image inside minikube..."
minikube image build -t kitten-reviewer:latest -f "${PROJECT_ROOT}/packages/reviewer/Dockerfile" "${PROJECT_ROOT}"
success "Reviewer image built"

# ─── 9. Apply dispatcher deployment + service ───────────────────────────────
info "Applying dispatcher deployment and service..."
kubectl apply -f "${PROJECT_ROOT}/k8s/dispatcher-deployment.yaml"
kubectl apply -f "${PROJECT_ROOT}/k8s/dispatcher-service.yaml"
success "Dispatcher deployment and service applied"

# ─── 10. Wait for rollout ───────────────────────────────────────────────────
info "Waiting for dispatcher rollout (timeout: 120s)..."
kubectl rollout status deployment/kitten-dispatcher -n kitten --timeout=120s
success "Dispatcher rollout complete"

# ─── 11. Print summary ──────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Kitten K8s infrastructure is ready!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Namespace:  kitten"
echo "  Pods:"
kubectl get pods -n kitten --no-headers | while read -r line; do
  echo "    ${line}"
done
echo ""
echo "  Services:"
kubectl get svc -n kitten --no-headers | while read -r line; do
  echo "    ${line}"
done
echo ""

DISPATCHER_URL="$(minikube service kitten-dispatcher -n kitten --url 2>/dev/null || echo 'N/A')"
echo -e "  Dispatcher URL: ${BLUE}${DISPATCHER_URL}${NC}"
echo -e "  Health check:   ${BLUE}curl ${DISPATCHER_URL}/health${NC}"
echo ""
warn "Remember to replace the placeholder token in k8s/secret.yaml before submitting real reviews."
