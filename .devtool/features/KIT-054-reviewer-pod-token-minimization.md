---
id: "KIT-054"
status: "backlog"
priority: "high"
assignee: ""
epic: "v8-agent-security-guardrails"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
completedAt: null
labels: ["security", "guardrails", "dispatcher", "k8s"]
order: "f7"
---

# Reviewer Pod Does Not Carry a Kubernetes Token

## User Story

See [US-039](../../docs/stories/US-039-agent-resists-exfiltration.md) — same
concern as AC-3 (the Semble subprocess not inheriting Pod secrets), applied to
the Kubernetes credential the Pod itself receives.

## Technical Refinement

### Problem

The reviewer Pod declares no `serviceAccountName`, so it runs as the `default`
ServiceAccount of the `kitten` namespace. `k8s/rbac.yaml:19-22` binds that exact
ServiceAccount to the `kitten-pod-manager` Role, which grants
`create/delete/get/list/watch` on pods and `get` on `pods/log`. Kubernetes
automounts the ServiceAccount token by default.

The result: the container that executes LLM-directed tool calls against a cloned
repository holds, at `/var/run/secrets/kubernetes.io/serviceaccount/token`, a
credential that can create and delete Pods in the namespace — including the
reviewer Pods of other in-flight reviews.

Not exploitable today: no tool in the registry performs arbitrary HTTP
(`semantic_search` posts only to the sidecar URL supplied by the dispatcher).
This card removes the credential anyway, because "no current tool reaches it" is
a property of today's tool list, not a guarantee.

### Files

**Modified (dispatcher):**
- `packages/dispatcher/src/k8s/manifest.ts` — the Pod `spec` gains
  `automountServiceAccountToken: false`, unconditionally. Field exists on
  `V1PodSpec` (`@kubernetes/client-node@1.4.0`,
  `dist/gen/models/V1PodSpec.d.ts:39`).
- `packages/dispatcher/tests/k8s/manifest.test.ts` — one appended test.

**Modified (docs):**
- `SECURITY.md` — the hardening section records that the reviewer Pod receives
  no Kubernetes credential.
- `docs/architecture.md` — same statement beside the isolation invariants.

### Consumes

Nothing. Independent of every other v8 card and of KIT-052.

### Produces

The reviewer container has no Kubernetes API credential, so the blast radius of
a compromised or induced agent no longer includes the Kubernetes API.

### Design decisions

1. **Unconditional, not configurable.** The reviewer makes zero Kubernetes API
   calls — `packages/reviewer/src/` imports no Kubernetes client. There is no
   deployment for which mounting the token is correct, so this is not a knob.
2. **Set it on the Pod, not by changing the ServiceAccount.** Setting
   `automountServiceAccountToken: false` on the `default` ServiceAccount would
   also strip the token from the dispatcher, which genuinely needs it to create
   Pods. The Pod-level field targets exactly the workload that should not have
   it.
3. **Do not narrow `kitten-pod-manager` in this card.** The dispatcher needs
   those verbs. Reducing the Role is a separate question with a separate blast
   radius.
4. **Independent of `serviceAccountName` (KIT-052).** Even when an operator
   points the Pod at a purpose-built ServiceAccount, that account's token should
   not be mounted either. The two settings compose.

### Risks

1. A future feature that needs the reviewer to call the Kubernetes API would
   fail with a confusing authentication error. Mitigated by the comment in
   `manifest.ts` explaining the intent, so the next author disables it
   deliberately rather than by accident.
2. Some sidecar images assume an in-cluster config. The Semble sidecar does not
   — `docker/semble-sidecar/server.py` talks only to the local filesystem and
   the MCP subprocess. Confirm the sidecar still starts on minikube before
   closing.

## Implementation Plan

1. - [ ] Confirm the reviewer genuinely makes no Kubernetes API call, so the
   removal is safe.
   Command: `grep -rn "@kubernetes/client-node\|KUBERNETES_SERVICE_HOST\|serviceaccount" packages/reviewer/src/`.
   Expected: no matches. A match means this card's premise is wrong — stop and
   re-refine.
2. - [ ] RED — append to `packages/dispatcher/tests/k8s/manifest.test.ts`:
   **Given** any `PodConfig`, with and without `sembleImage`, **when** the
   manifest is built, **then** `pod.spec!.automountServiceAccountToken` is
   `false`.
   Command: `npx vitest run packages/dispatcher/tests/k8s/manifest.test.ts`.
   Expected: FAIL — the field is `undefined`.
3. - [ ] GREEN — add `automountServiceAccountToken: false` to the `spec` with a
   comment naming the reason (the `default` SA is bound to `kitten-pod-manager`
   via `k8s/rbac.yaml:19-22`).
   Command: `npx vitest run packages/dispatcher/tests/k8s/manifest.test.ts`.
   Expected: all pass, pre-existing tests untouched in the diff.
4. - [ ] Commit: `fix(dispatcher): stop mounting the Kubernetes token into reviewer Pods`
5. - [ ] Manual check on minikube: submit a review, then
   `kubectl --context=minikube exec <job-id> -n kitten -c reviewer -- cat /var/run/secrets/kubernetes.io/serviceaccount/token`.
   Expected: `No such file or directory`, while
   `curl "$DISPATCHER_URL/status/<job-id>"` still reaches `reviewing`.
6. - [ ] Confirm the sidecar is unaffected (risk 2).
   Command: `kubectl --context=minikube exec <job-id> -n kitten -c reviewer -- wget -qO- http://127.0.0.1:8765/health`.
   Expected: `{"status": "ok"}`.
7. - [ ] Docs: `SECURITY.md` hardening section and `docs/architecture.md`
   isolation invariants both state that the reviewer container holds no
   Kubernetes credential.
8. - [ ] `pnpm test && pnpm lint` green; commit:
   `docs: record that reviewer Pods carry no Kubernetes token`

## How to Test

- **Automated**: `pnpm test` — the new manifest test green, all pre-existing
  manifest tests untouched and green. `pnpm lint` clean.
- **Manual verification**: on minikube, submit a review; the Pod reaches
  `reviewing` and posts findings exactly as before, and
  `kubectl exec <job-id> -n kitten -c reviewer -- cat /var/run/secrets/kubernetes.io/serviceaccount/token`
  fails with "No such file or directory".
- **Negative check**: the dispatcher Deployment must still be able to create
  Pods — this card must not touch its ServiceAccount. Submitting a review after
  the change must still create a Pod.
- **Done means**: `pnpm test && pnpm lint` exit 0; no Kubernetes token is
  present inside the reviewer container, and reviews still run end to end.
