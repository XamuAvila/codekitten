# Contributing to Kitten

Thanks for considering a contribution. This repository runs a stricter-than-usual
process: test-first development, one tracked unit of work per change, and documentation
that is never allowed to drift from the code. The rules below are not style
preferences — they exist because this is an agent that reads private source code and
posts to other people's repositories.

[`AGENTS.md`](AGENTS.md) is the authoritative in-repo guide. This document is the
contributor-facing summary of it.

---

## Table of contents

- [Language](#language)
- [Getting set up](#getting-set-up)
- [The workflow](#the-workflow)
- [Test-driven development](#test-driven-development)
- [Code standards](#code-standards)
- [Invariants you must not break](#invariants-you-must-not-break)
- [Documentation fidelity](#documentation-fidelity)
- [Commits](#commits)
- [Pull requests](#pull-requests)
- [Repository map](#repository-map)
- [Reporting bugs and requesting features](#reporting-bugs-and-requesting-features)

---

## Language

**Everything in this repository is written in English** — code, comments, docs, specs,
user stories, kanban cards, commit messages, tool descriptions, error messages. No
exceptions. Discussion in issues and pull requests may happen in whatever language
suits the participants, but nothing committed to the tree is in anything but English.

---

## Getting set up

```bash
git clone https://github.com/XamuAvila/codekitten.git
cd codekitten
pnpm install
pnpm build
pnpm test
```

| Command | What it does |
|---|---|
| `pnpm build` | `tsc -b` across all packages, using project references. |
| `pnpm test` | Vitest, all three packages. |
| `pnpm test:coverage` | v8 coverage over `packages/*/src`. |
| `pnpm lint` | ESLint (flat config, `typescript-eslint`, Prettier-compatible). |
| `pnpm clean` | Removes `dist/`, `*.tsbuildinfo` and `coverage/`. |

Running a real review locally requires a cluster — see [docs/deployment.md](docs/deployment.md).

**TypeScript settings that will bite you if you are not expecting them:** `strict`,
`noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
`verbatimModuleSyntax`, `module: NodeNext`. Relative imports need the `.js` extension
even in `.ts` sources, and type-only imports must be written `import type`.

---

## The workflow

Every change follows the same path:

```
brainstorm → epic (spec + plan) → user stories → kanban cards
          → refinement per card → TDD → done
```

**Epics — `.devtool/epics/<slug>.md`.** An epic file *is* the spec: architecture,
stack, types, project structure, scope and out-of-scope. There is no separate specs
folder and no separate plan document. Read the latest active epic before proposing an
architectural change. A change that does not warrant an epic does not get one — it
attaches to the epic it belongs to.

**User stories — `docs/stories/US-NNN-<slug>.md`.** Connextra format
(*As a [role], I want [function] so that [value]*), satisfying INVEST, with
Given/When/Then acceptance criteria. One file per story. Never split a story by
technical layer — every story is a full slice of value.

`docs/stories/INDEX.md` is the index: one line per story. **Read only the index by
default**; open a story file when you are working on it. Creating a story or changing
its status updates the index in the same edit.

**Kanban cards — `.devtool/features/<id>.md`.** One card per implementation task, with
YAML frontmatter (`id`, `status`, `priority`, `epic`, `labels`, `order`, dates). Before
any code is written, the card body must contain:

1. `## User Story` — a link to the `US-NNN` it implements.
2. `## Technical Refinement` — affected files and modules, design decisions, risks,
   dependencies.
3. `## Implementation Plan` — ordered steps, each with the test that proves it.
4. `## How to Test` — the exact commands, the expected result, at least one negative
   check, and a binary "Done means" line.

A card without refinement and plan is not ready to implement.

**The board is the progress tracker.** Move a card to `in-progress` before writing
code, and to `done` (with `completedAt`) when tests are green and the work is verified.
Discovering new work mid-task means creating a Backlog card immediately, not keeping it
in your head. Ending a session with the board out of sync with reality is a process
violation.

---

## Test-driven development

**Mandatory.** Not aspirational.

1. Write the test first. Run it. **Watch it fail.**
2. Write the minimum implementation that makes it pass.
3. Run it. Watch it pass.
4. Refactor.
5. Keep coverage at 80%+.

A test that never failed proves nothing. When fixing a bug, the failing test that
reproduces it comes first.

**Structure:** Arrange → Act → Assert. **Names describe behavior**, not implementation:

```ts
it("returns 404 when the job is in a terminal state", async () => { … });
it("strips a ruleId the repository never declared", () => { … });
```

Tests live in `packages/*/tests/`, mirroring the `src/` layout. Every external boundary
— GitHub, Redis, Kubernetes, the LLM, MongoDB — has an injection seam so tests never
touch the network. Follow the existing pattern in the package you are changing.

---

## Code standards

**Immutability.** Always produce new objects; never mutate in place. Prefer `readonly`
on interface fields and `readonly T[]` on array fields.

**Structured errors.** Every failure is an `AppError { code, message, details? }`.
Never throw a bare string, and never construct an error message by interpolating a
value that belongs in `details`.

**Validate every trust boundary.** Anything crossing one — LLM output, GitHub webhook
payloads, config files, tool arguments, Redis messages — is parsed with a Zod schema
before it is used. Config schemas are `strictObject`: an unknown key is a `VALIDATION`
error, never silently stripped.

**Size limits.** Files 200–400 lines typically, 800 maximum. Functions under 50 lines.
Nesting no deeper than four levels — prefer early returns.

**No weak types.** No `any`. `unknown` for untrusted input, narrowed explicitly.
Interfaces for object shapes, `type` for unions and intersections. String literal
unions over `enum`.

**Comments explain *why*.** The what is in the code. Document invariants, contracts
with external systems, performance constraints, workarounds for known upstream bugs,
and coupling that is not visible from the imports. Several comments in this codebase
exist specifically to stop a future reader from "simplifying" a deliberate decision —
match that standard.

**Secrets never reach a log.** Tokens, API keys and webhook secrets are never logged.
Error paths that could carry a token sanitize it first. Tool results are never logged
at all, because repository file contents may contain secrets.

---

## Invariants you must not break

Violating one of these is a bug, not a trade-off:

1. **The reviewer never mutates the cloned repository.** Read-only access to the clone
   directory. There is no write tool in the agent's tool layer, and adding one would be
   a design change requiring an epic.
2. **Clone directories are always cleaned up** — including on error and on crash.
   Cleanup lives in a `finally` block; keep it there.
3. **Structured errors everywhere.**
4. **No secrets in logs.**
5. **Job isolation.** Each review is independent. The only state permitted to cross a
   job boundary is the Semble index PVC (derived, rebuildable) and the Atlas
   `knowledge` collection (curated). Adding a third store requires an epic amendment.

---

## Documentation fidelity

In this repository, a wrong document is treated as **more severe than a critical bug**.
A critical bug fails one review; a wrong document misleads every future change built on
top of it.

- **Same-commit rule.** Any change that invalidates a documented statement — a file
  path, a behavior, a default, an error code, a flow — updates that document in the
  same commit. Never "later".
- **Card fidelity.** If the implementation legitimately diverges from a card's plan
  because you found a better design mid-TDD, edit the card to record what was actually
  built and why, before moving it to done.
- **Found a divergence you cannot fix now?** Create a card for it with a `docs` label
  and say so out loud. Never leave it undocumented.

Documents that must stay in lockstep: the epic files, the cards, `docs/stories/INDEX.md`,
`AGENTS.md`, `README.md`, and everything under `docs/`.

---

## Commits

```
<type>: <description>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

An optional scope is used where it clarifies which service changed:

```
feat(dispatcher): route @reviewer PR comments to force/stop/follow-up
fix(reviewer): check out the PR head branch on clone
docs: v7 deep-context epic, stories US-031..034, cards KIT-035..040
```

Write the subject in the imperative mood, and keep it under about 72 characters.
Commits describe *what changed and why*, not which files were touched.

---

## Pull requests

Before opening one:

- [ ] `pnpm build` succeeds
- [ ] `pnpm test` passes — paste the output in the PR description
- [ ] `pnpm lint` is clean
- [ ] New behavior has tests that failed before the implementation existed
- [ ] The kanban card reflects what was actually built
- [ ] Every document invalidated by the change is updated in the same PR
- [ ] No secret, token or key appears in the diff — including in test fixtures
- [ ] The branch is up to date with `master`

In the description, state: what changed, what deliberately did **not** change, what was
verified versus assumed, and any known risk or follow-up. For anything non-trivial,
that is several sentences, not one line.

Security-sensitive changes — authentication, webhook handling, the tool layer, path
confinement, secret handling, anything touching the clone — say so explicitly in the
description so they get reviewed on that axis.

---

## Repository map

```
packages/shared/         Types (Zod), config parsers, LLM adapters, knowledge client
packages/dispatcher/     Express API, GitHub webhook, K8s Pod creation
packages/reviewer/       The agent: pipeline, agentic loop, tools, GitHub posting

docker/semble-sidecar/   Python HTTP shim over Semble's stdio MCP server
k8s/                     Namespace, RBAC, Redis, dispatcher, PVC, Secret templates
scripts/                 minikube setup, E2E suites, Pod cleanup, Atlas bootstrap

docs/                    This documentation set
docs/stories/            User stories + INDEX
.devtool/epics/          Epic specs — architecture decisions live here
.devtool/features/       Kanban cards (`done/` holds finished ones)
templates/               Card template
```

Where to make a change:

| Change | Where |
|---|---|
| A new shared type or Zod schema | `packages/shared/src/types/` |
| A new `.reviewer.yml` key | `types/reviewer-config.ts` + `config/parse-config.ts` + `config/defaults.ts` + [docs/configuration.md](docs/configuration.md) |
| A new LLM provider | Implement `LLMAdapter`, register in `llm/factory.ts`, add the base-URL → key mapping |
| A new HTTP endpoint | `packages/dispatcher/src/routes/` + [docs/api.md](docs/api.md) |
| A new webhook event | `packages/dispatcher/src/webhook/events.ts` |
| A new agentic tool | `packages/reviewer/src/mcp/`, register in `registry.ts`, extend `McpToolNameSchema` and `MCPConfig`, document in [docs/agentic-review.md](docs/agentic-review.md) |
| Anything about the Pod spec | `packages/dispatcher/src/k8s/manifest.ts` |

---

## Reporting bugs and requesting features

**Bugs.** Open an issue with: what you expected, what happened, the reviewer Pod logs
(`kubectl logs <job-id> -n kitten -c reviewer`), the relevant `.reviewer.yml` /
`.reviewer-mcp.json`, and the Kitten version. **Redact tokens and API keys** — the
reviewer sanitizes its own logs, but paste carefully anyway.

**Security vulnerabilities do not go in issues.** See [SECURITY.md](SECURITY.md).

**Features.** Open an issue describing the problem before the solution. Substantial
proposals become an epic, so the discussion is worth having before any code exists.
