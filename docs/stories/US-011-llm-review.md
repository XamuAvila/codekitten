---
id: US-011
title: "LLM Review with Real Findings"
status: draft
epic: v3-llm-integration
---

# US-011: LLM Review with Real Findings

## Story

As a **developer**, I want my PR reviewed by an LLM that posts real findings (severity, file:line, suggestion) on the PR instead of a dry-run placeholder, so that I can fix genuine issues before merge without a human review bottleneck.

## Acceptance Criteria

### AC-1: Real findings posted on PR

```
Given a review Pod runs the pipeline on a PR with .reviewer.yml present
When the pipeline completes
Then the PR receives a comment with Finding[] from the LLM
And each finding has severity, file, line, and finding text
And the comment is NOT the v2 placeholder ("DRY RUN")
```

### AC-2: Guardrails enforced in prompt

```
Given the prompt builder runs
When the prompt is built
Then the system prompt contains: review-only scope (never commit/push), exact file:line requirement, no style/praise comments, cyclomatic complexity threshold (max_complexity), and max_findings limit
```

### AC-3: Structured output via tool use

```
Given the AnthropicAdapter calls the LLM
When the response is parsed
Then findings come from the tool_use result with the Finding schema
And no fragile JSON-string parsing is used
```

### AC-4: Config respects max_findings and max_complexity

```
Given .reviewer.yml sets max_findings: 5 and max_complexity: 12
When the review runs
Then the prompt contains "at most 5 findings" and "complexity threshold 12"
```

### AC-5: LLM failure fails the review cleanly

```
Given the LLM call fails with rate limit (429) three times
When the pipeline runs
Then the review status is "failed" with error code recorded
And no placeholder comment is posted as if the review succeeded
```

### AC-6: Token estimate replaced by real call

```
Given the pipeline runs
When it completes
Then it logged a real LLM call (model, tokens used), not a token estimate
```

## Notes

- Provider default: `provider: anthropic`, `model: deepseek-v4-flash` (DeepSeek via Anthropic SDK, cheap for tests)
- Posting format for this story: single comment with Markdown table (inline diff comments come in US-013)
- `.reviewer.yml` defaults updated: `max_tokens: 1_000_000`, new `max_findings`, `max_complexity`
- Uses `XamuAvila/kitten-test-repo` PR #1 fixture
