import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "shared",
          root: "packages/shared",
          include: ["tests/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "dispatcher",
          root: "packages/dispatcher",
          include: ["tests/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "reviewer",
          root: "packages/reviewer",
          include: ["tests/**/*.test.ts"],
          environment: "node",
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      reporter: ["text"],
    },
  },
});
