#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Cleanup completed/failed reviewer Pods in the kitten namespace.
# Safe to run anytime — only targets Pods with label app=kitten-reviewer.
# =============================================================================

NAMESPACE="${K8S_NAMESPACE:-kitten}"

# Pin the context — this script deletes Pods; never let it hit a cluster the
# developer merely happens to have selected.
kubectl() { command kubectl --context=minikube "$@"; }

echo "Cleaning up kitten-reviewer Pods in namespace: $NAMESPACE"

# Delete Succeeded Pods
SUCCEEDED=$(kubectl get pods -n "$NAMESPACE" -l app=kitten-reviewer \
  --field-selector=status.phase=Succeeded -o name 2>/dev/null || echo "")
if [ -n "$SUCCEEDED" ]; then
  echo "$SUCCEEDED" | xargs kubectl delete -n "$NAMESPACE"
  echo "✓ Deleted Succeeded Pods"
else
  echo "  No Succeeded Pods to clean"
fi

# Delete Failed Pods
FAILED=$(kubectl get pods -n "$NAMESPACE" -l app=kitten-reviewer \
  --field-selector=status.phase=Failed -o name 2>/dev/null || echo "")
if [ -n "$FAILED" ]; then
  echo "$FAILED" | xargs kubectl delete -n "$NAMESPACE"
  echo "✓ Deleted Failed Pods"
else
  echo "  No Failed Pods to clean"
fi

# Show remaining Pods
REMAINING=$(kubectl get pods -n "$NAMESPACE" -l app=kitten-reviewer --no-headers 2>/dev/null | wc -l)
echo ""
echo "Remaining reviewer Pods: $REMAINING"
