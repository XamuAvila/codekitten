import type { Finding, ReviewResult } from "@kitten/shared";

/**
 * Consolidates findings from multiple chunk reviews (KIT-014, US-014 AC-3).
 *
 * Dedup key: file:line — a file appears in exactly one chunk, so
 * cross-chunk duplicates come from the LLM re-reporting. On conflict the
 * highest severity wins; first occurrence order is preserved.
 */
export function consolidateFindings(
  results: readonly ReviewResult[],
): readonly Finding[] {
  const byKey = new Map<string, Finding>();
  const order: string[] = [];

  for (const result of results) {
    for (const finding of result.findings) {
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
