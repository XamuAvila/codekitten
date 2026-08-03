---
id: US-014
title: "Chunked Multi-Round Review"
status: draft
epic: v3-llm-integration
---

# US-014: Chunked Multi-Round Review

## Story

As a **developer**, I want large PRs (exceeding the token budget) reviewed in chunks across multiple LLM rounds, so that the entire diff gets analyzed within `max_tokens` instead of failing or silently truncating.

## Acceptance Criteria

### AC-1: Single call when under budget

```
Given a PR whose diff + files + conventions fit within max_tokens
When the review runs
Then exactly one LLM call is made
```

### AC-2: Chunked multi-round when over budget

```
Given a PR exceeding max_tokens (default 1,000,000)
When the review runs
Then changed files are split into budget-sized chunks (largest first)
And each chunk is reviewed in a separate LLM call
```

### AC-3: Findings consolidated and deduped

```
Given multi-round review produced findings per chunk
When results are consolidated
Then findings are merged into a single Finding[]
And duplicates (same file:line) appear once
```

### AC-4: Chunk failure is contained

```
Given one chunk's LLM call fails (after retries)
When the review runs
Then the other chunks' findings are still reported
And a warning comment notes the failed chunk
```

### AC-5: Budget question posted to PR

```
Given a PR exceeds the token budget
When the initial review completes (partial findings posted)
Then a comment asks the user to reply `force` for a full review without limits
```

## Notes

- Chunking fills each chunk to budget: files sorted by size (largest first), packed until the budget is exhausted
- Chunks reuse the same guardrailed prompt — only the files subset changes
- `max_tokens` default raised from 200k to 1,000,000 in v3
