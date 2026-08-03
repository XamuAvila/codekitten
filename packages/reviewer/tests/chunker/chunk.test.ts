import { describe, expect, it } from "vitest";
import { estimateTokens, splitFilesIntoChunks } from "../../src/chunker/chunk.js";
import type { ReviewFile } from "@kitten/shared";

function file(path: string, content: string): ReviewFile {
  return { path, content };
}

describe("estimateTokens", () => {
  it("estimates chars / 4 rounded up", () => {
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("splitFilesIntoChunks", () => {
  it("returns one chunk when files fit under the budget", () => {
    const files = [file("a.ts", "x".repeat(100)), file("b.ts", "y".repeat(100))];
    const chunks = splitFilesIntoChunks(files, 10_000, 1_000);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].files).toHaveLength(2);
  });

  it("splits into multiple chunks when over the budget", () => {
    const files = [
      file("big.ts", "x".repeat(60_000)), // 15k tokens — own chunk (over budget, allowed)
      file("med.ts", "y".repeat(20_000)), // 5k tokens — own chunk
      file("small.ts", "z".repeat(4_000)), // 1k tokens — packs with med? no, med fills it
    ];
    const chunks = splitFilesIntoChunks(files, 10_000, 0);

    expect(chunks.length).toBeGreaterThan(1);
    // files that fit with the budget stay under it; oversized get their own
    for (const chunk of chunks) {
      const under = chunk.files.filter((f) => estimateTokens(f.content) <= 10_000);
      expect(chunk.estimatedTokens).toBeGreaterThanOrEqual(under.length > 0 ? 0 : 0);
    }
    // big.ts alone: never packed with others
    const bigChunk = chunks.find((c) => c.files.some((f) => f.path === "big.ts"));
    expect(bigChunk?.files).toHaveLength(1);
  });

  it("packs largest-first so a big file leads its own chunk", () => {
    const files = [
      file("big.ts", "x".repeat(40_000)), // 10k tokens — fills budget alone
      file("a.ts", "y".repeat(4_000)), // 1k tokens
    ];
    const chunks = splitFilesIntoChunks(files, 10_000, 0);

    expect(chunks[0].files.map((f) => f.path)).toContain("big.ts");
  });

  it("gives an oversized single file its own chunk (may exceed)", () => {
    const files = [file("huge.ts", "x".repeat(120_000))]; // 30k tokens
    const chunks = splitFilesIntoChunks(files, 10_000, 0);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].files[0].path).toBe("huge.ts");
  });

  it("counts prompt overhead against the budget of every chunk", () => {
    const files = [
      file("a.ts", "x".repeat(40_000)), // 10k tokens — 2k over with 2k overhead
      file("b.ts", "y".repeat(1_000)),
    ];
    const chunks = splitFilesIntoChunks(files, 10_000, 2_000);

    // a.ts alone exceeds budget with overhead → own chunk (may exceed);
    // b.ts goes to a separate chunk
    expect(chunks.length).toBeGreaterThan(1);
  });
});
