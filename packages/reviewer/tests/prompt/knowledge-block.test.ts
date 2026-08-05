import { describe, expect, it, vi } from "vitest";

import { buildKnowledgeBlock, fetchKnowledge } from "../../src/prompt/knowledge-block.js";
import type { KnowledgeClient } from "@kitten/shared";

const ENTRIES = [
  { text: "we always use zod for validation", source: "command" as const, author: "alice", score: 0.9 },
  { text: "Finding: X\nCorrection: intentional", source: "correction" as const, author: "bob", score: 0.8 },
];

describe("buildKnowledgeBlock", () => {
  it("renders a numbered block with source and author", () => {
    const block = buildKnowledgeBlock(ENTRIES);

    expect(block).toContain("Repository knowledge");
    expect(block).toContain("1. ");
    expect(block).toContain("we always use zod for validation");
    expect(block).toContain("2. ");
    expect(block).toContain("(correction by bob)");
    expect(block).toContain("(taught by alice)");
  });

  it("empty entries → empty string (no block rendered)", () => {
    expect(buildKnowledgeBlock([])).toBe("");
  });
});

describe("fetchKnowledge", () => {
  it("queries the client with repo, diff and topK", async () => {
    const search = vi.fn().mockResolvedValue(ENTRIES);
    const client = { search } as unknown as KnowledgeClient;

    const entries = await fetchKnowledge(client, "org/repo", "diff content", 5);

    expect(search).toHaveBeenCalledWith("org/repo", "diff content", 5);
    expect(entries).toEqual(ENTRIES);
  });

  it("undefined client → empty, no error", async () => {
    const entries = await fetchKnowledge(undefined, "org/repo", "diff", 5);
    expect(entries).toEqual([]);
  });

  it("search failure → empty + warning, never throws (epic error table)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = { search: vi.fn().mockRejectedValue(new Error("atlas down")) } as unknown as KnowledgeClient;

    const entries = await fetchKnowledge(client, "org/repo", "diff", 5);

    expect(entries).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("knowledge"));
    warn.mockRestore();
  });
});
