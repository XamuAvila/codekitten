import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@kitten/shared";
import type { ReviewFile } from "@kitten/shared";
import { buildReviewPrompt } from "../../src/prompt/build-prompt.js";

const FILES: readonly ReviewFile[] = [
  { path: "src/utils.ts", content: "export function add(a: number, b: number) { return a + b; }" },
];

const DIFF = "diff --git a/src/utils.ts b/src/utils.ts\n@@ -1,1 +1,1 @@\n+export function add(a: number, b: number) { return a + b; }";

describe("buildReviewPrompt", () => {
  it("system prompt enforces review-only scope (never commit, never push)", () => {
    const { system } = buildReviewPrompt(DIFF, FILES, DEFAULT_CONFIG);

    expect(system).toMatch(/never commit/i);
    expect(system).toMatch(/never push/i);
    expect(system).toMatch(/review only|read-only/i);
  });

  it("system prompt requires exact file:line references", () => {
    const { system } = buildReviewPrompt(DIFF, FILES, DEFAULT_CONFIG);

    expect(system).toMatch(/file:line/);
  });

  it("system prompt forbids style/whitespace comments and praise", () => {
    const { system } = buildReviewPrompt(DIFF, FILES, DEFAULT_CONFIG);

    expect(system).toMatch(/style|formatting|whitespace/i);
    expect(system).toMatch(/do not praise|no praise/i);
  });

  it("system prompt embeds max_findings and max_complexity from config", () => {
    const config = { ...DEFAULT_CONFIG, maxFindings: 5, maxComplexity: 12 };
    const { system } = buildReviewPrompt(DIFF, FILES, config);

    expect(system).toContain("5");
    expect(system).toMatch(/at most 5 findings|maximum of 5/i);
    expect(system).toMatch(/12/);
  });

  it("system prompt demands structured output only (no preamble)", () => {
    const { system } = buildReviewPrompt(DIFF, FILES, DEFAULT_CONFIG);

    expect(system).toMatch(/tool call|structured output|JSON schema/i);
    expect(system).toMatch(/no preamble|no other text|only/i);
  });

  it("system prompt says to report only when sure (no speculation)", () => {
    const { system } = buildReviewPrompt(DIFF, FILES, DEFAULT_CONFIG);

    expect(system).toMatch(/unsure|not sure/i);
  });

  it("user prompt includes diff, file contents and conventions", () => {
    const { user } = buildReviewPrompt(DIFF, FILES, DEFAULT_CONFIG);

    expect(user).toContain(DIFF);
    expect(user).toContain("export function add(a: number, b: number) { return a + b; }");
  });

  it("user prompt includes conventions content when provided", () => {
    const conventions = "Team convention: no semicolons.";
    const { user } = buildReviewPrompt(DIFF, FILES, DEFAULT_CONFIG, conventions);

    expect(user).toContain(conventions);
  });
});
