import { describe, expect, it } from "vitest";
import { consolidateFindings } from "../../src/chunker/consolidate.js";
import type { Finding } from "@kitten/shared";

const A: Finding = { severity: "high", file: "a.ts", line: 1, finding: "A" };
const A_LOW: Finding = { severity: "low", file: "a.ts", line: 1, finding: "A again" };
const B: Finding = { severity: "medium", file: "b.ts", line: 2, finding: "B" };

describe("consolidateFindings", () => {
  it("merges findings from multiple chunks", () => {
    const result = consolidateFindings([{ findings: [A] }, { findings: [B] }]);

    expect(result).toHaveLength(2);
    expect(result).toContainEqual(A);
    expect(result).toContainEqual(B);
  });

  it("dedupes by file:line keeping the highest severity", () => {
    const result = consolidateFindings([{ findings: [A_LOW] }, { findings: [A] }]);

    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("high");
    expect(result[0].finding).toBe("A");
  });

  it("returns empty for empty input", () => {
    expect(consolidateFindings([])).toEqual([]);
  });

  it("preserves first-occurrence order", () => {
    const result = consolidateFindings([{ findings: [A, B] }, { findings: [B] }]);

    expect(result.map((f) => f.file)).toEqual(["a.ts", "b.ts"]);
  });
});
