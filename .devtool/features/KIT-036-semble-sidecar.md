---
id: "KIT-036"
status: "backlog"
priority: "high"
assignee: ""
epic: "v7-deep-context"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["deep-context", "semble", "infra"]
order: "e2"
---

# Semble Sidecar + semantic_search Tool

## User Story

See [US-032](../../docs/stories/US-032-semantic-code-search.md).

## Technical Refinement

**RESEARCH FIRST (gate):** verify Semble's current CLI/MCP interface, index
persistence location/flags, and incremental-index support via Context7/repo
docs before any code — v4 D1 notes (`uvx --from "semble[mcp]"`, no read_file
tool) may be stale. If Semble cannot persist/reuse an index directory, this
card's design must be re-opened.

**Created:**
- `docker/semble-sidecar/Dockerfile` — python + uv image running Semble MCP over `/workspace` (clone volume), index dir `/semble-index`
- `packages/reviewer/src/mcp/semantic-search.ts` — `semanticSearchTool: McpTool` calling the sidecar (MCP over local socket/stdio bridge or HTTP — per research), capped results, `SERVICE_UNAVAILABLE` tool error with fallback hint when sidecar unhealthy
- PVC manifest `k8s/semble-index-pvc.yaml`

**Modified:**
- `packages/dispatcher/src/k8s/manifest.ts` — Pod manifest gains the sidecar container, shared clone volume (emptyDir), PVC mount `/semble-index`; sidecar env keyed by repo + baseRef (index path `/semble-index/{repo}/{baseRef}`)
- `packages/shared/src/config/mcp-config.ts` — `semantic_search` tool name + `semanticSearch: { maxResults }` (default 10)
- `packages/reviewer/src/mcp/registry.ts` — register (only when sidecar env present)

**Decisions:**
1. Sidecar, not fat image (epic D2) — node image untouched; sidecar shares the clone via the Pod volume.
2. Index keyed `{repo}/{baseRef}` on the PVC — reused across runs, incremental update at Pod start; base-branch switch → fresh index dir.
3. Reviewer container never touches the index directly — all access through the sidecar protocol.
4. PVC absent → sidecar uses emptyDir (fresh index per run, warning) — reviews never blocked by storage.

**Risks:**
1. Semble interface drift → research gate above.
2. First-index latency on big repos delays the first review — logged; index build happens while clone/diff run where possible.
3. PVC concurrent access from parallel Pods of different PRs (same repo/base) — verify Semble locking; if unsafe, per-job index copy (slower) and note for v8.

## Implementation Plan

1. - [ ] Research gate: current Semble docs (Context7/repo). Record findings in this card. STOP if index persistence unsupported.
2. - [ ] Sidecar Dockerfile + local smoke (index a fixture repo, query it).
3. - [ ] RED: `tests/mcp/semantic-search.test.ts` — healthy sidecar (mock transport) returns capped snippets; down → `SERVICE_UNAVAILABLE` + fallback hint; input validation. FAIL.
4. - [ ] GREEN: tool + registry + config. PASS.
5. - [ ] Manifest: sidecar container + volumes + PVC; `pnpm test` on dispatcher manifest tests (extended).
6. - [ ] Commit: `feat: semble sidecar with persistent semantic index and semantic_search tool`
7. - [ ] minikube verification: two reviews on the same base reuse the index (second run logs "index reused"); sidecar killed mid-review → review completes on lexical tools.
8. - [ ] `pnpm test && pnpm lint` green.

## How to Test

- **Automated**: `pnpm test` — tool + manifest tests green.
- **Manual**: minikube agentic review calls `semantic_search` and gets ranked snippets (Pod logs); PVC inspection shows the persisted index.
- **Negative**: delete the sidecar container → `semantic_search` returns the fallback error, review completes; PVC removed → emptyDir warning path.
- **Done means**: `pnpm test && pnpm lint` exit 0; semantic results flow into the loop, index survives across runs, absence degrades lexically.
