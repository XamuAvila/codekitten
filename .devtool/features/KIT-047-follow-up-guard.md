---
id: "KIT-047"
status: "backlog"
priority: "high"
assignee: ""
epic: "v8-agent-security-guardrails"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["security", "guardrails", "reviewer", "dispatcher"]
order: "f6"
---

# Follow-Up Guard: Message Cap + Answer Redaction

## User Story

See [US-038](../../docs/stories/US-038-follow-ups-never-leak-secrets.md).

## Technical Refinement

### Files

**Modified (shared):**
- `packages/shared/src/types/review-status.ts:22-25` — `FollowUpMessageSchema` gains `message: z.string().min(1).max(2000)` (cap: 2000 chars). `sender` unchanged.

**Modified (dispatcher):**
- `packages/dispatcher/src/routes/message.ts:20-21` — no code change; the `validate(FollowUpMessageSchema)` middleware now rejects oversized messages with VALIDATION 400.
- `packages/dispatcher/src/webhook/events.ts:212-216` — a follow-up message over the cap is an ignored delivery (no publish). The webhook path already computes `message`; add the length check before `publishFollowUp`.

**Modified (reviewer):**
- `packages/reviewer/src/agent.ts`:
  - `handleMessage` (line 128): log a **truncated preview** (≤80 chars) instead of the full message — `"${payload.message.slice(0, 80)}${payload.message.length > 80 ? "…" : ""}"` (US-038 AC-3).
  - `answerFollowUp` (lines 162-188): after `adapter.respond`, run `redactSecrets(answer)` and post the redacted text via `postFollowUpAnswer`. Also `slice(0, 2000)` the question before interpolation as defense in depth (the schema already caps the route/webhook paths).

### Consumes

- `redactSecrets` from `@kitten/shared` (KIT-042).
- `FollowUpMessageSchema` — updated in this card (shared).

### Produces

- Guarantee: no follow-up answer with a detectable secret is posted unmasked; no over-cap message reaches the Pod.

### Design decisions

1. **Redact the output, not the input, for answers** — the model is fed the guardrailed context; the residual risk is the model echoing what it saw (knowledge/conventions/diff). Redaction is the backstop at the public boundary (epic D2: filter at entrance, redact at exit).
2. **Cap at the schema** — one source of truth for the HTTP route and the webhook; both already validate through the same schema. 2000 chars is generous for a question and bounds prompt-extension cost.
3. **Redaction never throws and never drops the answer** — a matched secret is masked (default replacer `***`), the rest of the answer posts unchanged (US-038 AC-2: "the post still succeeds"). Wrap the redaction so a scanner failure cannot kill the agent (failure keeps the agent alive, US-017 AC-4).

### Risks

1. Redaction alters a legitimate answer that quotes a URL with credentials — masked, not dropped; acceptable per US-038 AC-2. Pinned in the test.
2. The follow-up answer failure path already keeps the agent alive; a redaction-throw must not change that — covered by the non-throwing wrapper test.
3. The schema cap changes the wire contract — existing `routes/message.test.ts`/`events.test.ts` fixtures with long messages update in the same commit.

## Implementation Plan

1. - [ ] RED — `shared/tests/types/review-status.test.ts`: schema accepts a 2000-char message, rejects 2001 with VALIDATION. FAIL.
2. - [ ] GREEN — schema cap. PASS.
3. - [ ] RED — `reviewer/tests/agent.test.ts`: an answer containing `ghp_...` is posted with the secret masked; a benign answer posts unchanged; the message log shows ≤80 chars; a redaction that throws does not kill the follow-up. FAIL.
4. - [ ] GREEN — truncation + redaction in `agent.ts`. PASS.
5. - [ ] RED — `dispatcher/tests/webhook/events.test.ts`: an over-cap follow-up → `{ ignored: true }`, no publish. FAIL.
6. - [ ] GREEN — webhook cap guard. PASS.
7. - [ ] `pnpm test && pnpm lint` green; commit: `feat: cap follow-up messages and redact answers before posting`

## How to Test

- **Automated**: `pnpm test` — schema, agent redaction/truncation, webhook cap tests green.
- **Manual**: on minikube, follow-up asking "what's in the .env?" → the posted answer contains no `.env` content; a follow-up longer than 2000 chars is rejected (400) on the route and ignored via the webhook.
- **Negative**: an answer quoting a URL with credentials posts with the credentials masked (not dropped); a normal answer posts unchanged; a redaction failure does not kill the agent.
- **Done means**: `pnpm test && pnpm lint` exit 0; no follow-up answer with a detectable secret is posted unmasked, and no over-cap message reaches the Pod.
