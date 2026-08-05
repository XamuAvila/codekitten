import type { MCPConfig, ReviewerConfig } from "@kitten/shared";

import { buildGuardrailSystem } from "../prompt/build-prompt.js";
import type { BuiltPrompt } from "../prompt/build-prompt.js";

/**
 * ChangedFileIndexEntry — one row of the changed-file index the agentic
 * prompt carries instead of full file contents (the model pulls contents on
 * demand via read_file).
 */
export interface ChangedFileIndexEntry {
  readonly path: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patchBytes: number;
}

/**
 * Builds the v4 agentic prompt: the v3 guardrail system plus the agentic
 * exploration block; user = conventions + rules + diff + changed-file index.
 * `maxTurns` defaults to the config value; force mode passes forceMaxTurns.
 */
export function buildAgenticPrompt(
  diff: string,
  changedFiles: readonly ChangedFileIndexEntry[],
  config: ReviewerConfig,
  conventionsContent: string | undefined,
  mcpConfig: MCPConfig,
  maxTurns?: number,
  knowledgeBlock?: string,
): BuiltPrompt {
  const turns = maxTurns ?? mcpConfig.maxTurns;
  const hasKnowledge = knowledgeBlock !== undefined && knowledgeBlock !== "";

  const system = [
    buildGuardrailSystem(config, hasKnowledge),
    "",
    "AGENTIC EXPLORATION:",
    "- Explore before reporting: use the tools to inspect the repo beyond the diff — read changed files in full, search for usages and patterns, find related code. Do not guess what is in the repo — look it up.",
    "- Tools are read-only. You can only read; never attempt to modify anything (no tool writes).",
    `- Budget: you have at most ${turns} tool rounds. Spend them on the questions that most affect finding quality.`,
    "- Finish by calling report_findings with your findings. All precision guardrails above still apply.",
  ].join("\n");

  const rulesBlock =
    config.rules.length > 0
      ? ["Reviewer rules:", ...config.rules.map((rule) => `- ${rule.id}: ${rule.description}`), ""].join("\n")
      : "";

  const index = changedFiles
    .map(
      (file) =>
        `- ${file.path}  (${file.status}, +${file.additions} -${file.deletions}, ${formatBytes(file.patchBytes)})`,
    )
    .join("\n");

  const user = [
    conventionsContent ? `Repository conventions:\n${conventionsContent}\n` : "",
    rulesBlock,
    hasKnowledge ? `${knowledgeBlock}\n` : "",
    "Pull request diff:",
    "```diff",
    diff,
    "```",
    "",
    "Changed files (index — read full contents with read_file):",
    index,
  ]
    .filter((part) => part.length > 0)
    .join("\n");

  return { system, user };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}
