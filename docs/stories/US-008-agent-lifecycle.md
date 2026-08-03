---
id: US-008
title: "Agent Lifecycle Management"
status: draft
epic: v2-github-integration
---

# US-008: Agent Lifecycle Management

## Story

As a **developer**, I want the reviewer pod to subscribe to a Redis pub/sub channel after the initial review, handle follow-up messages from the dispatcher, and shut down gracefully after an idle timeout so that reviews support interactive conversations and pods don't linger forever.

## Acceptance Criteria

### AC-1: Subscribe after review

```
Given the initial review pipeline has completed
When the agent enters "reviewing" state
Then it subscribes to Redis channel "review:{jobId}:messages"
And status in Redis changes to "reviewing"
And the idle timer starts (10 min default)
```

### AC-2: Follow-up message handled

```
Given the agent is subscribed and idle
When a follow_up message is published to the channel
Then the agent receives and parses the message
And the idle timer is reset to 10 minutes
And followUpCount in Redis increments by 1
```

### AC-3: Idle timeout triggers shutdown

```
Given the agent is in "reviewing" state
When 10 minutes pass with no messages
Then the agent reports status "completed" to Redis
And the agent unsubscribes from the channel
And the process exits with code 0
```

### AC-4: Shutdown message triggers immediate exit

```
Given the agent is in "reviewing" state
When a shutdown message is published to the channel
Then the agent reports status "completed" to Redis
And the process exits immediately (no idle wait)
```

### AC-5: Status transitions correct

```
Given a review lifecycle from start to finish
When I query Redis at each stage
Then status transitions are: queued → running → reviewing → completed
And "failed" is set only on unrecoverable errors during pipeline
```

## Notes

- Redis pub/sub requires a dedicated connection (subscriber can't do other commands)
- Idle timeout configurable via `POD_IDLE_TIMEOUT_MS` env (default 600000)
- Use `ioredis` for pub/sub (supports subscriber mode)
- Agent must handle SIGTERM gracefully (K8s sends SIGTERM before SIGKILL)
