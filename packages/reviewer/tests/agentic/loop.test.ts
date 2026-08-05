import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MCP_CONFIG } from "@kitten/shared";
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

  it("find_related and list_directory results reach the next turn; tool errors don't end the review", async () => {
    const adapter = makeAdapter([
      {
        toolUses: [
          { name: "list_directory", input: { path: "." } },
          { name: "find_related", input: { file: "../../escape.ts", line: 1 } },
        ],
      },
      { toolUses: [{ name: "report_findings", input: { findings: [] } }] },
    ]);

    const result = await runAgenticLoop(adapter, PROMPT, DEFAULT_MCP_CONFIG, {
      registry: makeRegistry(),
      maxOutputTokens: 8000,
    });

    expect(result.findings).toEqual([]);
    const secondTurn = adapter.explore.mock.calls[1][0];
    const serialized = JSON.stringify(secondTurn.messages[secondTurn.messages.length - 1].content);
    expect(serialized).toContain("a.ts");
    expect(serialized).toContain("VALIDATION");
  });

  it("tools whitelist: only whitelisted tools + report_findings appear in every turn (US-026 AC-5)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kitten-loop-"));
    fs.writeFileSync(path.join(dir, "a.ts"), "const a = 1;\n");
    const config = { ...DEFAULT_MCP_CONFIG, tools: ["read_file"] as const };
    const registry = createRegistry(dir, [], config);
    const adapter = makeAdapter([
      { toolUses: [{ name: "read_file", input: { path: "a.ts" } }] },
      { toolUses: [{ name: "report_findings", input: { findings: [] } }] },
    ]);

    await runAgenticLoop(adapter, PROMPT, config, { registry, maxOutputTokens: 8000 });

    for (const call of adapter.explore.mock.calls) {
      const names = call[0].tools.map((tool: { name: string }) => tool.name);
      expect(names.sort()).toEqual(["read_file", "report_findings"].sort());
    }
  });

  it("force escalation: opts.maxTurns overrides config maxTurns (13th turn still explores)", async () => {
    const exploring = Array.from({ length: 13 }, () => ({
      toolUses: [{ name: "read_file", input: { path: "a.ts" } }],
    }));
    const adapter = makeAdapter([
      ...exploring,
      { toolUses: [{ name: "report_findings", input: { findings: [] } }] },
    ]);

    const result = await runAgenticLoop(
      adapter,
      PROMPT,
      { ...DEFAULT_MCP_CONFIG, maxTurns: 12 },
      { registry: makeRegistry(), maxOutputTokens: 8000, maxTurns: 60 },
    );

    expect(result.hitBudget).toBe(false);
    // 13 exploration turns + the reporting turn all ran unforced
    expect(adapter.explore).toHaveBeenCalledTimes(14);
    for (const call of adapter.explore.mock.calls) {
      expect(call[0].forcedToolChoice).toBeUndefined();
    }
  });

  it("retries a transient explore failure and completes (US-027 AC-2)", async () => {
    const transient = Object.assign(new Error("rate limited"), { status: 429 });
    const adapter = makeAdapter([]);
    adapter.explore
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({
        toolUses: [{ name: "report_findings", input: { findings: [] } }],
        metadata: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
      });

    const result = await runAgenticLoop(adapter, PROMPT, DEFAULT_MCP_CONFIG, {
      registry: makeRegistry(),
      maxOutputTokens: 8000,
    });

    expect(result.findings).toEqual([]);
    expect(adapter.explore).toHaveBeenCalledTimes(2);
  }, 15_000);

  it("never retries a 401 auth failure", async () => {
    const auth = Object.assign(new Error("unauthorized"), { status: 401 });
    const adapter = makeAdapter([]);
    adapter.explore.mockRejectedValue(auth);

    await expect(
      runAgenticLoop(adapter, PROMPT, DEFAULT_MCP_CONFIG, {
        registry: makeRegistry(),
        maxOutputTokens: 8000,
      }),
    ).rejects.toThrow("unauthorized");
    expect(adapter.explore).toHaveBeenCalledTimes(1);
  });

  it("sums turn tokens and logs per-tool lines without result content (US-027 AC-4)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = makeAdapter([
      {
        toolUses: [{ name: "read_file", input: { path: "a.ts" } }],
        metadata: { inputTokens: 100, outputTokens: 40, durationMs: 1 },
      },
      {
        toolUses: [{ name: "report_findings", input: { findings: [] } }],
        metadata: { inputTokens: 200, outputTokens: 60, durationMs: 1 },
      },
    ]);

    const result = await runAgenticLoop(adapter, PROMPT, DEFAULT_MCP_CONFIG, {
      registry: makeRegistry(),
      maxOutputTokens: 8000,
    });

    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(100);

    const lines = log.mock.calls.map((c) => String(c[0]));
    const toolLine = lines.find((l) => l.includes("read_file"));
    expect(toolLine).toBeDefined();
    expect(toolLine).toMatch(/Turn 1\/\d+/);
    expect(toolLine).toContain('"path":"a.ts"');
    expect(toolLine).not.toContain("const a = 1;"); // tool RESULT content never logged
    expect(lines.some((l) => /Turn 1\/\d+: 100 in \/ 40 out tokens/.test(l))).toBe(true);
    log.mockRestore();
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
