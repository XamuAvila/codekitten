---
id: US-026
title: "Agentic Cost Control"
status: draft
epic: v4-mcp-agentic-review
---

# US-026: Agentic Cost Control

## Story

As a **repo maintainer**, I want to control the cost of agentic reviews (per-tool caps, tool whitelist, force escalation), so that agentic exploration stays within a predictable budget.

## Acceptance Criteria

### AC-1: per-tool caps and the tools whitelist are enforced

```
Given .reviewer-mcp.json sets read.maxLines: 100 and tools: ["read_file", "search"]
When the agentic loop runs
Then read_file returns at most 100 lines per call
And find_related and list_directory are never offered to the model
```

### AC-2: budget-exceeded review posts the force invitation

```
Given an agentic review that exhausts maxTurns
When the review completes
Then the findings are posted
And a budget-exceeded comment states the tool-call count and replies "force" for a deeper pass
```

### AC-3: force re-runs with the raised turn cap

```
Given a "force" command on an agentic review that hit its budget
When the pipeline re-runs
Then the loop uses forceMaxTurns (default 60) instead of maxTurns
And the deeper findings are posted
```

### AC-4: tool-call count is observable

```
Given an agentic review runs
When the pipeline completes
Then the tool-call count appears in the pipeline logs and PipelineResult metadata
```

### AC-5: disabled tools are never presented

```
Given .reviewer-mcp.json sets tools: ["read_file"]
When the agentic loop builds each turn
Then the tools array contains only read_file (plus report_findings), never search/find_related/list_directory
```

## Notes

- Cost control is the product-facing side of decision D4 (turn cap + per-result caps). The enforcement itself ships with KIT-023; this story adds the configuration surface, force escalation, and observability.
- `force` reuses `PipelineOptions.ignoreBudget` from v3 — the agentic loop reads `forceMaxTurns` when it is set.
