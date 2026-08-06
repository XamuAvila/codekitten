---
id: "KIT-046"
status: "backlog"
priority: "high"
assignee: ""
epic: "v8-agent-security-guardrails"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["security", "guardrails", "dispatcher", "knowledge"]
order: "f5"
---

# Knowledge Store Guard: Reject Secret-Bearing remember/corrections

## User Story

See [US-037](../../docs/stories/US-037-knowledge-store-rejects-secrets.md).

## Technical Refinement

### Files

**Modified (dispatcher):**
- `packages/dispatcher/src/webhook/events.ts`:
  - `handleIssueComment` (lines 184-210, `remember` path): after parsing `fact`, run `detectSecrets(fact)`. On a match → `console.log` a warning naming the **pattern kind only** (never the value), return `{ ignored: true }` (acknowledge the delivery; GitHub must not retry), store nothing.
  - `handleReviewComment` (lines 115-130, correction path): compose the full string (`Finding: ...\nCorrection: ...`) first, then `detectSecrets` on it — the root-finding excerpt (`ROOT_EXCERPT_LENGTH`, line 28) can itself carry a secret. On a match → same ignore + kind-only log.

**Modified (shared):**
- `packages/shared/src/knowledge/client.ts:139-155` — `insert` runs `detectSecrets(input.text)` first and throws `AppError("VALIDATION", "Knowledge text contains a detected secret", [{ kind }])` on a match. Defense in depth: any caller, present or future, is guarded at the seam (US-037 AC-4).

### Consumes

- `detectSecrets` from `@kitten/shared` (KIT-042).

### Produces

- A guaranteed-invariant: no secret-bearing text is ever persisted to the Atlas `knowledge` collection.

### Design decisions

1. **Reject, don't redact, at the store** (epic D6). A stored fact must stay faithful — masking a token would corrupt the "team fact" it encodes. The secret belongs nowhere near the durable Atlas collection. The webhook path rejects before the write; the client seam rejects as backstop.
2. **Scan both the fact and the correction's root excerpt** — the correction string concatenates the finding excerpt (up to 300 chars, `ROOT_EXCERPT_LENGTH`) with the reply body; either half can carry a secret.
3. **Log only the pattern kind** — invariant 4 (no secrets in logs) extended to pattern matches; the `kind` label never contains the matched value (KIT-042 contract).

### Risks

1. **False positives on legitimate facts** — a rule like "never commit AWS keys" (no actual token) must not be rejected. The scanner is format-anchored (requires a real token shape), and `secrets.test.ts` (KIT-042) pins the benign-prose cases.
2. **Rejecting at the client changes its contract** — `insert` can now throw VALIDATION; existing `knowledge` tests/consumers update in the same commit (the dispatcher webhook and any test calling `insert`).

## Implementation Plan

1. - [ ] RED — `dispatcher/tests/webhook/events.test.ts`: a signed `issue_comment` with `@reviewer remember ghp_<40chars>` → response `{ ignored: true }`, Atlas insert not called, warning logged with `github-token` kind and WITHOUT the value; benign `remember` → stored. FAIL.
2. - [ ] GREEN — scan + reject in `handleIssueComment`. PASS.
3. - [ ] RED — correction path: a reply containing `sk-...` → ignored, nothing stored; benign correction → stored. FAIL.
4. - [ ] GREEN — scan + reject in `handleReviewComment` (scan the full composed string). PASS.
5. - [ ] RED — `shared/tests/knowledge/client.test.ts`: `insert` with secret-bearing text throws `AppError VALIDATION` with `{ kind }`; clean text inserts. FAIL.
6. - [ ] GREEN — client seam guard. PASS.
7. - [ ] `pnpm test && pnpm lint` green; commit: `feat: reject secret-bearing knowledge writes`

## How to Test

- **Automated**: `pnpm test` — dispatcher events + shared knowledge client tests green.
- **Manual**: on minikube, deliver a signed `issue_comment` with `@reviewer remember ghp_...` → dispatcher log shows a rejection with the kind, Atlas count unchanged; a normal `remember` still stores.
- **Negative**: a correction reply on a finding thread containing a pasted API key is rejected; benign prose containing "AWS key" (no token) is stored normally; a direct `knowledgeClient.insert("remember ghp_...")` call throws VALIDATION.
- **Done means**: `pnpm test && pnpm lint` exit 0; no secret-bearing text can be persisted to the knowledge store via any write path.
