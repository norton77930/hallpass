import { defineConfig } from "vitest/config";

/**
 * HALLPASS_TEST_TIME_SCALE (#22, #28) stretches the default deadlines on a slow or busy machine.
 * Same rule as parseTimeScale in packages/test-kit/src/time-scale.ts, inline because this file
 * loads before the packages are built: a number of at least 1, otherwise 1 (what CI runs at).
 */
const rawScale = Number(process.env["HALLPASS_TEST_TIME_SCALE"]?.trim() || Number.NaN);
const timeScale = Number.isFinite(rawScale) && rawScale >= 1 ? rawScale : 1;

export default defineConfig({
  test: {
    globals: false,
    passWithNoTests: true,
    // #22: more workers cost more than they save where loading modules is slow. On a 20-core Windows
    // machine, where `require("jsdom")` alone took 16-22 s, the default lost 79 files to vitest's fixed
    // 60 s worker start bound and 22 tests to timeouts in 1616 s; 4 workers passed all in 964 s.
    // A single run can ask for another count with `--maxWorkers`.
    maxWorkers: 4,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 15_000 * timeScale,
    hookTimeout: 15_000 * timeScale,
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
            "tests/acceptance/probe-017/**/*.test.ts",
            "tests/harness/**/*.test.ts",
          ],
          exclude: ["apps/extension/tests/**/*.test.tsx"],
          setupFiles: ["./tests/setup.ts"],
        },
      },
      {
        test: {
          name: "extension-ui",
          environment: "jsdom",
          // #22: jsdom once per worker, not once per file, with each file still in its own context.
          // Forks left all 60 files to load it anew; on the same machine this project now takes 86 s.
          pool: "vmThreads",
          css: true,
          include: ["apps/extension/tests/**/*.test.tsx"],
          setupFiles: ["./tests/setup.ts"],
        },
      },
    ],
  },
});
