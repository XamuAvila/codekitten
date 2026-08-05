---
id: "KIT-035"
status: "backlog"
priority: "high"
assignee: ""
epic: "v7-deep-context"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["deep-context", "tools"]
order: "e1"
---

# Git History Tools (git_log + git_blame)

## User Story

See [US-031](../../docs/stories/US-031-git-history-tools.md).

## Technical Refinement

**Created (reviewer):**
- `packages/reviewer/src/mcp/git-log.ts` — `gitLogTool: McpTool` (`git log --follow -n <cap> --format=...` on the confined path via `simple-git`, already a dependency)
- `packages/reviewer/src/mcp/git-blame.ts` — `gitBlameTool: McpTool` (`git blame -L start,end --porcelain`, parsed to `line\thash\tauthor\tdate\ttext`)

**Modified:**
- `packages/reviewer/src/mcp/registry.ts` — register both
- `packages/shared/src/config/mcp-config.ts` — `McpToolName` union gains `git_log`/`git_blame`; `MCPConfig` gains `gitLog: { maxCommits }` (default 20) and `gitBlame: { maxLines }` (default 200); default `tools` list includes both

**Consumes:** `confinePath`/`isExcluded` (confinement.ts), `McpTool` contract (registry.ts), `simple-git` (already used by git/clone.ts).

**Decisions:**
1. `simple-git` raw commands, not child_process — same dependency the clone path uses.
2. History depth capped by config, `truncated` flag on cap hit (v4 contract).
3. Clone is full (v2 decision — not shallow), so history is available; a path with no commits → `NOT_FOUND` tool error, loop continues.

**Risks:** `--follow` renames can be slow on huge repos — bounded by `-n` cap.

## Implementation Plan

1. - [ ] RED: `tests/mcp/git-log.test.ts` + `git-blame.test.ts` on a fixture repo built in beforeAll (real git init + commits). Caps, confinement escapes, no-history path, blame range clamping. FAIL.
2. - [ ] GREEN: both tools + registry + config schema. PASS.
3. - [ ] RED/GREEN: loop integration test — results feed the next turn (v4 pattern).
4. - [ ] Commit: `feat(reviewer): add git_log and git_blame agentic tools`
5. - [ ] `pnpm test && pnpm lint` green.

## How to Test

- **Automated**: `pnpm test` — new tool tests + suites green.
- **Manual**: minikube agentic review → Pod log shows a `git_log` call and a finding referencing churn/age.
- **Negative**: `git_log("../../etc")` → `VALIDATION`; blame beyond EOF → clamped range, not an error.
- **Done means**: `pnpm test && pnpm lint` exit 0; both tools capped, confined, and usable by the loop.
