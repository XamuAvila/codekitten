---
id: US-019
title: "Review Output in the Configured Language"
status: draft
epic: v3-llm-integration
---

# US-019: Review Output in the Configured Language

## Story

As a **developer on a non-English-speaking team**, I want the findings on my PR written in the language my team configured, so that everyone reading the review understands it without translating.

## Context

`ReviewerConfig.language` (default `"en"`) is parsed and validated but only ever printed to a log line (`packages/reviewer/src/pipeline.ts:61`). It never reaches the prompt, so setting `language: pt` in `.reviewer.yml` changes nothing in the output — a white-label promise the product does not keep.

## Acceptance Criteria

### AC-1: Prose is written in the configured language

```
Given .reviewer.yml sets language: pt
When a review produces findings
Then each finding's "finding" text and "suggestion" text are written in Portuguese
```

### AC-2: Default stays English

```
Given .reviewer.yml omits language (default "en")
When a review produces findings
Then the findings are written in English
And the prompt is functionally equivalent to today's output
```

### AC-3: Structured fields stay canonical

```
Given any configured language
When findings are produced
Then severity remains one of critical|high|medium|low (never translated)
And file, line and ruleId are unchanged
And the payload still validates against FindingSchema
```

### AC-4: Kitten's own operational notices stay English

```
Given .reviewer.yml sets language: pt
When the budget-exceeded notice, the cancellation notice, or the no-issues notice is posted
Then that text is still English
And only LLM-authored prose (findings, suggestions, follow-up answers) is in Portuguese
```

### AC-5: Follow-up answers follow the language

```
Given .reviewer.yml sets language: pt
When a developer sends a follow-up question via POST /review/:jobId/message
Then the LLM answer is written in Portuguese
```

## Notes

- The language instruction belongs in the system prompt (guardrail block), not the user content — it constrains output, not input.
- Static markers and machine-readable text (severity enum, `Actionable comments posted:` counters used by tests) are deliberately excluded from translation; AC-3 pins this.
- **AC-4 is deliberately a negative criterion.** Translating Kitten's own notices was considered and rejected: `language` is a free-form string, so a static message catalog cannot cover arbitrary values (`language: japanese` would silently fall back to English while findings are Japanese — inconsistent), and routing three short notices through an extra LLM call is not worth the latency or cost. Only LLM-authored prose follows the language. Revisit if `language` ever becomes a closed enum.
- No new config field — `language` already exists as `z.string().min(1)` (`packages/shared/src/types/reviewer-config.ts:21`), free-form so any language tag works.
