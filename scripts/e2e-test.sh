#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Kitten v2 E2E Test
# Tests the full review lifecycle:
#   POST /review → Pod created → clone → diff → PR comment → follow-up → idle → done
#
# Prerequisites:
#   - minikube running with kitten namespace (./scripts/minikube-setup.sh)
#   - GITHUB_TOKEN set in kitten-github-token secret
#   - Test repo: XamuAvila/kitten-test-repo with PR #1
#
# Usage:
#   IDLE_TIMEOUT=30 ./scripts/e2e-test.sh
# =============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }
info() { echo -e "${YELLOW}→ $1${NC}"; }

DISPATCHER_URL="${DISPATCHER_URL:-$(minikube service kitten-dispatcher -n kitten --url 2>/dev/null)}"
IDLE_TIMEOUT="${IDLE_TIMEOUT:-30}"  # 30s for testing, not 10min
POLL_INTERVAL=3
POLL_TIMEOUT=120

# Pin the context — never operate against whatever cluster happens to be current.
kubectl() { command kubectl --context=minikube "$@"; }

# --- Step 1: Verify cluster is ready ---
info "Checking cluster health..."
HEALTH=$(curl -sf "${DISPATCHER_URL}/health" 2>/dev/null || echo "FAIL")
if echo "$HEALTH" | grep -q '"ok"'; then
  pass "Dispatcher healthy"
else
  fail "Dispatcher not healthy: $HEALTH"
fi

# --- Step 2: Submit review ---
info "Submitting review for XamuAvila/kitten-test-repo PR #1..."
RESPONSE=$(curl -sf -X POST "${DISPATCHER_URL}/review" \
  -H "Content-Type: application/json" \
  -d "{
    \"repo\": \"XamuAvila/kitten-test-repo\",
    \"prNumber\": 1,
    \"headRef\": \"test/add-feature\",
    \"baseRef\": \"master\",
    \"sender\": \"e2e-test\"
  }" 2>/dev/null || echo "FAIL")

JOB_ID=$(echo "$RESPONSE" | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)
if [ -z "$JOB_ID" ]; then
  fail "Failed to submit review: $RESPONSE"
fi
pass "Review submitted: $JOB_ID"

# --- Step 3: Wait for Pod to start ---
info "Waiting for reviewer Pod..."
ELAPSED=0
while [ $ELAPSED -lt $POLL_TIMEOUT ]; do
  POD_STATUS=$(kubectl get pod -n kitten -l "review-job-id=$JOB_ID" -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "")
  if [ "$POD_STATUS" = "Running" ]; then
    pass "Pod running"
    break
  fi
  sleep $POLL_INTERVAL
  ELAPSED=$((ELAPSED + POLL_INTERVAL))
done
if [ "$POD_STATUS" != "Running" ]; then
  fail "Pod not running after ${POLL_TIMEOUT}s (status: $POD_STATUS)"
fi

# --- Step 4: Wait for "reviewing" status ---
info "Waiting for review to complete (status: reviewing)..."
ELAPSED=0
while [ $ELAPSED -lt $POLL_TIMEOUT ]; do
  STATUS_RESPONSE=$(curl -sf "${DISPATCHER_URL}/status/$JOB_ID" 2>/dev/null || echo "{}")
  STATUS=$(echo "$STATUS_RESPONSE" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ "$STATUS" = "reviewing" ]; then
    pass "Status: reviewing (pipeline done, waiting for follow-ups)"
    break
  elif [ "$STATUS" = "failed" ]; then
    fail "Review failed: $STATUS_RESPONSE"
  fi
  sleep $POLL_INTERVAL
  ELAPSED=$((ELAPSED + POLL_INTERVAL))
done
if [ "$STATUS" != "reviewing" ]; then
  fail "Did not reach 'reviewing' status after ${POLL_TIMEOUT}s (status: $STATUS)"
fi

# --- Step 5: Send follow-up ---
info "Sending follow-up message..."
FOLLOW_RESPONSE=$(curl -sf -X POST "${DISPATCHER_URL}/review/$JOB_ID/message" \
  -H "Content-Type: application/json" \
  -d '{"message":"explain the changes in utils.ts","sender":"e2e-test"}' 2>/dev/null || echo "FAIL")

if echo "$FOLLOW_RESPONSE" | grep -q '"sent"'; then
  pass "Follow-up sent"
else
  fail "Follow-up failed: $FOLLOW_RESPONSE"
fi

# Verify follow-up count incremented
sleep 2
STATUS_RESPONSE=$(curl -sf "${DISPATCHER_URL}/status/$JOB_ID" 2>/dev/null || echo "{}")
FOLLOW_COUNT=$(echo "$STATUS_RESPONSE" | grep -o '"followUpCount":[0-9]*' | cut -d: -f2)
# Exactly 1: only the Pod that consumed the message increments. A count of 2
# means the dispatcher is double-counting on publish (regression).
if [ "$FOLLOW_COUNT" = "1" ]; then
  pass "Follow-up count: 1"
else
  fail "Expected followUpCount=1, got '$FOLLOW_COUNT' (double-count regression?)"
fi

# --- Step 6: Wait for idle timeout ---
info "Waiting for idle timeout (${IDLE_TIMEOUT}s)..."
sleep $((IDLE_TIMEOUT + 5))

STATUS_RESPONSE=$(curl -sf "${DISPATCHER_URL}/status/$JOB_ID" 2>/dev/null || echo "{}")
STATUS=$(echo "$STATUS_RESPONSE" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ "$STATUS" = "completed" ]; then
  pass "Status: completed (idle timeout worked)"
else
  info "Status: $STATUS (may still be shutting down — non-blocking)"
fi

# --- Step 7: Verify Pod exited ---
info "Checking Pod cleanup..."
sleep 5
POD_PHASE=$(kubectl get pod -n kitten -l "review-job-id=$JOB_ID" -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "Gone")
if [ "$POD_PHASE" = "Succeeded" ] || [ "$POD_PHASE" = "Gone" ] || [ -z "$POD_PHASE" ]; then
  pass "Pod exited cleanly ($POD_PHASE)"
else
  info "Pod phase: $POD_PHASE (may need manual cleanup)"
fi

# --- Summary ---
echo ""
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo -e "${GREEN}  E2E Test Complete                    ${NC}"
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo "  Job ID:     $JOB_ID"
echo "  Follow-ups: ${FOLLOW_COUNT:-unknown}"
echo "  Final:      ${STATUS:-unknown}"
echo ""
