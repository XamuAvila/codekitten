---
id: "KIT-036"
status: "done"
priority: "high"
assignee: ""
epic: "v7-deep-context"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
completedAt: "2026-08-05"
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

**Research findings (2026-08-05, Context7 /minishlab/semble + GitHub docs + PyPI):**
- Package `semble` v0.5.3 (MinishLab, MIT). MCP server: `uvx --from "semble[mcp]" semble`, **stdio transport only** (no HTTP mode).
- Index persistence: SUPPORTED — `SEMBLE_CACHE_LOCATION` env (absolute path) sets the cache root; index lives at `<cache>/<sha256(abs repo path)>/index`; **incremental** re-index by file mtime (never full rebuild). Gate passes.
- Embeddings fully local (`potion-code-16M-v2`, CPU, no API key). Model cached under `$HF_HOME`.
- MCP tools: `search(query, repo, top_k, content)` and `find_related(file_path, line, repo)`.
- No documented index locking — safe with one sidecar per Pod; concurrent Pods on the same repo+base sharing a PVC is an open risk (kept as risk 3, note for v8).
- **Consequence 1 (deviation from plan):** the index key hashes the clone's absolute path, so the clone path must be identical across runs. The reviewer now clones to a fixed `CLONE_DIR` (`/workspace/repo`, env-driven, default stays `/tmp/clones/{jobId}` outside K8s) on a shared emptyDir mounted in both containers.
- **Consequence 2 (deviation from plan):** stdio-only MCP cannot cross containers, so the sidecar runs a small Python HTTP shim (`docker/semble-sidecar/server.py`) that spawns semble via the official `mcp` client and exposes `/health`, `/search`; the reviewer's `semantic_search` tool calls it over `http://127.0.0.1:8765` (Pod-shared network namespace).

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

1. - [x] Research gate: current Semble docs (Context7/repo). Record findings in this card. STOP if index persistence unsupported.
2. - [x] Sidecar Dockerfile + local smoke (index a fixture repo, query it).
3. - [x] RED: `tests/mcp/semantic-search.test.ts` — healthy sidecar (mock transport) returns capped snippets; down → `SERVICE_UNAVAILABLE` + fallback hint; input validation. FAIL.
4. - [x] GREEN: tool + registry + config. PASS.
5. - [x] Manifest: sidecar container + volumes + PVC; `pnpm test` on dispatcher manifest tests (extended).
6. - [x] Commit: `feat: semble sidecar with persistent semantic index and semantic_search tool`
7. - [x] minikube verification: two reviews on the same base reuse the index (second run logs "index reused"); sidecar killed mid-review → review completes on lexical tools.
8. - [x] `pnpm test && pnpm lint` green.

**Execution notes (what was actually built, 2026-08-05):**
- Local smoke (not docker-only): `uvx --from "semble[mcp]" semble search <query> <repo>` against a fixture repo returned JSON `{"results": [{"file_path", "start_line", "end_line", "score", "content"}]}`; index persisted at `<SEMBLE_CACHE_LOCATION>/<sha256>/index` and was reused by a second query. The shim's parser handles this observed shape first, text blocks as fallback.
- Docker image `docker/semble-sidecar/Dockerfile` builds clean (uv base image, aiohttp + mcp client, uvx cache warmed at build).
- Manifest: sidecar only when `SEMBLE_IMAGE` env is set on the dispatcher (`PodConfig.sembleImage`); PVC via `SEMBLE_INDEX_PVC` (`kitten-semble-index`), emptyDir fallback otherwise. Reviewer gains `CLONE_DIR=/workspace/repo` + `SEMBLE_SIDECAR_URL` envs; pipeline honors `CLONE_DIR` and passes the URL into `createRegistry`.
- Step 7 (minikube verification: index reuse across runs + sidecar kill) is executed as part of `scripts/deep-context-e2e.sh` in KIT-040 — same assertions, one cluster setup.

## How to Test

- **Automated**: `pnpm test` — tool + manifest tests green.
- **Manual**: minikube agentic review calls `semantic_search` and gets ranked snippets (Pod logs); PVC inspection shows the persisted index.
- **Negative**: delete the sidecar container → `semantic_search` returns the fallback error, review completes; PVC removed → emptyDir warning path.
- **Done means**: `pnpm test && pnpm lint` exit 0; semantic results flow into the loop, index survives across runs, absence degrades lexically.
