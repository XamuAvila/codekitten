import { describe, expect, it, vi } from "vitest";
import { consolidateFindings } from "../../src/chunker/consolidate.js";
import type { Finding } from "@kitten/shared";

const A: Finding = { severity: "high", file: "a.ts", line: 1, finding: "A" };
const A_LOW: Finding = { severity: "low", file: "a.ts", line: 1, finding: "A again" };
const B: Finding = { severity: "medium", file: "b.ts", line: 2, finding: "B" };

const DECLARED: Finding = { severity: "high", file: "c.ts", line: 3, finding: "C", ruleId: "no-raw-sql" };
const UNDECLARED: Finding = { severity: "medium", file: "d.ts", line: 4, finding: "D", ruleId: "invented-rule" };
const DECLARED_IDS = new Set(["no-raw-sql"]);

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

  it("keeps rule attribution that matches a declared rule", () => {
    const result = consolidateFindings([{ findings: [DECLARED] }], DECLARED_IDS);

    expect(result[0].ruleId).toBe("no-raw-sql");
  });

  it("strips rule attribution that matches no declared rule but keeps the finding", () => {
    const result = consolidateFindings([{ findings: [UNDECLARED] }], DECLARED_IDS);

    expect(result).toHaveLength(1);
    expect(result[0].finding).toBe("D");
    expect(result[0].ruleId).toBeUndefined();
  });

  it("warns once naming the undeclared rule id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    consolidateFindings([{ findings: [UNDECLARED] }], DECLARED_IDS);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("invented-rule");
    warn.mockRestore();
  });

  it("preserves rule attribution when no declared set is supplied", () => {
    const result = consolidateFindings([{ findings: [UNDECLARED] }]);

    expect(result[0].ruleId).toBe("invented-rule");
  });
});
