# kitten

AI Code Review Agent (White Label Reviewer). An ephemeral worker per PR with an isolated clone — reviews PRs using full repo context + diff + team conventions. White-label, vendor-agnostic, self-hosted.

## Project structure

```
packages/
  shared/       # @kitten/shared — types (Zod schemas), .reviewer.yml parser, LLMAdapter interface
  dispatcher/   # @kitten/dispatcher — Express API, enqueues review jobs in BullMQ (Redis)
  worker/       # @kitten/worker — BullMQ consumer, clones repo, runs the review
```

## Requirements

- Node.js 20+
- pnpm 11+
- Redis 7 (for dispatcher/worker; see `.env.example`)

## Setup

```bash
pnpm install
pnpm build    # compiles all packages (tsc -b, project references)
pnpm test     # vitest, all packages
pnpm lint     # eslint, all packages
pnpm clean    # removes dist/ and tsbuildinfo
```

Run the placeholder entry points:

```bash
node packages/dispatcher/dist/index.js   # [dispatcher] starting...
node packages/worker/dist/index.js       # [worker] starting...
```

## Configuration

- `.env.example` — environment variables (Redis URL, API keys).
- `.reviewer.yml.example` — sample reviewer config; the reviewed repo provides its own `.reviewer.yml`. Missing file → defaults; invalid file → structured `AppError` (`VALIDATION`).

## Process

This repo is managed via kanban cards (`.devtool/features/`) and epics (`.devtool/epics/`). See `AGENTS.md` for the working process, invariants, and conventions.
