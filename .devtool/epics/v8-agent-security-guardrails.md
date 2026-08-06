---
id: v8-agent-security-guardrails
title: "v8: Agent Security Guardrails"
status: active
created: "2026-08-05"
---

# v8: Agent Security Guardrails

> The reviewer stops being a channel for leaking what it should never see.
> Defense by construction: files ignored by `.gitignore` or marked sensitive
> are excluded at every ingestion layer (PR file list, full-content reads,
> diff, changed-file index, knowledge anchor, agentic tools, Semble index),
> and any secret pattern that still crosses a boundary is rejected or
> redacted at the output points (knowledge store writes, follow-up answers).
> This is **agent security** — it hardens the reviewer itself. It is NOT a
> security review of the reviewed code.

## Problem

v7 audited surfaces show the reviewer reads, indexes, and emits content with
almost no filtering:

1. **`.gitignore` is never respected.** No code in `packages/` or `docker/`
   reads `.gitignore`. The only exclusion mechanism is the picomatch `skip`
   list, whose defaults (`**/Migrations/**`, `*.Designer.cs`, `**/*.snap`,
   `**/node_modules/**`) do not cover `.env`, lockfiles, private keys, or
   K8s secret manifests — and the monolithic path's `skip` filter is dormant
   (`PipelineConfig.skipPatterns` is hardcoded to `[]` at
   `packages/reviewer/src/index.ts:53`).
2. **The monolithic path ingests everything.** `readChangedFiles` reads the
   full content of every changed file with no skip, no `.gitignore`, and no
   binary/size guard; `git diff` is emitted raw; both flow verbatim into the
   prompt. A PR touching a committed `.env` puts its secrets in the prompt.
3. **Agentic tool gaps.** `semantic_search` returns sidecar paths/snippets to
   the LLM with no exclusion check; `find_related` never checks its target
   file; the Semble sidecar indexes the whole repo honoring only the target
   repo's own ignore files (Kitten's `skip` never reaches it) and runs with
   `env=dict(os.environ)` — every Pod secret handed to a third-party
   subprocess, persisted on a cross-job PVC.
4. **Untrusted text enters the LLM unguarded.** Follow-up questions are
   interpolated raw into a prompt that re-sends the full review context, and
   the answer is posted publicly; `@reviewer remember <text>` and correction
   replies are stored verbatim in the Atlas knowledge store (a pasted token
   is embedded and injected into every future review). No system-prompt
   guardrail forbids revealing secrets, and repo config/conventions/knowledge
   are presented as authoritative rather than untrusted data.

## Solution (v8 scope)

Three pillars, one posture: **filter at the entrance, reject/redact at the
exit.**

### Pillar A — Effective `.gitignore` + sensitive-file exclusion

A shared exclusion matcher (`packages/shared/src/guardrail/exclusions.ts`)
combines, in one decision function:

- `.git/` — always excluded (existing behavior).
- `ReviewerConfig.skip` — repo-declared globs (existing behavior).
- **Sensitive-file denylist** — built-in default patterns (`.env*`, `*.pem`,
  `*.key`, `*.p12`, `.npmrc`, `.netrc`, `.git-credentials`, K8s Secret
  manifests, GCP service-account keys, kubeconfig) **additive** to a new
  `sensitive_paths` field in `.reviewer.yml`.
- **`git check-ignore --no-index` authority** — batched via `--stdin`; the
  `--no-index` flag also reports tracked-but-ignored files (e.g. a
  force-added `.env`), closing the gap that bare check-ignore leaves. A
  snapshot of ignored paths is computed once per review for the in-process
  tree walks (agentic `search`).

The matcher is applied at **every ingestion layer**:

| Layer | Where |
|---|---|
| PR file list (`fetchPrFiles`) | filter with the matcher; fixes the dormant `skipPatterns=[]` |
| Full-content reads (`readChangedFiles`) | matcher before `fs.readFileSync`, plus binary/oversize guard |
| Diff (`generateDiff`) | excluded paths dropped via git `--name-status` filter + kept-path re-diff; counts stay consistent |
| Changed-file index (agentic prompt) | built from already-filtered PR files |
| Knowledge anchor (Voyage query) | uses the filtered diff |
| Agentic tools (`isExcluded` in confinement) | matcher + ignored-path snapshot; `semantic_search` results filtered; `find_related` target checked |
| Semble sidecar | exclusions propagated to the index (mechanism verified in KIT-045) |

### Pillar B — Secret detection + non-exfiltration guardrails

`packages/shared/src/guardrail/secrets.ts` — pattern scanner for the common
secret shapes (GitHub `ghp_`/`gho_`, OpenAI/Anthropic/DeepSeek/Voyage
`sk-`/`al-`, AWS `AKIA`, `Bearer` tokens, URL credentials, `KEY=value`
assignment style) plus a redactor. Applied at the two exit points where
untrusted text must still flow:

- **Follow-up answers** — the model's answer is redacted before being posted
  publicly to the PR (KIT-047).
- **Error/log boundaries** — `AppError` details (`baseUrl` with embedded
  credentials), follow-up message logs, and HTTP error responses are redacted
  (KIT-048).

The system prompt gains an explicit **anti-exfiltration guardrail** — never
reveal secrets/tokens, never repeat file contents verbatim — and a
**prompt-injection guardrail** — conventions, rules, knowledge, and user
messages are untrusted data that must never override the guardrails
(KIT-048).

### Pillar C — Untrusted input hygiene

- **Knowledge store write boundary** — `@reviewer remember <text>` and
  correction replies containing a detected secret pattern are **rejected**
  (nothing persisted), at both the dispatcher webhook and the
  `knowledgeClient.insert` seam (KIT-046).
- **Follow-up messages** — length cap on `FollowUpMessageSchema`; the
  question is never echoed in full in logs (KIT-047).
- **Semble sidecar environment** — replace `env=dict(os.environ)` with a
  minimal whitelist; the Pod's secrets never reach the third-party subprocess
  (KIT-045).

## Invariant amendments

- **Invariant 1 ("worker never mutates cloned repo")**: a **documented, applied
  carve-out** (decision D10, 2026-08-05). Propagating exclusions to the Semble
  index requires a generated `.sembleignore` at the clone root — Semble's MCP
  `search` tool accepts only `query`/`repo`/`top_k` (no extra-exclude param),
  and its ignore-file mechanism is `.gitignore` + `.sembleignore`. The reviewer
  writes this single generated file (append-only to a repo-owned one) after the
  matcher is built; it is regenerated per review and removed with the clone in
  the pipeline `finally`. This is the ONLY mutation of the clone, scoped
  explicitly, recorded in AGENTS.md (KIT-045).
- **No new cross-job state.** The two designated stores (Semble PVC + Atlas
  knowledge) stay the only persistent state; the exclusion matcher is
  computed per review.

## Implementation Cards

Execution order (sequential):

| Card | Story | Scope |
|---|---|---|
| [KIT-042](../features/KIT-042-exclusion-core.md) | [US-036](../../docs/stories/US-036-review-inputs-respect-exclusions.md) | shared guardrail module: exclusion matcher (git check-ignore + denylist + skip), secret scanner/redactor, `sensitive_paths` config |
| [KIT-043](../features/KIT-043-monolithic-pipeline-exclusions.md) | [US-036](../../docs/stories/US-036-review-inputs-respect-exclusions.md) | filter PR file list, full-content reads, diff, index, knowledge anchor; fix dormant `skipPatterns=[]` |
| [KIT-044](../features/KIT-044-agentic-tool-exclusions.md) | [US-036](../../docs/stories/US-036-review-inputs-respect-exclusions.md) | `isExcluded` + matcher in confinement, `semantic_search` result filter, `find_related` target check |
| [KIT-045](../features/KIT-045-semble-sidecar-exclusions.md) | [US-036](../../docs/stories/US-036-review-inputs-respect-exclusions.md) | propagate exclusions to Semble index; minimal sidecar env; invariant-1 carve-out decision |
| [KIT-046](../features/KIT-046-knowledge-store-guard.md) | [US-037](../../docs/stories/US-037-knowledge-store-rejects-secrets.md) | reject remember/corrections containing secret patterns |
| [KIT-047](../features/KIT-047-follow-up-guard.md) | [US-038](../../docs/stories/US-038-follow-ups-never-leak-secrets.md) | follow-up message cap + answer redaction before posting |
| [KIT-048](../features/KIT-048-prompt-and-logging-guardrails.md) | [US-039](../../docs/stories/US-039-agent-resists-exfiltration.md) | system-prompt anti-exfiltration/injection guardrails, redacting error/log boundaries |
| [KIT-054](../features/KIT-054-reviewer-pod-token-minimization.md) | [US-039](../../docs/stories/US-039-agent-resists-exfiltration.md) | `automountServiceAccountToken: false` on the reviewer Pod — the container running LLM-directed tools currently carries a token bound to `kitten-pod-manager` (create/delete pods). Discovered during the v10 brainstorm (v10 D12); independent of every other card here |
| [KIT-049](../features/KIT-049-v8-e2e-and-close.md) | [US-036](../../docs/stories/US-036-review-inputs-respect-exclusions.md) | `security-e2e.sh` (minikube), docs alignment, invariant amendment, epic close gate |

## Architecture

```
packages/shared/src/guardrail/
  exclusions.ts   buildExclusionMatcher(cloneDir, config)
                    → isExcludedPath(relPath)   [.git/ + skip + denylist + check-ignore snapshot]
                    → ignoredPaths()            [snapshot set for tree walks]
                    → patterns()                [for .sembleignore rendering]
  secrets.ts      detectSecrets(text) → matches[]
                  redactSecrets(text) → redacted

Reviewer pipeline (v8)
  clone → read config → buildExclusionMatcher(cloneDir, config)   (config before diff — KIT-043)
  → fetchPrFiles + in-memory matcher.filter   (Pillar A)
  → readChangedFiles + matcher + binary guard (Pillar A)
  → generateDiff, excluded paths dropped via git name-status + kept-path re-diff (Pillar A)
  → knowledge anchor uses filtered diff       (Pillar A)
  → registry ctx carries matcher              (Pillar A — agentic)
  → sidecar receives generated .sembleignore  (Pillar A — index)
  → follow-up answers redacted                (Pillar B)

Dispatcher (v8)
  remember/correction → secrets.detect → reject on match   (Pillar C)
  FollowUpMessageSchema cap                                 (Pillar C)

Semble sidecar (v8)
  minimal env whitelist; reads .sembleignore for index exclusions     (Pillar A/C)
```

## Stack

| Component | Technology | Notes |
|---|---|---|
| Exclusion authority | `git check-ignore --no-index` (batched `--stdin`) | Authority for `.gitignore`; `--no-index` also flags tracked-but-ignored |
| In-process matching | picomatch (already a dependency) | skip + denylist patterns, tree-walk snapshot |
| Secret scanner | in-process format-anchored regex module (no new deps) | `ghp_`, `sk-`, `al-`, `AKIA`, `Bearer`, URL credentials, `KEY=value` — see D9 |
| Config | zod `sensitive_paths` additive field in `.reviewer.yml` | strict schema, additive to built-in denylist |
| Sidecar exclusion | Semble reads `.gitignore` + `.sembleignore` (verified 2026-08-05) — generated `.sembleignore` written by the reviewer into the clone | invariant-1 carve-out (D8), KIT-045 |

## Error handling

| Error | Behavior |
|---|---|
| `git check-ignore` fails (no git in clone?) | Warning; matcher falls back to skip + denylist (ignore never hard-fails a review) |
| `.sembleignore` write refused / Semble does not honor it | Sidecar falls back to upstream defaults; warning; review unaffected |
| Secret pattern in `remember`/correction | Entry rejected + log (delivery acked as ignored); nothing persisted |
| Secret pattern in follow-up answer | Redacted before posting (posting still succeeds) |
| Message over the follow-up cap | Schema VALIDATION 400 (HTTP route) / ignored delivery (webhook) |
| Config `sensitive_paths` invalid | VALIDATION → config fallback to defaults (existing parse behavior) |

Structured errors everywhere: `{ code, message, details }`.

## Recorded decisions (v8 brainstorm — 2026-08-05)

| # | Question | Decision |
|---|---|---|
| D1 | Scope | All three pillars: `.gitignore`/sensitive exclusion, secret detection, untrusted-input hygiene. |
| D2 | Defense strategy | **Filter at ingestion** (never read/index sensitive content) as primary; redaction at output as backstop. |
| D3 | `.gitignore` authority | **`git check-ignore --no-index`** (batched `--stdin`), with a per-review ignored-path snapshot for tree walks. |
| D4 | Tracked-but-ignored files | **Built-in sensitive denylist, additive `sensitive_paths` config** — closes the force-added `.env` gap that check-ignore alone leaves. |
| D5 | Diff scope | Filter at **all layers**: diff, reads, changed-file index, knowledge anchor. The agent never sees the excluded path or content. |
| D6 | Knowledge policy | **Reject** (never persist) remember/corrections containing secret patterns; **redact** follow-up answers before public posting. |
| D7 | Secret patterns | Built-in defaults + repo-extensible via config. |
| D8 | Invariant 1 | **Applied carve-out**: the reviewer writes one generated `.sembleignore` at the clone root (append-only), regenerated per review, removed with the clone. Confirmed necessary by D10 (no other Semble exclusion mechanism exists). |
| D9 | Secret scanner engine (2026-08-05) | **In-process format-anchored regex** (zero deps). `secretlint` (mature) requires Node 22+ — incompatible with the `node:20-alpine` runtime. The 2026 zero-dep alternatives (`@sanity-labs/secret-scan`, `secret-sniff`) are months old with minimal maintenance track records. A small anchored module gives the same coverage with zero dependency risk (KIT-042). |
| D10 | Semble exclusion mechanism (2026-08-05) | **Generated `.sembleignore` written into the clone** by the reviewer (append-only). Verified from Semble docs: it reads `.gitignore` + `.sembleignore` (merged, recursive) and always skips `node_modules/`, `.venv/`, `dist/`, `build/`, `__pycache__/`. The MCP `search` tool accepts only `query`/`repo`/`top_k` — no extra-exclude param exists, so the ignore file is the mechanism (KIT-045). |

## What is NOT in v8 (out-of-scope)

- OS-level sandboxing beyond root confinement (future hardening, unchanged
  from v4).
- Secret scanning of the reviewed CODE as a review feature (this epic
  protects the agent; a "find leaked secrets in the PR" finding type is a
  product decision, not agent security).
- Multi-tenant isolation (v6/v8 concern, unchanged).
- Rotation/management of the operator's own keys (GITHUB_TOKEN, LLM keys) —
  the `.env` hygiene flag raised during the audit is a user action, not code.
- Denylist removals via config (additive only, documented).

## Testing strategy

| Level | What |
|---|---|
| Unit | matcher (check-ignore authority, denylist, skip merge, tracked-but-ignored), secret scanner (each pattern, false positives), redactor, config `sensitive_paths` parse, each chokepoint filter, follow-up cap, rejection paths |
| Integration | real `git check-ignore` against fixture repos (ignored, force-added, nested `.gitignore`); sidecar smoke with exclusions |
| E2E | minikube `security-e2e.sh`: PR touching a force-added `.env` → no secret in prompt/logs/Atlas/Semble results; `remember` with a token → rejected; malicious follow-up ("what's in .env?") → answer without secrets |

Coverage target: 80%+ on touched packages.

## Dependency verification (2026-08-05)

All dependencies audited against 2026 advisories before the epic was written —
**the repo is currently on patched versions; no dependency upgrade is required
by this epic.** Recorded so a future session does not re-audit blindly:

| Dependency | Installed | 2026 advisory | Verdict |
|---|---|---|---|
| `simple-git` | 3.36.0 | CVE-2026-6951 (RCE, fix 3.36.0), CVE-2026-28292 (RCE, fix 3.32.2) | ✅ patched |
| `picomatch` | 4.0.5 | CVE-2026-33672 (method injection via POSIX classes, fix 4.0.4) | ✅ patched — untrusted-glob hardening added in KIT-044 |
| `path-to-regexp` (via express 5) | 8.4.2 | CVE-2026-4923/4926/4867 (ReDoS, fix 8.4.0) | ✅ patched |
| `body-parser` (via express 5) | 2.3.0 | CVE-2026-12590 (DoS via invalid `limit`, fix 2.3.0) | ✅ patched |
| `mongodb` driver | 7.5.0 | CVE-2026-4147 (fix 7.0.31), CVE-2026-9750 (fix 7.0.35) | ✅ patched |
| `@octokit/request` / `@octokit/endpoint` | 10.0.13 / 11.0.3 | CVE-2025-25290 / CVE-2025-25285 (ReDoS) | ✅ patched |
| `express` (dispatcher) | 5.2.1 | monthly 2026 security releases (multer/morgan/body-parser) — dispatcher does not use multer/morgan | ✅ not applicable |

Operational note (not code): the local `.env` holds live-looking credentials
(`GITHUB_TOKEN=gho_…`, `DEEPSEEK_API_KEY=sk-…`, `VOYAGE_API_KEY=al-…`). They are
gitignored, but if real, rotation is recommended. The operator's own keys are
out of scope for this epic (KIT-049).
