import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppError, DEFAULT_MCP_CONFIG } from "@kitten/shared";
import type { ExploreResult, LLMAdapter } from "@kitten/shared";

import { runAgenticLoop } from "../../src/agentic/loop.js";
import { createRegistry } from "../../src/mcp/registry.js";

const PROMPT = { system: "system", user: "user" };

const FINDING = {
  severity: "high",
  file: "src/a.ts",
  line: 1,
  finding: "Bug",
};

function makeAdapter(turns: readonly Partial<ExploreResult>[]): LLMAdapter & { explore: ReturnType<typeof vi.fn> } {
  const explore = vi.fn();
  for (const turn of turns) {
    explore.mockResolvedValueOnce({
      toolUses: [],
      metadata: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
      ...turn,
    });
  }
  return { review: vi.fn(), respond: vi.fn(), explore } as unknown as LLMAdapter & {
    explore: ReturnType<typeof vi.fn>;
  };
}

function makeRegistry(): ReturnType<typeof createRegistry> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kitten-loop-"));
  fs.writeFileSync(path.join(dir, "a.ts"), "const a = 1;\n");
  return createRegistry(dir, [], DEFAULT_MCP_CONFIG);
}

describe("runAgenticLoop", () => {
  it("executes tool_use, feeds tool_result into the next turn, ends on report_findings", async () => {
    const adapter = makeAdapter([
      { toolUses: [{ name: "read_file", input: { path: "a.ts" } }] },
      { toolUses: [{ name: "report_findings", input: { findings: [FINDING] } }] },
    ]);

    const result = await runAgenticLoop(adapter, PROMPT, DEFAULT_MCP_CONFIG, {
      registry: makeRegistry(),
      maxOutputTokens: 8000,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject(FINDING);
    expect(result.toolCalls).toBe(1);
    expect(result.hitBudget).toBe(false);

    // Second explore call received the tool_result of the first
    const secondTurn = adapter.explore.mock.calls[1][0];
    const lastMessage = secondTurn.messages[secondTurn.messages.length - 1];
    expect(JSON.stringify(lastMessage.content)).toContain("tool_result");
    expect(JSON.stringify(lastMessage.content)).toContain("const a = 1;");
  });

  it("warns when report_findings arrives with zero exploration", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = makeAdapter([
      { toolUses: [{ name: "report_findings", input: { findings: [FINDING] } }] },
    ]);

    const result = await runAgenticLoop(adapter, PROMPT, DEFAULT_MCP_CONFIG, {
      registry: makeRegistry(),
      maxOutputTokens: 8000,
    });

    expect(result.findings).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("without exploring"));
    warn.mockRestore();
  });

  it("invalid findings on a non-final turn become a tool error, model retries", async () => {
    const adapter = makeAdapter([
      { toolUses: [{ name: "report_findings", input: { findings: [{ severity: "bogus" }] } }] },
      { toolUses: [{ name: "report_findings", input: { findings: [FINDING] } }] },
    ]);

    const result = await runAgenticLoop(adapter, PROMPT, DEFAULT_MCP_CONFIG, {
      registry: makeRegistry(),
      maxOutputTokens: 8000,
    });

    expect(result.findings).toHaveLength(1);
    expect(adapter.explore).toHaveBeenCalledTimes(2);
  });

  it("exhausted maxTurns triggers a forced finalize turn and hitBudget", async () => {
    const exploringTurns = Array.from({ length: 3 }, () => ({
      toolUses: [{ name: "read_file", input: { path: "a.ts" } }],
    }));
    const adapter = makeAdapter([
      ...exploringTurns,
      { toolUses: [{ name: "report_findings", input: { findings: [FINDING] } }] },
    ]);

    const result = await runAgenticLoop(
      adapter,
      PROMPT,
      { ...DEFAULT_MCP_CONFIG, maxTurns: 3 },
      { registry: makeRegistry(), maxOutputTokens: 8000 },
    );

    expect(result.hitBudget).toBe(true);
    expect(result.findings).toHaveLength(1);
    const finalTurn = adapter.explore.mock.calls[3][0];
    expect(finalTurn.forcedToolChoice).toEqual({ name: "report_findings" });
  });

  it("invalid findings on the finalize turn fail with LLM_OUTPUT_INVALID", async () => {
    const adapter = makeAdapter([
      { toolUses: [{ name: "read_file", input: { path: "a.ts" } }] },
      { toolUses: [{ name: "report_findings", input: { findings: [{ severity: "bogus" }] } }] },
    ]);

    await expect(
      runAgenticLoop(
        adapter,
        PROMPT,
        { ...DEFAULT_MCP_CONFIG, maxTurns: 1 },
        { registry: makeRegistry(), maxOutputTokens: 8000 },
      ),
    ).rejects.toMatchObject({ code: "LLM_OUTPUT_INVALID" });
  });

  it("two consecutive text-only turns trigger finalize", async () => {
    const adapter = makeAdapter([
      { text: "thinking..." },
      { text: "still thinking..." },
      { toolUses: [{ name: "report_findings", input: { findings: [] } }] },
    ]);

    const result = await runAgenticLoop(adapter, PROMPT, DEFAULT_MCP_CONFIG, {
      registry: makeRegistry(),
      maxOutputTokens: 8000,
    });

    expect(result.findings).toEqual([]);
    expect(adapter.explore).toHaveBeenCalledTimes(3);
    const finalTurn = adapter.explore.mock.calls[2][0];
    expect(finalTurn.forcedToolChoice).toEqual({ name: "report_findings" });
  });

  it("unknown tool names return UNKNOWN_TOOL and the loop continues", async () => {
    const adapter = makeAdapter([
      { toolUses: [{ name: "write_file", input: { path: "a.ts" } }] },
      { toolUses: [{ name: "report_findings", input: { findings: [] } }] },
    ]);

    const result = await runAgenticLoop(adapter, PROMPT, DEFAULT_MCP_CONFIG, {
      registry: makeRegistry(),
      maxOutputTokens: 8000,
    });

    expect(result.findings).toEqual([]);
    const secondTurn = adapter.explore.mock.calls[1][0];
    const lastMessage = secondTurn.messages[secondTurn.messages.length - 1];
    expect(JSON.stringify(lastMessage.content)).toContain("UNKNOWN_TOOL");
    expect(JSON.stringify(lastMessage.content)).toContain("read_file");
  });

  it("an aborted signal stops the loop", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = makeAdapter([
      { toolUses: [{ name: "read_file", input: { path: "a.ts" } }] },
    ]);

    const result = await runAgenticLoop(adapter, PROMPT, DEFAULT_MCP_CONFIG, {
      registry: makeRegistry(),
      maxOutputTokens: 8000,
      signal: controller.signal,
    });

    expect(result.aborted).toBe(true);
    expect(result.findings).toEqual([]);
    expect(adapter.explore).not.toHaveBeenCalled();
  });

  it("search results feed back into the next turn's messages (US-024 AC-4)", async () => {
    const adapter = makeAdapter([
      { toolUses: [{ name: "search", input: { query: "const a" } }] },
      { toolUses: [{ name: "report_findings", input: { findings: [] } }] },
    ]);

    await runAgenticLoop(adapter, PROMPT, DEFAULT_MCP_CONFIG, {
      registry: makeRegistry(),
      maxOutputTokens: 8000,
    });

    const secondTurn = adapter.explore.mock.calls[1][0];
    const lastMessage = secondTurn.messages[secondTurn.messages.length - 1];
    expect(JSON.stringify(lastMessage.content)).toContain("a.ts:1");
    expect(JSON.stringify(lastMessage.content)).toContain("const a = 1;");
  });

  it("counts executed tool calls", async () => {
    const adapter = makeAdapter([
      {
        toolUses: [
          { name: "read_file", input: { path: "a.ts" } },
          { name: "read_file", input: { path: "a.ts" } },
        ],
      },
      { toolUses: [{ name: "read_file", input: { path: "a.ts" } }] },
      { toolUses: [{ name: "report_findings", input: { findings: [] } }] },
    ]);

    const result = await runAgenticLoop(adapter, PROMPT, DEFAULT_MCP_CONFIG, {
      registry: makeRegistry(),
      maxOutputTokens: 8000,
    });

    expect(result.toolCalls).toBe(3);
  });
});
