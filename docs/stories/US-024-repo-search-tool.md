---
id: US-024
title: "Repository-Wide Search During Agentic Review"
status: draft
epic: v4-mcp-agentic-review
---

# US-024: Repository-Wide Search During Agentic Review

## Story

As a **developer**, I want Kitten's agentic review to search the whole repository for usages and patterns, so that it can catch signature-change breakage and pattern inconsistencies beyond the changed files.

## Acceptance Criteria

### AC-1: search is available in the agentic loop

```
Given an agentic review is running with search enabled in .reviewer-mcp.json
When the model calls search("parseUrl(")
Then the tool returns matches grouped as file:line with the matching line text
And .git and the skip patterns (ReviewerConfig.skip + MCPConfig.search.skip) are excluded
```

### AC-2: search results are capped and flagged

```
Given a query that would match more than maxResults (default 30)
When the tool executes
Then it returns at most maxResults entries
And the result carries a truncated: true flag
```

### AC-3: search honors case sensitivity

```
Given .reviewer-mcp.json sets search.caseSensitive: false
When the model calls search("AuthService")
Then it also matches "authservice" and "AUTHSERVICE"
```

### AC-4: tool results are fed back to the model

```
Given the model calls search in turn N
When the loop appends the tool_result
Then turn N+1's messages contain the search results, so the model can act on them
```

### AC-5: no matches is a result, not an error

```
Given a search query that matches nothing
When the tool executes
Then it returns a "no results" message (empty match set), not an error, and the loop continues
```

## Notes

- The search tool is lexical (regex) by decision D1 — pattern and call-site discovery without an embedding index.
- Search never reads file contents back to the model; it returns matching lines with context lines (contextLines, default 2).
