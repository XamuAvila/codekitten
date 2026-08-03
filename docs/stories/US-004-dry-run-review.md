---
id: US-004
title: Dry-Run Review Pipeline
status: draft
epic: v1-scaffolding-dry-run
---

# US-004: Dry-Run Review Pipeline

## Story

As a **developer**, I want the worker to process a review job end-to-end — clone, diff, read config, and log a dry-run summary — so that I can verify the entire pipeline works before integrating an LLM.

## Acceptance Criteria

### AC-1: Worker clones the repository

```
Given a review job is queued with repo "octocat/Hello-World" and headRef "main"
When the worker picks up the job
Then it clones the repo with --depth=50 into a temporary directory
And logs "[worker] Cloning octocat/Hello-World (depth=50)..."
And logs "[worker] Clone complete: {size}"
```

### AC-2: Worker lists files in clone

```
Given the repo is cloned (--depth=1, no history)
When the worker scans the repository files
Then it logs the total file count:
  "[worker] Files in repo: {total}"
  "[worker] Files after skip patterns: {filtered}"
Note: real diff stats (additions/deletions) require GitHub API integration (v2+).
In v1, all files in the clone are treated as the analysis scope.
```

### AC-3: Worker reads .reviewer.yml if present

```
Given the cloned repo contains a .reviewer.yml file
When the worker reads it
Then it parses the config and logs:
  "[worker] Config loaded: language={lang}, model={model}, skip={count} patterns"
```

### AC-4: Worker uses defaults when no config

```
Given the cloned repo does NOT contain a .reviewer.yml file
When the worker looks for config
Then it uses default values and logs:
  "[worker] Config: .reviewer.yml not found, using defaults"
```

### AC-5: Worker applies skip patterns

```
Given the config has skip patterns ["**/Migrations/**", "*.snap"]
When the worker lists changed files
Then files matching skip patterns are excluded from the changed files list
And logs "[worker] Skipped {count} files by pattern"
```

### AC-6: Worker logs dry-run summary

```
Given the worker has clone, diff, config, and changed files
When it reaches the analysis step
Then it logs (instead of calling an LLM):
  "[worker] DRY RUN — would send {tokens}k tokens to {model}"
  "[worker] DRY RUN — would post PR comment with findings"
```

### AC-7: Worker cleans up clone directory

```
Given the worker has finished processing (success or failure)
When the job completes
Then the clone directory is deleted
And logs "[worker] Cleanup: removed clone dir"
And the job status is updated to "completed" (or "failed" on error)
```

### AC-8: Clone failure is handled gracefully

```
Given a review job has an invalid repo (e.g., "nonexistent/repo")
When the worker attempts to clone
Then the job fails with a structured error:
  { code: "NOT_FOUND", message: "Repository not found or inaccessible" }
And no clone directory is left behind
And the job status is "failed"
```

## Notes

- `simple-git` for all git operations.
- Config parsing uses Zod validation (shared package).
- Token estimation is rough (chars / 4) — just for dry-run logging, not billing.
- Clone workspace: `/tmp/clones/{jobId}/` inside worker container.
- Cleanup runs in a `finally` block — must happen even on error.
- Skip pattern matching via `minimatch` or `picomatch` (glob library).
