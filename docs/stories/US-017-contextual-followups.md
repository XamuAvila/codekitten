---
id: US-017
title: "Contextual Follow-Up Answers"
status: draft
epic: v3-llm-integration
---

# US-017: Contextual Follow-Up Answers

## Story

As a **developer**, I want to ask follow-up questions about the review (e.g., "explain finding X", "why is this flagged?") and get LLM answers that reference the actual findings, so that I can understand and act on the review without re-reading the whole diff.

## Acceptance Criteria

### AC-1: Follow-up answered by LLM

```
Given a Pod in "reviewing" state after a completed review
When I POST /review/:jobId/message with { "message": "explain finding 3" }
Then the Pod calls the LLM with the follow-up question
And the answer is posted as a PR comment
And followUpCount is incremented
```

### AC-2: Review context included

```
Given a follow-up question references a finding
When the follow-up LLM call is built
Then the prompt includes the original review findings and the guardrailed review prompt (not just the question)
And the model can answer from the actual review context
```

### AC-3: No re-clone — context from memory

```
Given a Pod answering a follow-up
When the follow-up runs
Then no re-clone happens (the review context — findings and the original prompt with the diff — lives in memory)
```

### AC-4: Follow-up LLM failure does not kill the agent

```
Given the follow-up LLM call fails (after retries)
When the follow-up is processed
Then the Pod stays alive (idle timer continues)
And a failure is logged
And no ack comment claims success
```

### AC-5: Single-turn (no conversation memory)

```
Given a Pod processed several follow-ups
When a new follow-up arrives
Then the prompt uses the review context + the new question only (no multi-turn history)
```

## Notes

- Replaces v2's echo/ack (`postFollowUpAck`) with real LLM answers
- Same message handler reused by v5 webhook
- Single-turn by design — Pod lifetime is 10 min, multi-turn memory is out of scope
- The initial review's clone dir is removed by the pipeline's cleanup (`pipeline.ts:99-102`), so follow-ups answer from the in-memory context (findings + original prompt with diff), never from disk
