---
id: US-001
title: Project Bootstrap and Build
status: draft
epic: v1-scaffolding-dry-run
---

# US-001: Project Bootstrap and Build

## Story

As a **developer**, I want to clone the kitten repo, install dependencies, and build all packages so that I have a working TypeScript monorepo ready for development.

## Acceptance Criteria

### AC-1: Clean install succeeds

```
Given a fresh clone of the kitten repo
When I run `pnpm install`
Then all dependencies for shared, dispatcher, and worker packages are installed without errors
```

### AC-2: All packages build

```
Given dependencies are installed
When I run `pnpm build`
Then shared, dispatcher, and worker compile to JavaScript without type errors
```

### AC-3: Shared types are consumable

```
Given the shared package is built
When dispatcher or worker imports from `@kitten/shared`
Then TypeScript resolves the types correctly and the build succeeds
```

### AC-4: Lint and format pass

```
Given the codebase has source files
When I run `pnpm lint`
Then no lint errors are reported on the initial codebase
```

## Notes

- pnpm workspaces with `@kitten/shared`, `@kitten/dispatcher`, `@kitten/worker` package names.
- `tsconfig.base.json` at root with project references.
- Each package has its own `tsconfig.json` extending base.
- ESLint + Prettier configured at root level.
- `.gitignore` covers node_modules, dist, .env, clone dirs.
