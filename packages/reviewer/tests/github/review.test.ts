import { describe, expect, it, vi, beforeEach } from "vitest";
import { isLineInPatch, postPrReview } from "../../src/github/review.js";

const { mockCreateReview } = vi.hoisted(() => ({ mockCreateReview: vi.fn() }));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    pulls = { createReview: mockCreateReview };
  },
}));

const ADDED_HUNK = "@@ -10,7 +12,7 @@ export const SurveyLinkUsed = async ({\n const t = await getTranslations();\n export const SurveyLinkUsed = async ({ singleUseMessage }: SurveyLinkUsedProps) => {\n-  const t = await getTranslations();\n+  const t = useTransla\n+export const SurveyLinkUsed = ({ singleUseMessage }: SurveyLinkUsedProps) => {\n";

describe("isLineInPatch", () => {
  it("returns true for a line inside an added range", () => {
    // New file line 16 is inside the hunk (+12,7 → lines 12..18)
    expect(isLineInPatch(ADDED_HUNK, 16)).toBe(true);
  });

  it("returns true for a context (unchanged) line inside the hunk", () => {
    expect(isLineInPatch(ADDED_HUNK, 12)).toBe(true);
  });

  it("returns false for a line before the hunk", () => {
    expect(isLineInPatch(ADDED_HUNK, 5)).toBe(false);
  });

  it("returns false for a line after the hunk", () => {
    expect(isLineInPatch(ADDED_HUNK, 100)).toBe(false);
  });

  it("returns false for an empty patch", () => {
    expect(isLineInPatch("", 1)).toBe(false);
  });

  it("returns false for a patch without hunks", () => {
    expect(isLineInPatch("Binary files differ", 1)).toBe(false);
  });

  it("handles multiple hunks and finds the right one", () => {
    const multi = "@@ -1,3 +1,3 @@\n a\n b\n-c\n+d\n@@ -20,2 +20,2 @@\n e\n f\n";
    expect(isLineInPatch(multi, 2)).toBe(true); // first hunk
    expect(isLineInPatch(multi, 21)).toBe(true); // second hunk
    expect(isLineInPatch(multi, 30)).toBe(false); // outside both
  });
});

describe("postPrReview", () => {
  const FINDINGS = [
    { severity: "high" as const, file: "src/app.ts", line: 16, finding: "Bug", suggestion: "Fix it" },
    { severity: "low" as const, file: "src/app.ts", line: 9999, finding: "Off diff", suggestion: undefined },
  ];

  beforeEach(() => mockCreateReview.mockReset());

  it("posts one review with inline comments for mapped findings and table for unmapped", async () => {
    mockCreateReview.mockResolvedValue({ data: { id: 1 } });

    const result = await postPrReview(
      "token",
      "octocat/Hello-World",
      42,
      FINDINGS,
      new Map([["src/app.ts", ADDED_HUNK]]),
    );

    expect(result).toEqual({ postedInline: 1, inTable: 1 });
    expect(mockCreateReview).toHaveBeenCalledTimes(1);

    const [params] = mockCreateReview.mock.calls[0];
    expect(params.state).toBe("COMMENTED");
    expect(params.event).toBe("COMMENT"); // without event the review stays PENDING
    expect(params.body).toContain("**Actionable comments posted: 1**");
    expect(params.body).toContain("| Severity");
    expect(params.body).toContain("Off diff");
    expect(params.comments).toEqual([
      {
        path: "src/app.ts",
        line: 16,
        side: "RIGHT",
        body: expect.stringContaining("Bug"),
      },
    ]);
  });

  it("creates no inline comments and a full table when no finding maps", async () => {
    mockCreateReview.mockResolvedValue({ data: { id: 1 } });

    const result = await postPrReview("token", "octocat/Hello-World", 42, FINDINGS, new Map());

    expect(result).toEqual({ postedInline: 0, inTable: 2 });
    const [params] = mockCreateReview.mock.calls[0];
    expect(params.comments).toEqual([]);
    expect(params.body).toContain("**Actionable comments posted: 0**");
  });
});
