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
          // Load repo-root .env (DEEPSEEK_API_KEY etc.) into the test env
          setupFiles: ["../../vitest.setup.ts"],
        },
      },
      {
        test: {
          name: "dispatcher",
          root: "packages/dispatcher",
          include: ["tests/**/*.test.ts"],
          environment: "node",
          setupFiles: ["../../vitest.setup.ts"],
        },
      },
      {
        test: {
          name: "reviewer",
          root: "packages/reviewer",
          include: ["tests/**/*.test.ts"],
          environment: "node",
          setupFiles: ["../../vitest.setup.ts"],
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
