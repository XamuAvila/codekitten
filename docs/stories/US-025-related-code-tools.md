---
id: US-025
title: "Related-Code Discovery During Agentic Review"
status: draft
epic: v4-mcp-agentic-review
---

# US-025: Related-Code Discovery During Agentic Review

## Story

As a **developer**, I want Kitten's agentic review to find code related to a given location (call-sites, usages, implementations) and to navigate the directory structure, so that call-site and impact analysis are possible during the review.

## Acceptance Criteria

### AC-1: find_related extracts the identifier and finds occurrences

```
Given the model calls find_related("src/auth.ts", 42) where line 42 contains the identifier sendEmail
When the tool executes
Then it extracts sendEmail and returns repo-wide occurrences with file:line and a short snippet (capped at findRelated.maxResults, default 20)
```

### AC-2: find_related degrades gracefully

```
Given the model calls find_related with a line containing no identifier
When the tool executes
Then it returns a helpful message explaining no identifier was found (not an error), and the loop continues

Given an identifier with no other occurrences in the repo
When the tool executes
Then it returns a "no other occurrences" result (not an error)
```

### AC-3: list_directory returns one-level entries

```
Given the model calls list_directory("src")
When the tool executes
Then it returns the directory's immediate entries with a dir/file flag
And it is capped at listDirectory.maxEntries (default 100) with a truncated flag when exceeded
```

### AC-4: both tools are confined to the clone

```
Given find_related or list_directory receives a path outside the clone root
When the tool executes
Then it returns { code: "VALIDATION" } and reads nothing outside the clone
And .git is never listed or searched
```

## Notes

- `find_related` is symbol/usage-based (decision D1) — the call-site analysis primitive v4 promises. Semantic related-code search is deferred to v7 Deep Context.
- Both tools reuse the same confinement layer as `read_file` (KIT-023).
