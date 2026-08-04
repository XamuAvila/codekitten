---
id: US-018
title: "Custom Review Rules Applied"
status: draft
epic: v3-llm-integration
---

# US-018: Custom Review Rules Applied

## Story

As a **repository maintainer**, I want the `rules[]` I declare in `.reviewer.yml` to actually reach the reviewer and be reported against, so that my team's own conventions are enforced instead of only the reviewer's generic judgement.

## Context

`ReviewerConfig.rules` is parsed and validated (`packages/shared/src/config/parse-config.ts:28,70`) but never consumed — `buildReviewPrompt` (`packages/reviewer/src/prompt/build-prompt.ts:56-67`) emits conventions + diff + files only. The v3 epic specifies `Reviewer rules: {rules}` in the user content. Today a maintainer can declare rules and get zero effect, silently.

A `ReviewRule` is `{ id, description }` (`packages/shared/src/types/reviewer-config.ts:6-9`) — plain text instructions, no glob/pattern matching.

## Acceptance Criteria

### AC-1: Rules reach the prompt

```
Given .reviewer.yml declares rules with id "no-raw-sql" and a description
When the review prompt is built
Then the user content contains a "Reviewer rules:" block listing each rule as "id: description"
And the block appears before the diff
```

### AC-2: Empty rules produce no block

```
Given .reviewer.yml declares no rules (default [])
When the review prompt is built
Then no "Reviewer rules:" block appears in the user content
And the prompt is otherwise unchanged from today's output
```

### AC-3: Findings attribute the rule that triggered them

```
Given rules are present in the prompt
When the LLM reports a finding caused by a declared rule
Then the finding carries ruleId equal to that rule's id
And a finding not caused by any declared rule omits ruleId
```

### AC-4: Rule attribution is visible on the PR

```
Given a posted finding carries a ruleId
When it is rendered as an inline comment or a table row
Then the rule id is shown alongside the severity
```

### AC-5: Unknown rule id is not trusted

```
Given the LLM returns a finding with a ruleId matching no declared rule
When findings are consolidated
Then the finding is kept but the unknown ruleId is dropped
And a warning is logged (no secret or key in the log line)
```

## Notes

- Prompt-level enforcement only. Pattern/glob matching per rule stays out of scope — `ReviewRule` has no pattern field and v1/v2 both deferred it.
- The system prompt must instruct that declared rules are additional criteria, not a replacement for the base guardrails.
- `Finding.ruleId` already exists as optional (`packages/shared/src/types/review-job.ts:29`) — no type change needed.
