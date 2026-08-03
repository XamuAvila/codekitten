---
id: US-005
title: "K8s Infrastructure Setup"
status: draft
epic: v2-github-integration
---

# US-005: K8s Infrastructure Setup

## Story

As a **developer**, I want a local Kubernetes environment with minikube, a dedicated namespace, Redis and dispatcher manifests, and a setup script so that I can deploy and test the reviewer pipeline in an isolated K8s cluster on my machine.

## Acceptance Criteria

### AC-1: Minikube cluster running

```
Given I have minikube and kubectl installed
When I run `./scripts/minikube-setup.sh`
Then a minikube cluster is running
And a namespace "kitten" is created
```

### AC-2: Redis deployed in cluster

```
Given the minikube cluster is running
When I run `kubectl get pods -n kitten`
Then a Redis pod is running and ready
And a Redis service is accessible at redis.kitten.svc.cluster.local:6379
```

### AC-3: Dispatcher deployed in cluster

```
Given the minikube cluster is running
When I run `kubectl get pods -n kitten`
Then a dispatcher pod is running and ready
And GET /health returns { "status": "ok", "redis": "connected" }
```

### AC-4: GitHub token secret exists

```
Given the minikube cluster is running
When I run `kubectl get secret kitten-github-token -n kitten`
Then the secret exists with key "token"
And the token value is never printed in logs or manifests
```

### AC-5: Reviewer image built

```
Given minikube is running with its Docker daemon
When the setup script runs
Then the kitten-reviewer:latest image is available in minikube's registry
And the image contains git, Node.js, and the reviewer package
```

## Notes

- minikube uses its own Docker daemon — images must be built inside it (`eval $(minikube docker-env)`)
- `secret.yaml` in `k8s/` is a template — real token never committed
- `docker-compose.yml` kept for quick non-K8s dev (dispatcher + redis only)
- Setup script is idempotent — safe to run multiple times
