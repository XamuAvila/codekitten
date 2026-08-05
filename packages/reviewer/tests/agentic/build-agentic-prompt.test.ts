import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_MCP_CONFIG } from "@kitten/shared";

import { buildAgenticPrompt } from "../../src/agentic/build-agentic-prompt.js";

const DIFF = "diff --git a/src/auth.ts b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new";

const CHANGED_FILES = [
  { path: "src/auth.ts", status: "modified", additions: 120, deletions: 14, patchBytes: 2100 },
  { path: "src/utils/http.ts", status: "added", additions: 8, deletions: 2, patchBytes: 480 },
];

describe("buildAgenticPrompt", () => {
  it("system carries the v3 guardrails plus the agentic block", () => {
    const { system } = buildAgenticPrompt(DIFF, CHANGED_FILES, DEFAULT_CONFIG, undefined, DEFAULT_MCP_CONFIG);

    // v3 guardrails
    expect(system).toContain("NEVER commit");
    expect(system).toContain("exact file and line");
    expect(system).toContain(`at most ${DEFAULT_CONFIG.maxFindings} findings`);
    // agentic block
    expect(system).toMatch(/explore/i);
    expect(system).toMatch(/read-only/i);
    expect(system).toContain(`${DEFAULT_MCP_CONFIG.maxTurns}`);
    expect(system).toContain("report_findings");
  });

  it("user carries diff + changed-file index, not full contents", () => {
    const { user } = buildAgenticPrompt(DIFF, CHANGED_FILES, DEFAULT_CONFIG, "Repo conventions here", DEFAULT_MCP_CONFIG);

    expect(user).toContain(DIFF);
    expect(user).toContain("Repository conventions:");
    expect(user).toContain("src/auth.ts");
    expect(user).toContain("modified");
    expect(user).toContain("+120 -14");
    expect(user).not.toContain("Changed files (full content)");
  });

  it("honors a custom maxTurns (force mode)", () => {
    const { system } = buildAgenticPrompt(DIFF, CHANGED_FILES, DEFAULT_CONFIG, undefined, DEFAULT_MCP_CONFIG, 60);
    expect(system).toContain("60");
  });
});
