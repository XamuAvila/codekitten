---
id: US-023
title: "Agentic Review Opt-In"
status: draft
epic: v4-mcp-agentic-review
---

# US-023: Agentic Review Opt-In

## Story

As a **repo maintainer**, I want to opt my repository into agentic review with a `.reviewer-mcp.json` file so that Kitten explores the codebase through read-only file reads before reporting, so that my PRs get findings that need context beyond the diff.

## Acceptance Criteria

### AC-1: Config opt-in runs the agentic loop

```
Given a repository with .reviewer-mcp.json containing enabled: true
When the review pipeline runs on its PR
Then the review runs the agentic loop (the model can call read_file before reporting)
And the findings are posted through the unchanged v3 contract (consolidation + PR review)
```

### AC-2: Absent config keeps v3 behavior

```
Given a repository with no .reviewer-mcp.json
When the review pipeline runs
Then the review is byte-identical to v3 monolithic (diff + full changed files in the prompt, chunking path unchanged)
```

### AC-3: Invalid config fails safe to monolithic

```
Given .reviewer-mcp.json contains invalid JSON or an unknown key
When the review pipeline runs
Then the review completes on the v3 monolithic path (status "completed", not "failed")
And a warning is logged naming the file
```

### AC-4: read_file reads inside the clone only

```
Given the model calls read_file with a path inside the clone dir
When the tool executes
Then it returns the requested lines with line numbers

Given the model calls read_file with a path escaping the clone root (e.g. ../secret)
When the tool executes
Then it returns { code: "VALIDATION" } and reads nothing outside the clone

Given the model calls read_file with a missing path
When the tool executes
Then it returns { code: "NOT_FOUND" }
```

### AC-5: Loop bounded by maxTurns with a finalize turn

```
Given the model explores without calling report_findings for maxTurns rounds
When the turn budget is exhausted
Then a finalize turn forces the model to report findings
And the review still completes and posts whatever findings were reported
And a budget-exceeded comment invites "force"
```

### AC-6: stop aborts the loop

```
Given a stop command is sent while the agentic loop is exploring
When the loop checks between turns
Then remaining turns are skipped, the status becomes "cancelled", and the Pod exits
```

### AC-7: Findings use the v3 contract

```
Given the model calls report_findings during the loop
When the loop ends
Then the Finding[] is consolidated (dedup by file:line) and posted inline/table exactly as in v3
And no new finding field is introduced
```

## Notes

- Agentic mode replaces the file-content chunking path; monolithic mode keeps v3 chunking untouched.
- The agentic prompt includes the diff + a changed-file index (not full contents) so findings still anchor to exact diff lines.
- `.reviewer-mcp.json` lives in the repo root next to `.reviewer.yml`.
