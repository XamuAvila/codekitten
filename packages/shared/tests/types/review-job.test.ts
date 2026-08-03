import { describe, expect, it } from "vitest";

import { ReviewJobSchema } from "../../src/types/index.js";

const VALID_JOB = {
  repo: "octocat/Hello-World",
  prNumber: 1,
  headRef: "main",
  baseRef: "main~1",
  sender: "octocat",
  isReReview: false,
} as const;

describe("ReviewJobSchema", () => {
  it("ReviewJobSchema accepts valid payload", () => {
    const result = ReviewJobSchema.parse(VALID_JOB);

    expect(result).toEqual(VALID_JOB);
  });

  it("ReviewJobSchema accepts optional changedFiles", () => {
    const result = ReviewJobSchema.parse({
      ...VALID_JOB,
      changedFiles: ["src/index.ts", "README.md"],
    });

    expect(result.changedFiles).toEqual(["src/index.ts", "README.md"]);
  });

  it("ReviewJobSchema rejects missing repo", () => {
    const withoutRepo: Record<string, unknown> = { ...VALID_JOB };
    delete withoutRepo["repo"];

    expect(() => ReviewJobSchema.parse(withoutRepo)).toThrow();
  });

  it("ReviewJobSchema rejects negative prNumber", () => {
    expect(() => ReviewJobSchema.parse({ ...VALID_JOB, prNumber: -1 })).toThrow();
  });
});
