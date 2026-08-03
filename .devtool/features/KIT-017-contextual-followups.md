---
id: "KIT-017"
status: "backlog"
priority: "medium"
assignee: ""
epic: "v3-llm-integration"
dueDate: null
created: "2026-08-03"
modified: "2026-08-03"
completedAt: null
labels: ["followup", "llm"]
order: "c7"
---

# Contextual Follow-Up Answers

## User Story

See [US-017](../../docs/stories/US-017-contextual-followups.md).

## Technical Refinement

### Files

**Modified (reviewer):**
- `packages/reviewer/src/agent.ts` — replace `postFollowUpAck` (line 90) with real LLM answer; keep `incrementFollowUpCount`; keep idle timer reset (`agent.ts:82`)
- `packages/reviewer/src/index.ts` — pass review context (findings + prompt) into `startAgent`
- `packages/reviewer/src/types.ts` — `AgentConfig`/`startAgent` gains `reviewContext`
- `packages/reviewer/tests/agent.test.ts` — follow-up LLM tests

### Consumes

- `startAgent` config (`agent.ts:9-17`) — extend with `reviewContext`
- `handleMessage` (`agent.ts:80-96`) — the follow_up branch (line 84-91)
- `incrementFollowUpCount` (`packages/reviewer/src/redis/status.ts:42-57`)
- `AnthropicAdapter`/`createLlmAdapter` (KIT-011/012) — reuse for follow-up calls
- `ReviewResult.findings` (KIT-011) — stored on the Pod for context
- `PipelineResult.findings` (`packages/reviewer/src/types.ts`, KIT-011)

### Produces

- `startAgent(config)` accepts `reviewContext: { findings: readonly Finding[]; prompt: { system: string; user: string } }` — captured from the initial review
- Follow-up behavior: non-command message → LLM call with context prompt (original guardrailed prompt + findings summary + the user's question) → answer posted as PR comment via `postFollowUpAck`-style comment (new `postFollowUpAnswer` with `[KITTEN-TEST]` prefix) → `followUpCount` incremented (US-017 AC-1/AC-2)
- No re-clone: context lives in memory on the Pod (US-017 AC-3)

### Design decisions

1. **Single-turn, context-inclusive prompt** (user decision) — each follow-up builds a fresh prompt: original review findings + original system prompt + the new question. No multi-turn history (Pod lifetime is 10 min; memory is out of scope, US-017 AC-5).
2. **Reuse the initial review's guardrailed prompt** — the follow-up answer inherits the same scope guardrails (review-only, no commit/push) since it reuses the system prompt.
3. **Follow-up failure does not kill the agent** — LLM error (after KIT-011 retries) logs and skips; Pod stays alive; no ack comment claims success (US-017 AC-4).
4. **Command vs question dispatch** — `force`/`stop` (KIT-015/016) are reserved; anything else is a follow-up question. Dispatch order: force → stop → follow-up.

### Risks

1. **Finding references in questions** — "explain finding 3" needs an index; the context includes findings numbered 1..N, and the prompt instructs the model to answer against those numbers.
2. **Follow-up prompt size** — findings + original prompt + question can be large; follow-up calls use `maxOutputTokens` but no chunking (single question, bounded). A pathological huge findings list is clipped (top 20 findings — `maxFindings` already bounds it).

## Implementation Plan

1. - [ ] **RED — follow-up context type + agent test**: `packages/reviewer/tests/agent.test.ts` — startAgent with `reviewContext`; follow_up `"explain finding 1"` → LLM called once with prompt containing the original system prompt, findings summary, and the question; `incrementFollowUpCount` called; answer comment posted. Run: FAIL.
2. - [ ] **GREEN — agent follow-up**: thread `reviewContext`; replace `postFollowUpAck` with LLM call + `postFollowUpAnswer`. PASS.
3. - [ ] Commit: `feat(reviewer): LLM-powered follow-up answers with review context`
4. - [ ] **RED — failure containment test**: `packages/reviewer/tests/agent.test.ts` — follow-up LLM fails (mocked, after retries) → agent stays alive (idle timer NOT fired, shutdown NOT called), no comment posted, error logged. Run: FAIL.
5. - [ ] **GREEN — error path**: wrap follow-up LLM call in try/catch per decision 3. PASS.
6. - [ ] Commit: `feat(reviewer): contain follow-up LLM failures without killing agent`
7. - [ ] **RED — index wiring test**: `packages/reviewer/tests/pipeline.test.ts` or a new wiring test — pipeline result `findings` flow into `startAgent(reviewContext)`. Run: FAIL.
8. - [ ] **GREEN — index.ts wiring**: capture `PipelineResult.findings` + built prompt; pass into `startAgent`. PASS.
9. - [ ] Commit: `feat(reviewer): pass review context into agent lifecycle`
10. - [ ] Run: `pnpm test && pnpm lint` — all green.

## How to Test

- **Automated**: `pnpm test` — `packages/reviewer/tests/agent.test.ts` (context prompt, answer posted, failure containment), pipeline/index wiring tests. All PASS.
- **Manual verification**: on minikube, trigger a review on `XamuAvila/kitten-test-repo` PR #1; once `reviewing`, `curl -X POST $DISPATCHER_URL/review/<jobId>/message -d '{"message":"explain the changes in utils.ts","sender":"dev"}'` → PR receives a real LLM answer comment (not "Received your message..."), `GET /status/<jobId>` shows `followUpCount: 1`; Pod logs show the follow-up LLM call with the review context.
- **Negative check**: a follow-up sent when the LLM is unreachable (unset/invalid key) → Pod stays in `reviewing` state (not dead), no answer comment posted, `followUpCount` still incremented? (No — decision: count increments only on successful answer; assert `followUpCount` stays 0 on failure); `force`/`stop` messages are still treated as commands, not questions.
- **Done means**: `pnpm test` green; follow-ups produce real LLM answers referencing the review context, failures leave the Pod alive, and `followUpCount` increments only on successful answers.
