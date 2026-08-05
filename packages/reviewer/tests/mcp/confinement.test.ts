import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { confinePath, isExcluded, capContent } from "../../src/mcp/confinement.js";
import { AppError } from "@kitten/shared";

let cloneDir: string;
let outsideDir: string;

beforeAll(() => {
  cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "kitten-confine-"));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "kitten-outside-"));
  fs.mkdirSync(path.join(cloneDir, "src"));
  fs.writeFileSync(path.join(cloneDir, "src", "a.ts"), "const a = 1;\n");
  fs.writeFileSync(path.join(outsideDir, "secret.txt"), "secret\n");
  fs.symlinkSync(outsideDir, path.join(cloneDir, "escape"));
});

afterAll(() => {
  fs.rmSync(cloneDir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

describe("confinePath", () => {
  it("resolves in-root relative paths", () => {
    expect(confinePath(cloneDir, "src/a.ts")).toBe(path.join(cloneDir, "src", "a.ts"));
  });

  it("rejects ../ traversal with VALIDATION", () => {
    try {
      confinePath(cloneDir, "../../etc/passwd");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION");
    }
  });

  it("rejects absolute paths outside the clone", () => {
    expect(() => confinePath(cloneDir, "/etc/passwd")).toThrowError(AppError);
  });

  it("rejects symlinks inside the clone pointing outside", () => {
    expect(() => confinePath(cloneDir, "escape/secret.txt")).toThrowError(AppError);
  });
});

describe("isExcluded", () => {
  it("always excludes .git", () => {
    expect(isExcluded(".git/config", [])).toBe(true);
    expect(isExcluded(".git", [])).toBe(true);
  });

  it("excludes skip patterns via picomatch", () => {
    expect(isExcluded("node_modules/pkg/index.js", ["**/node_modules/**"])).toBe(true);
    expect(isExcluded("src/a.ts", ["**/node_modules/**"])).toBe(false);
  });
});

describe("capContent", () => {
  it("truncates content over the byte cap", () => {
    const result = capContent("abcdef", 3);
    expect(result.content).toBe("abc");
    expect(result.truncated).toBe(true);
  });

  it("passes small content through untruncated", () => {
    expect(capContent("abc", 100)).toEqual({ content: "abc", truncated: false });
  });
});
