---
id: US-006
title: "Dispatcher K8s Pod Orchestration"
status: draft
epic: v2-github-integration
---

# US-006: Dispatcher K8s Pod Orchestration

## Story

As a **developer**, I want the dispatcher to create a K8s Pod when POST /review is called and route follow-up messages to that Pod via Redis pub/sub so that reviews run in isolated containers and support interactive feedback.

## Acceptance Criteria

### AC-1: POST /review creates K8s Pod

```
Given the dispatcher is running in minikube
When I POST /review with a valid payload
Then a K8s Pod is created in the "kitten" namespace
And the Pod name matches "review-{owner}-{repo}-{pr}"
And the response is 202 { "jobId": "...", "status": "queued" }
```

### AC-2: Pod receives dynamic env vars

```
Given a POST /review with repo="XamuAvila/kitten-test-repo", prNumber=1
When the Pod is created
Then env REVIEW_REPO = "XamuAvila/kitten-test-repo"
And env REVIEW_PR_NUMBER = "1"
And env REVIEW_HEAD_REF matches the headRef from the request
And env REVIEW_BASE_REF matches the baseRef from the request
And env GITHUB_TOKEN comes from secretKeyRef (not inlined)
```

### AC-3: BullMQ removed

```
Given the dispatcher package.json
When I check dependencies
Then bullmq is not listed
And no import of bullmq exists in source code
```

### AC-4: Follow-up message routing

```
Given a review Pod is active with jobId "review-X-Y-1"
When I POST /review/review-X-Y-1/message with { "message": "explain X", "sender": "test" }
Then the message is published to Redis channel "review:review-X-Y-1:messages"
And the response is 200 { "status": "sent" }
```

### AC-5: Follow-up to dead Pod returns error

```
Given no active Pod for jobId "review-nonexistent"
When I POST /review/review-nonexistent/message
Then the response is 404 { "code": "NOT_FOUND", "message": "Review pod not active" }
```

## Notes

- BullMQ and `packages/worker/` are removed in this card
- `@kubernetes/client-node` for K8s API interaction
- Dispatcher needs RBAC to create/delete/get Pods in kitten namespace
- `GET /status/:jobId` reads from Redis (Pod writes status there)
