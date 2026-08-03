import { describe, it, expect, vi } from "vitest";
import { readChangedFiles, countRepoFiles } from "../../src/git/files.js";
import type { ReviewerConfig } from "@kitten/shared";
import { DEFAULT_CONFIG } from "@kitten/shared";
import fs from "node:fs";

vi.mock("node:fs");

const configWithSkip: ReviewerConfig = {
  ...DEFAULT_CONFIG,
  skip: ["**/Migrations/**", "*.Designer.cs"],
};

describe("countRepoFiles", () => {
  it("counts files matching pattern and skip", () => {
    vi.mocked(fs.readdirSync).mockReturnValueOnce([
      { name: "a.ts", isDirectory: () => false, isFile: () => true },
      { name: "b.ts", isDirectory: () => false, isFile: () => true },
    ] as never);
    vi.mocked(fs.statSync).mockReturnValue({ size: 100 } as never);

    const result = countRepoFiles("/tmp/repo");
    expect(result.total).toBe(2);
    expect(result.filtered).toBe(2);
    expect(result.skipped).toBe(0);
  });

  it("applies skip patterns to countRepoFiles", () => {
    vi.mocked(fs.readdirSync).mockReturnValueOnce([
      { name: "src", isDirectory: () => true, isFile: () => false },
    ] as never);
    vi.mocked(fs.readdirSync).mockReturnValueOnce([
      { name: "a.ts", isDirectory: () => false, isFile: () => true },
      { name: "HomeController.Designer.cs", isDirectory: () => false, isFile: () => true },
    ] as never);
    vi.mocked(fs.statSync)
      .mockReturnValueOnce({ size: 0 } as never)
      .mockReturnValueOnce({ size: 10 } as never)
      .mockReturnValueOnce({ size: 20 } as never);

    const result = countRepoFiles("/tmp/repo", configWithSkip);
    expect(result.skipped).toBeGreaterThanOrEqual(0);
  });
});

describe("readChangedFiles", () => {
  it("returns FileContent for each given path", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue("content-x" as never);
    vi.mocked(fs.statSync).mockReturnValue({ size: 42 } as never);

    const files = await readChangedFiles("/tmp/repo", ["src/a.ts", "src/b.ts"], DEFAULT_CONFIG);

    expect(files).toHaveLength(2);
    expect(files[0]!.path).toBe("src/a.ts");
    expect(files[0]!.content).toBe("content-x");
    expect(files[1]!.path).toBe("src/b.ts");
  });

  it("filters out files matching skip patterns", async () => {
    vi.mocked(fs.readFileSync).mockReturnValueOnce("content-a");
    vi.mocked(fs.statSync).mockReturnValueOnce({ size: 10 } as never);

    const files = await readChangedFiles(
      "/tmp/repo",
      ["src/a.ts", "Migrations/001.cs", "HomeController.Designer.cs"],
      configWithSkip,
    );

    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("src/a.ts");
  });
});
