import { AppError } from "../types/errors.js";
import type { ReviewerConfig } from "../types/index.js";
import type { LLMAdapter } from "./adapter.js";
import { AnthropicAdapter } from "./anthropic-adapter.js";
import { OpenAIAdapter } from "./openai-adapter.js";

/**
 * Exact-match map of known base_urls to the env var holding the API key
 * (US-012 AC-4). The key follows the URL, not the provider — DeepSeek is
 * `provider: anthropic` + a DeepSeek base_url, so it needs DEEPSEEK_API_KEY.
 */
const BASE_URL_TO_KEY_ENV: Readonly<Record<string, string>> = {
  "https://api.anthropic.com": "ANTHROPIC_API_KEY",
  "https://api.deepseek.com/anthropic": "DEEPSEEK_API_KEY",
  "https://api.openai.com": "OPENAI_API_KEY",
};

/**
 * Resolves which API-key env var serves a base_url. Unknown URLs fail fast
 * with VALIDATION — no key mapping exists, guessing would send the wrong key.
 */
export function resolveLlmKeyEnv(baseUrl: string): string {
  const keyEnv = BASE_URL_TO_KEY_ENV[baseUrl];
  if (!keyEnv) {
    throw new AppError(
      "VALIDATION",
      `No API key mapping for base_url: ${baseUrl}`,
      [{ baseUrl }],
    );
  }
  return keyEnv;
}

/**
 * Builds the LLM adapter for a repo config (US-012 AC-1/AC-2).
 * `provider` selects the SDK; `base_url` selects the key env.
 */
export function createLlmAdapter(config: ReviewerConfig): LLMAdapter {
  const baseUrl = config.baseUrl ?? providerDefaultBaseUrl(config.provider);
  const keyEnv = resolveLlmKeyEnv(baseUrl);
  const apiKey = process.env[keyEnv];

  if (!apiKey) {
    throw new AppError(
      "AUTH_FAILED",
      `Missing ${keyEnv} for base_url ${baseUrl}`,
      [{ baseUrl, keyEnv }],
    );
  }

  switch (config.provider) {
    case "anthropic":
      return new AnthropicAdapter({ apiKey, baseUrl, defaultModel: config.model });
    case "openai":
      return new OpenAIAdapter({ apiKey, baseUrl, defaultModel: config.model });
  }
}

function providerDefaultBaseUrl(provider: ReviewerConfig["provider"]): string {
  return provider === "anthropic"
    ? "https://api.anthropic.com"
    : "https://api.openai.com";
}
