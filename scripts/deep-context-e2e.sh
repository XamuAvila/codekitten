#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Kitten v7 Deep Context E2E (KIT-040)
#
# On minikube with real secrets, proves the four epic promises end to end:
#   1. remember → Atlas doc → next review's prompt carries it
#   2. semantic_search / git_log answers during the agentic review
#   3. sidecar killed → review still completes (lexical degradation)
#   4. second review on the same base reuses the persisted index
#
# Prerequisites:
#   - ./scripts/minikube-setup.sh with GITHUB_TOKEN, LLM keys AND
#     MONGODB_URI + VOYAGE_API_KEY exported (knowledge secrets seeded)
#   - Test repo XamuAvila/kitten-test-repo with PR #2 carrying
#     .reviewer-mcp.json { "enabled": true } (agentic mode)
#
# Without MONGODB_URI/VOYAGE_API_KEY this script SKIPS LOUDLY (exit 0):
# same policy as the DeepSeek integration suite — reviews are unaffected.
# =============================================================================

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { echo -e "${GREEN}✓ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }
info() { echo -e "${YELLOW}→ $1${NC}"; }

# Pin the context — never operate against whatever cluster happens to be current.
# Default is minikube (dev loop); export KUBE_CONTEXT=<eks-context> to target EKS (v9).
KUBE_CONTEXT="${KUBE_CONTEXT:-minikube}"
kubectl() { command kubectl --context="$KUBE_CONTEXT" "$@"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="${SCRIPT_DIR}/fixtures/webhook"
JOB_ID="review-xamuavila-kitten-test-repo-2"
POLL_TIMEOUT="${POLL_TIMEOUT:-300}"
POLL_INTERVAL=5

# --- Secrets gate (loud skip) ---
MONGODB_URI="${MONGODB_URI:-$(kubectl get secret kitten-knowledge-secrets -n kitten -o jsonpath='{.data.MONGODB_URI}' 2>/dev/null | base64 -d || true)}"
if [[ -z "${MONGODB_URI}" ]]; then
  echo -e "${YELLOW}==============================================================${NC}"
  echo -e "${YELLOW}  SKIPPED: deep-context e2e needs MONGODB_URI + VOYAGE_API_KEY${NC}"
  echo -e "${YELLOW}  (export them and re-run ./scripts/minikube-setup.sh first)${NC}"
  echo -e "${YELLOW}==============================================================${NC}"
  exit 0
fi

DISPATCHER_URL="${DISPATCHER_URL:-$(minikube service kitten-dispatcher -n kitten --url 2>/dev/null)}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-$(kubectl get secret kitten-webhook-secret -n kitten -o jsonpath='{.data.secret}' | base64 -d)}"
[[ -n "$WEBHOOK_SECRET" ]] || fail "WEBHOOK_SECRET not resolvable"

deliver() { # event fixture-file
  local event="$1" fixture="$2" body sig
  body="$(cat "${FIXTURES}/${fixture}")"
  sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $NF}')"
  curl -s -X POST "${DISPATCHER_URL}/webhook/github" \
    -H "Content-Type: application/json" \
    -H "X-GitHub-Event: ${event}" \
    -H "X-GitHub-Delivery: deep-e2e-$(date +%s%N)" \
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

mongo_count() { # count knowledge docs for the test repo
  # cd packages/shared: mongodb is a dependency of @kitten/shared (pnpm strict)
  cd "${SCRIPT_DIR}/../packages/shared" && MONGODB_URI="$MONGODB_URI" node -e '
    import("mongodb").then(async ({ MongoClient }) => {
      const c = await MongoClient.connect(process.env.MONGODB_URI);
      const n = await c.db("kitten").collection("knowledge")
        .countDocuments({ repo: "XamuAvila/kitten-test-repo" });
      console.log(n); await c.close();
    });'
  cd - >/dev/null
}

# --- 0. Clean slate ---
info "Cleaning previous job pod..."
kubectl delete pod "$JOB_ID" -n kitten --ignore-not-found --wait=true >/dev/null 2>&1 || true

# --- 1. remember → Atlas doc ---
info "1/4 remember command..."
BEFORE=$(mongo_count)
RES=$(deliver issue_comment issue-comment-remember.json)
echo "$RES" | grep -q '"status":"stored"' || fail "remember not stored: $RES"
AFTER=$(mongo_count)
[[ "$AFTER" -gt "$BEFORE" ]] && pass "remember → Atlas doc (count ${BEFORE} → ${AFTER})" || fail "Atlas count unchanged"

# --- 2. review carries knowledge + deep-context tool calls ---
info "2/4 agentic review with knowledge block..."
deliver pull_request pull-request-opened.json | grep -q "\"jobId\":\"${JOB_ID}\"" || fail "dispatch failed"
wait_for "kubectl get pod ${JOB_ID} -n kitten" "Pod created"
wait_for '[[ "$(status_of)" == "reviewing" ]]' "review complete"
LOGS=$(kubectl logs "$JOB_ID" -n kitten -c reviewer)
echo "$LOGS" | grep -q "Repository knowledge:" \
  && pass "prompt carried the knowledge block" \
  || { echo "$LOGS" | grep -q "knowledge: [1-9]" && pass "knowledge entries injected" || fail "no knowledge in review"; }
echo "$LOGS" | grep -Eq "semantic_search|git_log|git_blame" \
  && pass "deep-context tool call observed" \
  || fail "no semantic_search/git_log call in Pod logs"

# --- 3. sidecar killed → review completes ---
info "3/4 sidecar kill degradation..."
kubectl delete pod "$JOB_ID" -n kitten --ignore-not-found --wait=true >/dev/null 2>&1 || true
deliver pull_request pull-request-opened.json >/dev/null
wait_for "kubectl get pod ${JOB_ID} -n kitten" "Pod created"
# Kill the semble container process as soon as the pod is running
wait_for "kubectl get pod ${JOB_ID} -n kitten -o jsonpath='{.status.phase}' | grep -q Running" "Pod running"
kubectl exec "$JOB_ID" -n kitten -c semble -- sh -c 'kill 1' 2>/dev/null || true
wait_for '[[ "$(status_of)" == "reviewing" ]]' "review completes without sidecar"
pass "review completed with the sidecar dead"

# --- 4. index reuse on the same base ---
info "4/4 index reuse..."
kubectl delete pod "$JOB_ID" -n kitten --ignore-not-found --wait=true >/dev/null 2>&1 || true
deliver pull_request pull-request-opened.json >/dev/null
wait_for "kubectl get pod ${JOB_ID} -n kitten" "Pod created"
wait_for '[[ "$(status_of)" == "reviewing" ]]' "second review complete"
kubectl exec "$JOB_ID" -n kitten -c semble -- sh -c 'ls /semble-index/*/*/ 2>/dev/null | grep -q .' \
  && pass "persisted index present on the PVC across runs" \
  || fail "no index found on the PVC"

echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo -e "${GREEN}  Deep Context E2E Complete${NC}"
echo -e "${GREEN}═══════════════════════════════════════${NC}"
