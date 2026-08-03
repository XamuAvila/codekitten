---
id: US-013
title: "Inline Diff Comments on PR"
status: draft
epic: v3-llm-integration
---

# US-013: Inline Diff Comments on PR

## Story

As a **developer**, I want findings posted inline on the PR diff (at the exact file:line) instead of only a summary table, so that I can see each issue in context while reviewing the changed code.

## Acceptance Criteria

### AC-1: Findings posted as PR Review with inline comments

```
Given a review produces Finding[] 
When the pipeline posts results
Then a GitHub Pull Request Review is created (state: COMMENTED)
And each finding that maps to a diff position becomes an inline comment on the correct file:line
```

### AC-2: Diff position mapping

```
Given a Finding with file and line
When the comment is posted
Then the position is computed from the PR file patch (diff_hunk)
And the comment anchors to the correct line in the diff
```

### AC-3: Table fallback for unmappable findings

```
Given a finding cannot be mapped to a diff position (renamed file, line outside hunks, removed line)
When results are posted
Then the finding appears in a Markdown table in the review body
And the review still completes successfully
```

### AC-4: Review body summary

```
Given a review posts inline comments
Then the review body contains "Actionable comments posted: N"
And remaining findings are grouped in a severity table
```

### AC-5: Empty findings

```
Given the LLM returns zero findings
When results are posted
Then no review is created or a comment states no issues found (no crash)
```

## Notes

- Hybrid strategy (mirrors CodeRabbit): try inline per finding, fallback to table
- `position` computed from `PullRequestFile.patch` (already fetched in pipeline)
- Unmappable findings never block the review — table fallback is always safe
