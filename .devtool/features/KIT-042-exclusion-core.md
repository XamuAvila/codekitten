---
id: "KIT-042"
status: "backlog"
priority: "high"
assignee: ""
epic: "v8-agent-security-guardrails"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["security", "guardrails", "shared"]
order: "f1"
---

# Shared Guardrail Core: Exclusion Matcher + Secret Scanner

## User Story

See [US-036](../../docs/stories/US-036-review-inputs-respect-exclusions.md) (AC-1..AC-4) and
[US-037](../../docs/stories/US-037-knowledge-store-rejects-secrets.md) (AC-4 seam).

## Technical Refinement

### Files

**Created (shared):**
- `packages/shared/src/guardrail/exclusions.ts` — exclusion matcher (git-aware ignore + denylist).
- `packages/shared/src/guardrail/secrets.ts` — secret scanner + redactor.
- `packages/shared/tests/guardrail/exclusions.test.ts`, `packages/shared/tests/guardrail/secrets.test.ts`.

**Modified (shared):**
- `packages/shared/src/config/reviewer-config.ts:16-39` — add `sensitivePaths: z.array(z.string()).readonly()` to `ReviewerConfigSchema`.
- `packages/shared/src/config/defaults.ts:6-24` — add `sensitivePaths: []` to `DEFAULT_CONFIG`.
- `packages/shared/src/config/parse-config.ts:15-30,57-74` — parse `sensitive_paths` (snake_case) → `sensitivePaths`; missing → `[]`.
- `packages/shared/src/index.ts` — export the guardrail module.

### Consumes

- `ReviewerConfig` (`packages/shared/src/types/reviewer-config.ts`) — `skip` (existing), new `sensitivePaths`.
- `simple-git` (`packages/reviewer/package.json`, already `^3.36.0` — patched for CVE-2026-6951/CVE-2026-28292) via `git.raw()` for the check-ignore/ls-files commands. `picomatch` (`^4.0.5`, patched for CVE-2026-33672) for pattern matching.
- `AppError` (`packages/shared/src/types/errors.js`) for structured errors.

### Produces

```typescript
// exclusions.ts
export const SENSITIVE_DEFAULT_PATTERNS: readonly string[];
// .env*, *.pem, *.key, *.p12, *.pfx, .npmrc, .netrc, .git-credentials,
// .gitconfig, **/kubeconfig, **/*secret*.yaml, **/*secret*.yml,
// **/service-account*.json, **/credentials*.json, **/id_rsa, **/id_ed25519

export interface ExclusionMatcher {
  /** True when the repo-relative path must never be read/searched/indexed. */
  isExcludedPath(relPath: string): boolean;
  /** All active patterns (skip + sensitivePaths + denylist defaults). */
  patterns(): readonly string[];
  /** Ignored paths resolved by `git check-ignore --no-index` (set of rel paths). */
  ignoredPaths(): ReadonlySet<string>;
}

export function buildExclusionMatcher(
  cloneDir: string,
  config: Pick<ReviewerConfig, "skip" | "sensitivePaths">,
): Promise<ExclusionMatcher>;

/** Loads the ignored-path snapshot from the worktree via git (batched, -z). */
export function loadIgnoredPaths(cloneDir: string): Promise<ReadonlySet<string>>;
// Runs `git ls-files -z` + `git ls-files -z --others --ignored --exclude-standard`
// → union → `git check-ignore --no-index --stdin -z`. Never throws: returns an
// empty set + warning on any git failure (degradation, US-036 AC-4).

// secrets.ts
export interface SecretMatch { readonly kind: string; readonly start: number; readonly end: number; }
export function detectSecrets(text: string): readonly SecretMatch[];
export function redactSecrets(text: string, replacer?: (m: SecretMatch) => string): string;
// Default replacer masks the matched span with `***`. Kinds (format-anchored):
// github-token (ghp_/gho_/ghu_/ghs_/ghr_), openai-key (sk-proj-), anthropic-key
// (sk-ant-), deepseek-key (sk-…), voyage-key (al-…), aws-access-key (AKIA…),
// bearer-token (Bearer <token>), url-credentials (scheme://user:pass@),
// private-key (-----BEGIN … PRIVATE KEY-----), env-assignment (KEY=value).
```

**Consumed by:** KIT-043 (`buildExclusionMatcher`, `patterns`, `isExcludedPath`), KIT-044 (`isExcludedPath`, `ignoredPaths`), KIT-045 (`patterns` → `.sembleignore`), KIT-046/KIT-047/KIT-048 (`detectSecrets`/`redactSecrets`).

### Design decisions

1. **`git check-ignore --no-index` is the ignore authority** (epic D3). Verified empirically 2026-08-05 on this repo's git:
   - a **tracked file that becomes ignored later** (e.g. `.env` committed before `.gitignore` existed) is NOT reported by plain `git check-ignore` (exit 1) but **IS** reported with `--no-index` — exactly the gap this epic closes;
   - a **force-added** (tracked+ignored) file IS reported in both modes;
   - an untracked ignored file IS reported in both modes.
   The snapshot is therefore computed with `--no-index` over the union of `git ls-files -z` (tracked) and `git ls-files -z --others --ignored --exclude-standard` (untracked ignored).
2. **No `.gitignore` parsing library.** The mature `ignore` (node-ignore 7.0.6, jul/2026) was evaluated and rejected: `git check-ignore` already covers `.gitignore` + `.git/info/exclude` + `core.excludesFile` + negations, which a JS parser re-implements incompletely; a subprocess snapshot once per review is cheaper and more correct than a partial spec reimplementation. Zero new runtime deps.
3. **Denylist is additive-only** (epic D7): `sensitive_paths` widens, never narrows. Defaults live in `SENSITIVE_DEFAULT_PATTERNS` (picomatch, `dot: true`), targeting file suffixes/well-known names — deliberately narrow (`**/credentials*.json` but not `**/*.json`) to avoid over-blocking (KIT-042 risk 2).
4. **Snapshot + patterns, one decision function** — `isExcludedPath = .git/ || picomatch(patterns ∪ skip) || ignoredPaths.has(relPath) || ancestor-in-ignoredPaths`. The ancestor check covers directories (`node_modules/pkg/x.ts` when `node_modules/` is ignored): a directory's files are all in the snapshot, so walking up catches the directory exclusion. Directory NAMES may still appear in `list_directory` (not in the file-only snapshot) — accepted limitation, documented; their content stays unreachable.
5. **Secret scanner: format-anchored regex, not entropy** (decision 2026-08-05). `secretlint` (the mature option) requires Node 22+ — incompatible with the `node:20-alpine` runtime and `engines: >=20`. The 2026 zero-dep alternatives (`@sanity-labs/secret-scan`, `secret-sniff`) are months old with minimal maintenance track records. A small in-process module with anchored patterns for the formats this product actually handles (GitHub/OpenAI/Anthropic/DeepSeek/Voyage/AWS/Bearer/URL creds/PEM/KEY=value) gives the same coverage with zero dependency risk and full control over false positives.

### Risks

1. **Batch size limits** on `git ls-files`/`check-ignore --stdin` for very large repos → chunk the input (10k paths per batch), verified in the loadIgnoredPaths unit test with a fixture.
2. **Denylist over-blocking** (e.g. `*.key` matching an app's own `key.ts`) → pattern list targets suffixes and well-known names only; the false-positive cases are pinned in `secrets`/`exclusions` tests so a regression is caught.
3. **`git check-ignore` unavailable/fails in the clone** → `loadIgnoredPaths` never throws; returns `{}` with a warning; the matcher still excludes denylist/skip patterns (US-036 AC-4). Verified by a fixture without a git dir.
4. **Picomatch on untrusted globs** (CVE-2026-33672 advisory) → the shared matcher only ever feeds **repo-config patterns** (`.reviewer.yml`) into picomatch; the untrusted-model `pathGlob` case is hardened separately in KIT-044.

## Implementation Plan

1. - [ ] RED — `exclusions.test.ts`: fixture clone with (a) `.gitignore` ignoring `config.local.yaml`, (b) force-added `.env`, (c) a tracked-then-ignored `normal.txt`, (d) a nested `.gitignore` in `src/` → `loadIgnoredPaths` returns the ignored rel paths (b, c, d) and not the tracked clean file; `isExcludedPath` returns true for `.git/`, skip patterns, denylist defaults (`.env`, `x.pem`, `.npmrc`), and additive `sensitive_paths`; ancestor check excludes `node_modules/pkg/x.ts`. Run `pnpm --filter @kitten/shared test` → FAIL (module absent).
2. - [ ] GREEN — implement `exclusions.ts` (`SENSITIVE_DEFAULT_PATTERNS`, `loadIgnoredPaths` with `-z` batching + no-throw degradation, `buildExclusionMatcher`). PASS.
3. - [ ] RED — `secrets.test.ts`: each pattern family detected (ghp_, sk-proj-, sk-ant-, sk-…, al-…, AKIA…, Bearer, URL creds, PEM, KEY=value); `redactSecrets` masks spans with `***`; benign prose (`skills-hello`, `task-123`, a sentence containing "AWS key" with no token) NOT flagged; `SecretMatch.kind` never carries the value. FAIL.
4. - [ ] GREEN — implement `secrets.ts`. PASS.
5. - [ ] RED — `parse-config.test.ts`: `.reviewer.yml` with `sensitive_paths: ["**/terraform.tfstate"]` parses; invalid shape → VALIDATION. FAIL.
6. - [ ] GREEN — schema + defaults + parse changes. PASS.
7. - [ ] `pnpm test && pnpm lint` green; commit: `feat(shared): guardrail exclusion matcher and secret scanner`

## How to Test

- **Automated**: `pnpm --filter @kitten/shared test` — `guardrail/exclusions.test.ts` + `guardrail/secrets.test.ts` + config parse tests green; `pnpm test` all suites green.
- **Manual**: point `buildExclusionMatcher` at a scratch repo containing a force-added `.env` and a `.gitignore` with `config.local.yaml` → `isExcludedPath(".env") === true`, `isExcludedPath("config.local.yaml") === true`, `isExcludedPath("src/app.ts") === false`.
- **Negative**: a clone with no `.git` (check-ignore fails) → `loadIgnoredPaths` returns `{}`, the matcher still excludes `.env`/`*.pem` via denylist, review completes; `redactSecrets("skills-hello world")` is unchanged (no false positive).
- **Done means**: `pnpm test && pnpm lint` exit 0; `buildExclusionMatcher`/`detectSecrets`/`redactSecrets` exported from `@kitten/shared` with the exact interfaces KIT-043..048 consume.
