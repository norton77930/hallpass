import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    passWithNoTests: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    projects: [
      {
        test: {
          name: "contract",
          environment: "node",
          include: ["tests/contract/**/*.test.ts"],
          setupFiles: ["./tests/setup.ts"],
        },
      },
      {
        test: {
          name: "unit",
          environment: "node",
          include: [
            "packages/**/*.test.ts",
            "apps/extension/tests/**/*.test.ts",
            "tests/acceptance/probe-004/**/*.test.ts",
          ],
          exclude: ["apps/extension/tests/**/*.test.tsx"],
          setupFiles: ["./tests/setup.ts"],
        },
      },
      {
        test: {
          name: "extension-ui",
          environment: "jsdom",
          css: true,
          include: ["apps/extension/tests/**/*.test.tsx"],
          setupFiles: ["./tests/setup.ts"],
        },
      },
    ],
  },
});
