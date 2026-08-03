---
id: US-007
title: "Authenticated Review Pipeline"
status: draft
epic: v2-github-integration
---

# US-007: Authenticated Review Pipeline

## Story

As a **developer**, I want the reviewer container to clone private repos with GitHub token authentication, generate real git diffs, and fetch PR changed files from the GitHub API so that the review pipeline works with real GitHub data instead of mocked input.

## Acceptance Criteria

### AC-1: Clone with authentication

```
Given the reviewer container has GITHUB_TOKEN set
When the pipeline clones a repo
Then the clone URL includes authentication (https://x-access-token:{token}@github.com/{repo}.git)
And the token is never logged
And the clone uses --depth=1 --branch={headRef}
```

### AC-2: Real diff generation

```
Given a cloned repo with headRef and baseRef
When the pipeline generates a diff
Then the output matches `git diff {baseRef}...{headRef}`
And the diff includes file paths, additions, and deletions
```

### AC-3: PR files from GitHub API

```
Given REVIEW_REPO="XamuAvila/kitten-test-repo" and REVIEW_PR_NUMBER=1
When the pipeline fetches PR files
Then it returns the list of changed files with status (added/modified/removed/renamed)
And each file includes patch, additions, deletions counts
```

### AC-4: Skip patterns applied

```
Given a .reviewer.yml with skip patterns ["**/*.snap", "**/dist/**"]
When the pipeline filters PR files
Then files matching skip patterns are excluded
And the log shows how many files were skipped
```

### AC-5: Dry-run with real data

```
Given the pipeline has cloned, diffed, and fetched PR files
When the dry-run analyzer runs
Then it logs token estimate based on real file content
And it logs the model from .reviewer.yml (or defaults)
And status is reported to Redis as "running"
```

## Notes

- Clone URL format: `https://x-access-token:${GITHUB_TOKEN}@github.com/${repo}.git`
- Token MUST be stripped from any error messages before logging
- Reuse `git/clone.ts` and `analyzer/dry-run.ts` logic from `packages/worker/`, adapted for auth
- GitHub API files endpoint: `GET /repos/{owner}/{repo}/pulls/{pr}/files`
- `@octokit/rest` for GitHub API calls
