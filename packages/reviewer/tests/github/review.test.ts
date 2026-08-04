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
      "comment_only",
    );

    expect(result).toEqual({ postedInline: 1, inTable: 1, event: "COMMENT", downgraded: false });
    expect(mockCreateReview).toHaveBeenCalledTimes(1);

    const [params] = mockCreateReview.mock.calls[0];
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

    const result = await postPrReview("token", "octocat/Hello-World", 42, FINDINGS, new Map(), "comment_only");

    expect(result).toEqual({ postedInline: 0, inTable: 2, event: "COMMENT", downgraded: false });
    const [params] = mockCreateReview.mock.calls[0];
    expect(params.comments).toEqual([]);
    expect(params.body).toContain("**Actionable comments posted: 0**");
  });

  it("shows the rule id on both the inline comment and the table row", async () => {
    mockCreateReview.mockResolvedValue({ data: { id: 1 } });

    const attributed = [
      { severity: "high" as const, file: "src/app.ts", line: 16, finding: "Raw SQL", suggestion: "Use the builder", ruleId: "no-raw-sql" },
      { severity: "low" as const, file: "src/app.ts", line: 9999, finding: "Off diff", ruleId: "no-console-log" },
    ];

    await postPrReview(
      "token",
      "octocat/Hello-World",
      42,
      attributed,
      new Map([["src/app.ts", ADDED_HUNK]]),
      "comment_only",
    );

    const [params] = mockCreateReview.mock.calls[0];
    expect(params.comments[0].body).toContain("no-raw-sql");
    expect(params.body).toContain("no-console-log");
  });

  it("renders no rule markup when a finding carries no ruleId", async () => {
    mockCreateReview.mockResolvedValue({ data: { id: 1 } });

    await postPrReview(
      "token",
      "octocat/Hello-World",
      42,
      FINDINGS,
      new Map([["src/app.ts", ADDED_HUNK]]),
      "comment_only",
    );

    const [params] = mockCreateReview.mock.calls[0];
    expect(params.comments[0].body).not.toContain("undefined");
    expect(params.body).not.toContain("undefined");
  });

  it("submits REQUEST_CHANGES when blocking is request_changes", async () => {
    mockCreateReview.mockResolvedValue({ data: { id: 1 } });

    const result = await postPrReview(
      "token",
      "octocat/Hello-World",
      42,
      FINDINGS,
      new Map([["src/app.ts", ADDED_HUNK]]),
      "request_changes",
    );

    const [params] = mockCreateReview.mock.calls[0];
    expect(params.event).toBe("REQUEST_CHANGES");
    expect(result.event).toBe("REQUEST_CHANGES");
    expect(result.downgraded).toBe(false);
  });

  it("sends no state field and always sends a non-empty body", async () => {
    mockCreateReview.mockResolvedValue({ data: { id: 1 } });

    for (const blocking of ["comment_only", "request_changes"] as const) {
      mockCreateReview.mockClear();
      await postPrReview(
        "token",
        "octocat/Hello-World",
        42,
        FINDINGS,
        new Map([["src/app.ts", ADDED_HUNK]]),
        blocking,
      );

      const [params] = mockCreateReview.mock.calls[0];
      // `state` is not a field of the create-review request body; GitHub
      // requires `body` whenever event is COMMENT or REQUEST_CHANGES.
      expect(params).not.toHaveProperty("state");
      expect(typeof params.body).toBe("string");
      expect(params.body.length).toBeGreaterThan(0);
    }
  });

  it("downgrades to COMMENT when GitHub rejects the blocking review with 422", async () => {
    mockCreateReview
      .mockRejectedValueOnce(Object.assign(new Error("Unprocessable Entity"), { status: 422 }))
      .mockResolvedValueOnce({ data: { id: 2 } });

    const result = await postPrReview(
      "token",
      "octocat/Hello-World",
      42,
      FINDINGS,
      new Map([["src/app.ts", ADDED_HUNK]]),
      "request_changes",
    );

    expect(mockCreateReview).toHaveBeenCalledTimes(2);
    expect(mockCreateReview.mock.calls[0][0].event).toBe("REQUEST_CHANGES");
    expect(mockCreateReview.mock.calls[1][0].event).toBe("COMMENT");
    expect(mockCreateReview.mock.calls[1][0].body).toMatch(/request changes/i);
    expect(result.event).toBe("COMMENT");
    expect(result.downgraded).toBe(true);
  });

  it("does not retry when the submit fails with a non-422 error", async () => {
    // ...Once, matching the 422 test above. Observed on vitest 4.1.10: a
    // persistent rejecting mock (mockRejectedValue, or mockImplementation that
    // throws) makes this test fail with the raw error even when the call is
    // wrapped in try/catch, so the rejection surfaces from somewhere outside
    // the awaited call. The Once form does not. Root cause not investigated.
    mockCreateReview.mockRejectedValueOnce(Object.assign(new Error("boom"), { status: 500 }));

    let caught: unknown;
    try {
      await postPrReview(
        "token",
        "octocat/Hello-World",
        42,
        FINDINGS,
        new Map([["src/app.ts", ADDED_HUNK]]),
        "request_changes",
      );
    } catch (error) {
      caught = error;
    }

    expect((caught as Error | undefined)?.message).toBe("boom");

    expect(mockCreateReview).toHaveBeenCalledTimes(1);
  });
});
