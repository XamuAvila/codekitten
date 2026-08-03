---
id: US-009
title: "PR Comment Posting"
status: draft
epic: v2-github-integration
---

# US-009: PR Comment Posting

## Story

As a **developer**, I want the reviewer to post placeholder comments on GitHub PRs for both initial review results and follow-up acknowledgments so that review output is visible directly on the pull request.

## Acceptance Criteria

### AC-1: Initial review comment posted

```
Given the review pipeline has completed
When the reviewer posts the initial comment
Then a comment appears on PR #{prNumber} in the repo
And the comment body includes: repo name, PR number, files analyzed count, dry-run note
And the comment is prefixed with a kitten identifier (e.g., "🐱 **Kitten Review**")
```

### AC-2: Follow-up ack comment posted

```
Given the agent receives a follow-up message
When the agent processes it (v2: ack only)
Then a reply comment is posted on the PR
And the comment acknowledges the follow-up: "Received: '{message}'. LLM processing available in v3."
```

### AC-3: Test comments identifiable

```
Given the reviewer is running against the test fixture repo
When comments are posted
Then test comments include "[KITTEN-TEST]" prefix
And they can be distinguished from real review comments
```

### AC-4: GitHub API errors handled gracefully

```
Given the GitHub API returns an error (403, 404, 422, rate limit)
When the reviewer tries to post a comment
Then the error is logged with structured format { code, message, details }
And the review pipeline does not crash — comment failure is non-fatal
```

## Notes

- Octokit REST: `POST /repos/{owner}/{repo}/issues/{pr}/comments`
- PR comments use the Issues API (PRs are issues in GitHub)
- Comment failure should not fail the entire review — log and continue
- Test fixture: `XamuAvila/kitten-test-repo` PR #1
