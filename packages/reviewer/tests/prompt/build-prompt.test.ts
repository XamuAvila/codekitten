import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@kitten/shared";
import type { ReviewFile, ReviewRule } from "@kitten/shared";
import { buildReviewPrompt } from "../../src/prompt/build-prompt.js";

const FILES: readonly ReviewFile[] = [
  { path: "src/utils.ts", content: "export function add(a: number, b: number) { return a + b; }" },
];

const RULES: readonly ReviewRule[] = [
  { id: "no-raw-sql", description: "Use the query builder, never raw SQL strings." },
  { id: "no-console-log", description: "Production code must not call console.log." },
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

  it("user prompt lists declared rules above the diff", () => {
    const config = { ...DEFAULT_CONFIG, rules: RULES };
    const { user } = buildReviewPrompt(DIFF, FILES, config);

    expect(user).toContain("Reviewer rules:");
    expect(user).toContain("- no-raw-sql: Use the query builder, never raw SQL strings.");
    expect(user).toContain("- no-console-log: Production code must not call console.log.");
    expect(user.indexOf("Reviewer rules:")).toBeLessThan(user.indexOf("Pull request diff:"));
  });

  it("user prompt omits the rules block when no rules are declared", () => {
    const { user } = buildReviewPrompt(DIFF, FILES, DEFAULT_CONFIG);

    expect(user).not.toContain("Reviewer rules:");
  });

  it("rules block renders one line per rule and no file contents", () => {
    const config = { ...DEFAULT_CONFIG, rules: RULES };
    const { user } = buildReviewPrompt(DIFF, FILES, config);

    const block = user.slice(
      user.indexOf("Reviewer rules:"),
      user.indexOf("Pull request diff:"),
    );
    const lines = block.split("\n").filter((line) => line.trim().length > 0);

    expect(lines).toHaveLength(RULES.length + 1);
    expect(block).not.toContain(FILES[0]!.content);
  });

  it("system prompt asks for rule attribution when rules are declared", () => {
    const config = { ...DEFAULT_CONFIG, rules: RULES };
    const { system } = buildReviewPrompt(DIFF, FILES, config);

    expect(system).toContain("ruleId");
  });

  it("system prompt does not mention rule attribution when no rules are declared", () => {
    const { system } = buildReviewPrompt(DIFF, FILES, DEFAULT_CONFIG);

    expect(system).not.toContain("ruleId");
  });

  it("system prompt names the configured output language", () => {
    const config = { ...DEFAULT_CONFIG, language: "pt" };
    const { system } = buildReviewPrompt(DIFF, FILES, config);

    expect(system).toContain("LANGUAGE:");
    expect(system).toContain('"pt"');
  });

  it("system prompt names the default language when none is configured", () => {
    const { system } = buildReviewPrompt(DIFF, FILES, DEFAULT_CONFIG);

    expect(system).toContain("LANGUAGE:");
    expect(system).toContain(`"${DEFAULT_CONFIG.language}"`);
  });

  it("language block exempts machine-readable fields from translation", () => {
    const config = { ...DEFAULT_CONFIG, language: "pt" };
    const { system } = buildReviewPrompt(DIFF, FILES, config);

    const block = system.slice(
      system.indexOf("LANGUAGE:"),
      system.indexOf("OUTPUT CONTRACT:"),
    );

    expect(block).toContain("severity");
    expect(block).toContain("file");
    expect(block).toContain("line");
  });
});
