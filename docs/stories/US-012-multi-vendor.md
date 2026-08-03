---
id: US-012
title: "Multi-Vendor Provider Configuration"
status: draft
epic: v3-llm-integration
---

# US-012: Multi-Vendor Provider Configuration

## Story

As a **repo owner**, I want to choose which LLM provider reviews my PRs (Anthropic, OpenAI, or DeepSeek via the Anthropic-compatible endpoint) from `.reviewer.yml`, so that I can control cost and model quality per repository.

## Acceptance Criteria

### AC-1: Provider selection via config

```
Given .reviewer.yml sets provider: "openai"
When a review runs
Then the OpenAIAdapter is used (OpenAI SDK)
```

### AC-2: DeepSeek via Anthropic-compatible base_url

```
Given .reviewer.yml sets provider: "anthropic" and base_url: "https://api.deepseek.com/anthropic"
When a review runs
Then the AnthropicAdapter is used
And requests go to the DeepSeek base_url
And the DEEPSEEK_API_KEY is injected (key resolved by base_url)
```

### AC-3: Default base_url per provider

```
Given .reviewer.yml sets provider: "openai" without base_url
When the adapter is built
Then the official OpenAI base_url is used
And the OPENAI_API_KEY is injected
```

### AC-4: Key resolution by base_url (exact match)

```
Given base_url is one of the known URLs (api.anthropic.com, api.deepseek.com/anthropic, api.openai.com)
When the adapter is built
Then the corresponding key env (ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY) is selected
```

### AC-5: Unknown base_url fails validation

```
Given .reviewer.yml sets base_url: "https://some-gateway.example.com"
When the review starts
Then the review fails with { code: "VALIDATION" } explaining no key mapping exists for that URL
And no LLM call is made
```

### AC-6: One Secret, three keys

```
Given the k8s Secret "kitten-llm-keys" exists
Then it contains ANTHROPIC_API_KEY, OPENAI_API_KEY, and DEEPSEEK_API_KEY
And reviewer Pod manifests reference it via secretKeyRef
```

## Notes

- DeepSeek compatibility verified against official docs (`api-docs.deepseek.com`): OpenAI/Anthropic-compatible, base_url `https://api.deepseek.com/anthropic`
- Adapter factory: `provider` selects SDK, `base_url` selects key env
- No special "deepseek" provider value — DeepSeek is `provider: anthropic` + DeepSeek base_url
