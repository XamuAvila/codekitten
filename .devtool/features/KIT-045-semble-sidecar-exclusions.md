---
id: "KIT-045"
status: "backlog"
priority: "medium"
assignee: ""
epic: "v8-agent-security-guardrails"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["security", "guardrails", "sidecar"]
order: "f4"
---

# Semble Sidecar: Exclusion Propagation + Minimal Env

## User Story

See [US-036](../../docs/stories/US-036-review-inputs-respect-exclusions.md) (AC-2) and
[US-039](../../docs/stories/US-039-agent-resists-exfiltration.md) (AC-3).

## Technical Refinement

### Files

**Modified:**
- `docker/semble-sidecar/server.py`:
  - `main()` (lines 129-150): replace `env=dict(os.environ)` with a **minimal whitelist** — `PATH`, `HOME`, `REPO_PATH`, `SEMBLE_CACHE_LOCATION`, `PORT`, `UV_CACHE_DIR` only. The subprocess (Semble via `uvx`) must never receive `GITHUB_TOKEN`, the LLM keys, `MONGODB_URI`, or `VOYAGE_API_KEY`.
  - Add a startup step: **before** the first `search`, ensure the clone's `.sembleignore` exists (the reviewer writes it; the sidecar only validates it's present and logs a warning if not). The index build is lazy on first `search`, so the file must exist before the first query.
  - `parse_results`/`handle_search` unchanged — the reviewer (KIT-044) filters result paths.
- `packages/dispatcher/src/k8s/manifest.ts:174-178` — the sidecar env needs nothing new if the reviewer writes `.sembleignore` into the shared clone volume; keep the current env, add nothing. Only if the reviewer cannot write the file (should not happen — same volume) would a config env be needed.
- `packages/reviewer/src/pipeline.ts` — after clone + matcher (KIT-043), **write the generated `.sembleignore`** at `<cloneDir>/.sembleignore` containing the merged exclusion patterns from `matcher.patterns()`. This is the **documented invariant-1 carve-out** (epic D8): a single generated file in the ephemeral clone, removed with the clone in the `finally` cleanup.
- `AGENTS.md` — record the carve-out in the same commit: "The worker never mutates the cloned repo, except one generated `.sembleignore` at the clone root (v8 security guardrails), removed with the clone."

### Consumes

- `matcher.patterns()` from `@kitten/shared` (KIT-042) — the pattern list rendered as gitignore-syntax lines.
- The shared clone volume between reviewer and sidecar (`/workspace`), already in the manifest (KIT-036).

### Produces

- Semble's index never contains excluded paths (respecting `.sembleignore`, which Semble merges with the repo's `.gitignore`).
- The sidecar subprocess env is a fixed whitelist — no Pod secret reaches the third-party process.

### Design decisions

1. **`.sembleignore` generated in the clone** (decision 2026-08-05, epic D8). Verified from the Semble docs (2026-08-05): Semble reads `.gitignore` + `.sembleignore` (standard gitignore syntax, merged, applied recursively); it also always skips `node_modules/`, `.venv/`, `dist/`, `build/`, `__pycache__/`. The reviewer writes the file because only it has the config; the sidecar and reviewer share the volume. Writing one generated file is the minimal carve-out — alternatives (Semble CLI flag / MCP param for extra excludes) are not supported by the MCP `search` tool signature (`query`, `repo`, `top_k`).
2. **Invariant-1 carve-out is scoped to exactly this file** — `.sembleignore` at the clone root, regenerated per review, removed with the clone. AGENTS.md updated in the same commit (docs-alignment rule).
3. **Env whitelist is defense for the third-party process** — the reviewer-side result filter (KIT-044) is the guarantee for the LLM regardless of index contents. The whitelist prevents the index/process from ever seeing the Pod's secrets even if a future bug bypasses the filter.
4. **Pre-existing index staleness** — a PVC index built before this card (without exclusions) may still hold excluded paths. Mitigation: the KIT-044 filter still drops them from results; the e2e (KIT-049) rebuilds the index to prove the exclusion.

### Risks

1. **`uvx` needs more env than the whitelist** (e.g. `UV_CACHE_DIR` must exist, `VIRTUAL_ENV`?) → the smoke test in step 2 verifies the whitelist boots Semble; if it fails, add the minimal extra var and record it (not `dict(os.environ)`).
2. **Semble re-index behavior on `.sembleignore` change** — incremental index keyed by mtime may or may not pick up new exclusions. Mitigated: rebuild (delete the repo's index subdir) when the exclusion hash changes, or accept a one-time stale index; documented in the card; the KIT-044 filter covers correctness meanwhile.
3. **`.sembleignore` overwrites a repo-owned one** — the repo may already have a `.sembleignore`. The generated file must **append** to an existing one (read + append), never replace.

## Implementation Plan

1. - [ ] Smoke test the env whitelist: run the sidecar container with only `PATH`/`HOME`/`UV_CACHE_DIR`/`REPO_PATH`/`SEMBLE_CACHE_LOCATION`/`PORT` against a fixture repo → `/health` ok and a `search` returns results. Record which env vars are actually required (card-fidelity).
2. - [ ] RED — `server.py` env-builder unit test: the function returns only the whitelisted keys, never `GITHUB_TOKEN`/LLM keys/`MONGODB_URI`/`VOYAGE_API_KEY`. FAIL (currently `dict(os.environ)`).
3. - [ ] GREEN — minimal env whitelist. PASS.
4. - [ ] RED — `.sembleignore` writer unit test (reviewer): given a matcher, writes the merged patterns as gitignore lines; appends to an existing `.sembleignore`; re-writes on each review. FAIL.
5. - [ ] GREEN — writer + pipeline hook. PASS.
6. - [ ] RED — sidecar smoke: fixture repo with an excluded path → Semble search does not return it (after index rebuild). FAIL.
7. - [ ] GREEN — ensure the sidecar reads the generated file (startup validation + warning if missing). PASS.
8. - [ ] AGENTS.md carve-out + docs alignment in the same commit.
9. - [ ] `pnpm test && pnpm lint` green; sidecar smoke green; commit: `feat: propagate repo exclusions to the Semble index and minimize sidecar env`

## How to Test

- **Automated**: `pnpm test` — env-whitelist and `.sembleignore` writer units; `docker/semble-sidecar` smoke against a fixture repo with an ignored path.
- **Manual**: on minikube, review a repo with a committed `.env` → `kubectl exec` into the sidecar, run `ps eww` on the Semble process → no secret env vars; the index search never returns `.env`.
- **Negative**: sidecar boot with only the whitelist fails → the smoke test catches it (step 1) and the missing var is added to the whitelist, not by reverting to `dict(os.environ)`; a repo-owned `.sembleignore` is preserved (appended, not replaced).
- **Done means**: `pnpm test && pnpm lint` exit 0; the Semble subprocess env carries no Pod secrets; excluded paths are absent from the index results; the invariant-1 carve-out is recorded in AGENTS.md.
