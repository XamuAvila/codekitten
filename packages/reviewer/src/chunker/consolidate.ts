import type { Finding, ReviewResult } from "@kitten/shared";

/**
 * Consolidates findings from multiple chunk reviews (KIT-014, US-014 AC-3).
 *
 * Dedup key: file:line — a file appears in exactly one chunk, so
 * cross-chunk duplicates come from the LLM re-reporting. On conflict the
 * highest severity wins; first occurrence order is preserved.
 *
 * `validRuleIds` (KIT-018, US-018 AC-5) is the set of rule ids declared in
 * `.reviewer.yml`. A finding attributed to an id outside that set loses only
 * the attribution — the finding itself may still be real, so discarding it
 * would throw away signal. Omit the argument to skip the check entirely.
 *
 * This runs on every review path, chunked or not (pipeline.ts calls it for
 * single-call reviews too), which is why the check lives here rather than in
 * an adapter.
 */
export function consolidateFindings(
  results: readonly ReviewResult[],
  validRuleIds?: ReadonlySet<string>,
): readonly Finding[] {
  const byKey = new Map<string, Finding>();
  const order: string[] = [];

  for (const result of results) {
    for (const reported of result.findings) {
      const finding = stripUnknownRuleId(reported, validRuleIds);
      const key = `${finding.file}:${finding.line}`;
      const existing = byKey.get(key);

      if (!existing) {
        byKey.set(key, finding);
        order.push(key);
      } else if (severityRank(finding.severity) > severityRank(existing.severity)) {
        byKey.set(key, finding);
      }
    }
  }

  return order.map((key) => byKey.get(key)!);
}

/**
 * Returns the finding unchanged, or a copy without `ruleId` when the model
 * attributed it to a rule the repo never declared. Never mutates the input.
 */
function stripUnknownRuleId(
  finding: Finding,
  validRuleIds?: ReadonlySet<string>,
): Finding {
  if (
    validRuleIds === undefined ||
    finding.ruleId === undefined ||
    validRuleIds.has(finding.ruleId)
  ) {
    return finding;
  }

  console.warn(
    `[reviewer] Dropping unknown rule attribution "${finding.ruleId}" on ${finding.file}:${finding.line}`,
  );

  const { ruleId, ...withoutRuleId } = finding;
  void ruleId;
  return withoutRuleId;
}

function severityRank(severity: Finding["severity"]): number {
  switch (severity) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
  }
}
