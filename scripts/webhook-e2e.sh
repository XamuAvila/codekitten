#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Kitten v5 Webhook E2E
# Simulated signed GitHub deliveries against the deployed dispatcher:
#   star            → { ignored: true }
#   pull_request opened      → reviewer Pod created
#   pull_request synchronize (live job) → in-place re-review (same Pod)
#   issue_comment "@reviewer stop"      → status cancelled
#
# Prerequisites:
#   - minikube running with kitten namespace (./scripts/minikube-setup.sh)
#   - kitten-webhook-secret + kitten-github-token secrets seeded
#   - Test repo: XamuAvila/kitten-test-repo with PR #2
#
# Usage: ./scripts/webhook-e2e.sh
# =============================================================================

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { echo -e "${GREEN}✓ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }
info() { echo -e "${YELLOW}→ $1${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="${SCRIPT_DIR}/fixtures/webhook"
JOB_ID="review-xamuavila-kitten-test-repo-2"
POLL_TIMEOUT=120
POLL_INTERVAL=3

# Pin the context — never operate against whatever cluster happens to be current.
# Default is minikube (dev loop); export KUBE_CONTEXT=<eks-context> to target EKS (v9).
KUBE_CONTEXT="${KUBE_CONTEXT:-minikube}"
kubectl() { command kubectl --context="$KUBE_CONTEXT" "$@"; }

DISPATCHER_URL="${DISPATCHER_URL:-$(minikube service kitten-dispatcher -n kitten --url 2>/dev/null)}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-$(kubectl get secret kitten-webhook-secret -n kitten -o jsonpath='{.data.secret}' | base64 -d)}"
[[ -n "$WEBHOOK_SECRET" ]] || fail "WEBHOOK_SECRET not resolvable"

# Sends a fixture as a signed delivery. Args: event fixture-file
deliver() {
  local event="$1" fixture="$2"
  local body sig
  body="$(cat "${FIXTURES}/${fixture}")"
  sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $NF}')"
  curl -s -X POST "${DISPATCHER_URL}/webhook/github" \
    -H "Content-Type: application/json" \
    -H "X-GitHub-Event: ${event}" \
    -H "X-GitHub-Delivery: e2e-$(date +%s%N)" \
    -H "X-Hub-Signature-256: ${sig}" \
    -d "$body"
}

wait_for() { # condition-cmd description
  local desc="$2" waited=0
  until eval "$1" >/dev/null 2>&1; do
    sleep "$POLL_INTERVAL"; waited=$((waited + POLL_INTERVAL))
    [[ $waited -lt $POLL_TIMEOUT ]] || fail "Timeout waiting: ${desc}"
  done
}

status_of() { curl -s "${DISPATCHER_URL}/status/${JOB_ID}" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4; }

# --- 0. Clean slate ---
info "Cleaning previous job pods..."
kubectl delete pod "$JOB_ID" -n kitten --ignore-not-found --wait=true >/dev/null 2>&1 || true

# --- 1. Ignored event ---
info "star event..."
RES=$(deliver star star.json)
echo "$RES" | grep -q '"ignored":true' && pass "star ignored" || fail "star not ignored: $RES"

# --- 2. Bad signature rejected ---
info "tampered signature..."
BODY='{"action":"opened"}'
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${DISPATCHER_URL}/webhook/github" \
  -H "Content-Type: application/json" -H "X-GitHub-Event: pull_request" \
  -H "X-Hub-Signature-256: sha256=deadbeef" -d "$BODY")
[[ "$CODE" == "401" ]] && pass "bad signature → 401" || fail "expected 401, got $CODE"

# --- 3. pull_request opened → Pod ---
info "pull_request opened..."
RES=$(deliver pull_request pull-request-opened.json)
echo "$RES" | grep -q "\"jobId\":\"${JOB_ID}\"" || fail "dispatch failed: $RES"
wait_for "kubectl get pod ${JOB_ID} -n kitten" "Pod created"
pass "Pod created from webhook"

wait_for '[[ "$(status_of)" == "reviewing" ]]' "pipeline done (status reviewing)"
pass "First review complete (status reviewing)"

# --- 4. synchronize on the live job → in-place re-review ---
info "pull_request synchronize (live Pod)..."
RES=$(deliver pull_request pull-request-synchronize.json)
echo "$RES" | grep -q '"status":"re_review"' || fail "expected re_review dispatch: $RES"
wait_for "kubectl logs ${JOB_ID} -n kitten | grep -c 'Processing job' | grep -qx 2" "second pipeline run in same Pod"
POD_COUNT=$(kubectl get pods -n kitten --no-headers | grep -c "^${JOB_ID} " || true)
[[ "$POD_COUNT" == "1" ]] && pass "Re-review ran in place (1 Pod, 2 pipeline runs)" || fail "unexpected pod count: $POD_COUNT"

wait_for '[[ "$(status_of)" == "reviewing" ]]' "re-review done"

# --- 5. @reviewer stop → cancelled ---
info "issue_comment @reviewer stop..."
RES=$(deliver issue_comment issue-comment-stop.json)
echo "$RES" | grep -q '"status":"sent"' || fail "stop not routed: $RES"
wait_for '[[ "$(status_of)" == "cancelled" ]]' "status cancelled"
pass "Stop via comment → cancelled"

echo -e "${GREEN}═══════════════════════════════${NC}"
echo -e "${GREEN}  Webhook E2E Complete${NC}"
echo -e "${GREEN}═══════════════════════════════${NC}"
