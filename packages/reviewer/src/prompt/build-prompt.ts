import type { ReviewerConfig } from "@kitten/shared";
import type { ReviewFile } from "@kitten/shared";

/**
 * Builds the monolithic guardrailed review prompt (v3, US-011).
 *
 * The system prompt carries hard, non-negotiable guardrails — review-only
 * scope (never commit/push), precision (exact file:line), no noise (no
 * style/praise), uncertainty discipline, and the numeric limits from config.
 * The user prompt carries the diff, the full changed files, and (when present)
 * the repo conventions file.
 *
 * KIT-017 reuses the returned prompt as context for follow-up answers, so the
 * shape `{ system, user }` is a contract — do not rename fields.
 */
export interface BuiltPrompt {
  readonly system: string;
  readonly user: string;
}

/**
 * The v3 guardrail system prompt, exported standalone so the v4 agentic
 * prompt (agentic/build-agentic-prompt.ts) reuses the exact same guardrails
 * and only appends its exploration block.
 */
export function buildGuardrailSystem(config: ReviewerConfig, hasKnowledge = false): string {
  return [
    "You are an expert code reviewer. Your ONLY job is to review the provided pull request and report findings.",
    "",
    "SCOPE — NON-NEGOTIABLE:",
    "- You are reviewing code. You NEVER commit, NEVER push, NEVER modify or write files.",
    "- You have read-only access and no write intent. The review is purely advisory.",
    "",
    "FINDINGS QUALITY:",
    "- Report ONLY real bugs, security issues, or maintainability problems that would cost a developer time.",
    "- Do NOT comment on style, formatting, whitespace, or naming preferences.",
    "- Do NOT praise or compliment the code.",
    "- If you are unsure whether something is a real issue, do NOT report it.",
    "- Flag functions whose cyclomatic complexity exceeds the threshold when that complexity harms maintainability.",
    `- Report at most ${config.maxFindings} findings, prioritizing by severity. Valuable over numerous.`,
    `- Cyclomatic complexity threshold: ${config.maxComplexity}.`,
    "",
    "PRECISION:",
    "- Every finding MUST reference the exact file and line in the diff (`file:line`).",
    "- No vague findings without a concrete location.",
    "",
    // Emitted only when the repo declares rules (KIT-018). Without rules the
    // model has no valid id to cite, and asking for `ruleId` anyway invites
    // invented ones that consolidateFindings would just strip again.
    ...(config.rules.length > 0
      ? [
          "REPOSITORY RULES:",
          "- The user content declares repository-specific rules. Treat them as review criteria ADDITIONAL to everything above — they never relax the guardrails.",
          "- When a finding exists because a declared rule was broken, set its `ruleId` to that rule's id. Otherwise omit `ruleId`.",
          "",
        ]
      : []),
    // KIT-019. Worded as "prose you author" rather than "findings" on purpose:
    // agent.ts reuses this same system prompt for free-text follow-up answers,
    // which are not findings. Naming the machine-readable fields is not
    // decoration — a model told to write Portuguese will happily return
    // severity "alto", which fails FindingSchema and costs a retry.
    // Knowledge calibrates but never relaxes precision (KIT-039): stored
    // team facts drop known-intentional findings, they don't invite new ones.
    ...(hasKnowledge
      ? [
          "REPOSITORY KNOWLEDGE:",
          "- The user content carries a \"Repository knowledge\" block: facts the team taught the reviewer and human corrections on past findings.",
          "- Use it to CALIBRATE: do not report findings the knowledge marks as intentional, and respect stated team conventions.",
          "- Knowledge entries never relax the precision guardrails above — they only remove noise, never lower the bar.",
          "",
        ]
      : []),
    "LANGUAGE:",
    `- Write every piece of prose you author — finding descriptions, suggestions, and any free-text answer — in "${config.language}".`,
    // `ruleId` is deliberately absent from this list: it only exists when the
    // repo declares rules, and the REPOSITORY RULES block above already governs
    // it. Naming it here would put "ruleId" in every prompt, including repos
    // with no rules — exactly what that block is conditional to avoid.
    "- Do NOT translate machine-readable values: `severity` stays exactly one of critical/high/medium/low, and `file` and `line` are copied verbatim.",
    "",
    "OUTPUT CONTRACT:",
    "- Respond ONLY with the structured output (tool call / JSON schema).",
    "- No preamble, no explanations outside the structured output.",
  ].join("\n");
}

export function buildReviewPrompt(
  diff: string,
  files: readonly ReviewFile[],
  config: ReviewerConfig,
  conventionsContent?: string,
  knowledgeBlock?: string,
): BuiltPrompt {
  const hasKnowledge = knowledgeBlock !== undefined && knowledgeBlock !== "";
  const system = buildGuardrailSystem(config, hasKnowledge);

  const filesBlock = files
    .map((file) => `### ${file.path}\n\`\`\`\n${file.content}\n\`\`\``)
    .join("\n\n");

  // Repo-declared rules (KIT-018). Placed above the files block on purpose:
  // pipeline.ts rewrites the per-chunk user prompt by replacing the rendered
  // files block verbatim, so anything inserted above that anchor survives.
  const rulesBlock =
    config.rules.length > 0
      ? [
          "Reviewer rules:",
          ...config.rules.map((rule) => `- ${rule.id}: ${rule.description}`),
          "",
        ].join("\n")
      : "";

  const user = [
    conventionsContent ? `Repository conventions:\n${conventionsContent}\n` : "",
    rulesBlock,
    hasKnowledge ? `${knowledgeBlock}\n` : "",
    "Pull request diff:",
    "```diff",
    diff,
    "```",
    "",
    "Changed files (full content):",
    filesBlock,
  ]
    .filter((part) => part.length > 0)
    .join("\n");

  return { system, user };
}
