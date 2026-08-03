import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PullRequestFile } from "@kitten/shared";
import { readChangedFiles } from "../../src/git/read-files.js";

const mockReadFileSync = vi.fn();
const mockExistsSync = vi.fn(() => true);

vi.mock("node:fs", () => ({
  default: {
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
  },
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

function file(filename: string): PullRequestFile {
  return {
    filename,
    status: "modified",
    patch: "@@ -1 +1 @@",
    additions: 1,
    deletions: 0,
    changes: 1,
    blobUrl: `https://github.com/o/r/blob/abc/${filename}`,
    rawUrl: `https://github.com/o/r/raw/abc/${filename}`,
  };
}

describe("readChangedFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((path: string) => `content of ${path}`);
  });

  it("reads each file content from the clone", async () => {
    const files = await readChangedFiles("/tmp/clones/job1", [file("src/app.ts"), file("src/utils.ts")]);

    expect(files).toEqual([
      { path: "src/app.ts", content: expect.stringContaining("src/app.ts") },
      { path: "src/utils.ts", content: expect.stringContaining("src/utils.ts") },
    ]);
    expect(mockReadFileSync).toHaveBeenCalledTimes(2);
  });

  it("skips files that do not exist in the clone (removed/renamed)", async () => {
    mockExistsSync.mockImplementation((path: string) => !path.endsWith("gone.ts"));

    const files = await readChangedFiles("/tmp/clones/job1", [file("src/gone.ts"), file("src/stays.ts")]);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/stays.ts");
  });

  it("rejects path traversal attempts outside the clone dir", async () => {
    await expect(
      readChangedFiles("/tmp/clones/job1", [file("../../etc/passwd")]),
    ).rejects.toThrow(/escape|outside|traversal/i);
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("rejects absolute paths", async () => {
    await expect(
      readChangedFiles("/tmp/clones/job1", [file("/etc/passwd")]),
    ).rejects.toThrow(/escape|outside|traversal/i);
  });
});
