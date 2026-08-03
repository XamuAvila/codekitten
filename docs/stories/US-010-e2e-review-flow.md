---
id: US-010
title: "End-to-End Review Flow"
status: draft
epic: v2-github-integration
---

# US-010: End-to-End Review Flow

## Story

As a **developer**, I want to trigger a review via POST /review and observe the complete lifecycle (Pod creation → clone → diff → PR comment → follow-up → idle timeout → Pod cleanup) so that the v2 pipeline works end-to-end in a real K8s environment.

## Acceptance Criteria

### AC-1: Full flow succeeds

```
Given minikube is running with all v2 manifests applied
When I POST /review with repo="XamuAvila/kitten-test-repo", prNumber=1
Then a Pod is created in the kitten namespace
And the Pod clones the repo, generates a diff, fetches PR files
And a placeholder comment appears on PR #1
And GET /status/:jobId returns { "status": "reviewing" }
```

### AC-2: Follow-up works

```
Given a review Pod is active and in "reviewing" state
When I POST /review/:jobId/message with a follow-up
Then the Pod receives the message
And a reply comment appears on the PR
And GET /status/:jobId shows followUpCount incremented
```

### AC-3: Idle shutdown works

```
Given a review Pod is in "reviewing" state with no follow-ups
When the idle timeout (10 min) elapses
Then the Pod exits cleanly
And GET /status/:jobId returns { "status": "completed" }
And kubectl get pod shows the Pod in Completed or absent state
```

### AC-4: Error case: bad repo

```
Given minikube is running
When I POST /review with repo="nonexistent/repo-404"
Then a Pod is created and attempts to clone
And the clone fails
And GET /status/:jobId returns { "status": "failed", "error": { "code": "NOT_FOUND" } }
And the Pod exits (no lingering)
```

### AC-5: No resource leaks

```
Given multiple reviews have been triggered and completed
When I check the kitten namespace
Then no orphaned Pods remain (all completed Pods are cleaned up)
And Redis has status entries for all completed reviews
```

## Notes

- Test with `XamuAvila/kitten-test-repo` PR #1 (permanent fixture)
- This card is primarily integration/E2E testing — minimal new code
- Pod cleanup: completed Pods garbage-collected (K8s or dispatcher cleanup)
- Consider a script (`scripts/e2e-test.sh`) to run the full flow and verify assertions
