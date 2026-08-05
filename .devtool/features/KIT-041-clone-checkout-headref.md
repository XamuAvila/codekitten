---
id: "KIT-041"
status: "in-progress"
priority: "high"
epic: "v7-deep-context"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["bug", "git"]
order: "e7"
---

# Clone never checks out headRef — repo config read from the default branch

## User Story

Bug-in-waiting discovered during KIT-040's e2e (US-034 verification): supports
every story that reads repo state from the clone (US-023+, US-031..034).

## Technical Refinement

`packages/reviewer/src/git/clone.ts` calls `git.clone(url, dir)` with no
branch — the working tree stays on the repo's DEFAULT branch. Everything read
from the worktree (`.reviewer.yml`, `.reviewer-mcp.json`, conventions file,
every agentic tool: read_file/search/git_log/semantic_search) sees the BASE,
not the PR head. Diff generation was unaffected (uses refs), which is why it
went unnoticed since v4. Docstring also claims `--depth=1`, contradicting the
v2 full-clone decision AND the actual code — stale doc.

**Fix:** pass `["--branch", headRef]` to `git.clone` (still a full clone of
all refs; only HEAD checkout changes) and correct the docstring.

## Implementation Plan

1. - [x] RED: clone test — fixture remote with default `main` + branch
   `feature` carrying an extra file; clone with `branch: "feature"` → file
   present in the worktree. FAIL against current code.
2. - [x] GREEN: `--branch` arg + docstring fix.
3. - [x] Commit: `fix(reviewer): check out the PR head branch on clone`
4. - [ ] Re-run deep-context e2e — step 2 (agentic tool call) passes.

## How to Test

- **Automated**: `pnpm test` — new clone test green.
- **Manual**: e2e assertion 2 (`semantic_search`/`git_log` in Pod logs).
- **Negative**: clone of a nonexistent branch → structured NOT_FOUND.
- **Done means**: worktree matches the PR head; e2e step 2 green.
