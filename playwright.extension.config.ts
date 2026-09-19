import { defineConfig } from "@playwright/test";

const profileName = process.env.HALLPASS_RELEASE_PROFILE ?? "packaged-core";
const locale = process.env.HALLPASS_LOCALE === "zh-TW" ? "zh-TW" : "en-US";

/**
 * Each run writes into its own directory. Playwright cleans its output directory when a run starts, so
 * a shared one silently destroys the artifacts of the failure you are trying to read as soon as you
 * re-run the gate. These are harness paths under the ignored `test-results/`, not product state.
 *
 * Playwright loads this config once per process, so the id is pinned in the environment by whichever
 * process gets there first and inherited by the workers. Computing it independently would send the
 * workers' attachments to a different directory than the one the run reports.
 */
const runId = (process.env.HALLPASS_GATE_RUN_ID ??= `${profileName}-${locale}-${new Date()
  .toISOString()
  .replace(/[:.]/g, "-")}`);

export default defineConfig({
  testDir: "./tests/e2e/packaged",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  /**
   * A per-test timeout cannot end a run that stalls in setup, teardown, or process exit — one such
   * stall ran for 25 minutes on 2026-09-02 and produced nothing to diagnose. This bounds the whole
   * run so a stall is reported instead of waited on. It is harness configuration, in the same class as
   * the per-test and webServer timeouts above, and is not a product latency limit.
   */
  globalTimeout: 1_200_000,
  outputDir: `test-results/${runId}`,
  expect: { timeout: 15_000 },
  forbidOnly: true,
  ...(process.env.HALLPASS_RELEASE_MATRIX === "1"
    ? { globalSetup: "./tests/e2e/fixtures/release-matrix-preflight.ts" }
    : {}),
  reporter: [["list"], ["json", { outputFile: `test-results/${runId}/report.json` }]],
  use: {
    trace: "retain-on-failure",
    video: "off",
    screenshot: "only-on-failure",
    ignoreHTTPSErrors: false,
    locale,
  },
  projects: [{ name: profileName }],
  /**
   * The page fixtures are the only service the gate starts. The archived remote path's upstream and
   * its redacting proxy were removed with `apps/server` (009/T245); `agent-privacy.spec.ts` starts
   * the proxy by hand when it wants to observe that nothing reaches it, which is what its own skip
   * message says.
   */
  webServer: [
    {
      command: "npm run dev:test-pages",
      url: "https://localhost:19443/ordinary",
      reuseExistingServer: true,
      ignoreHTTPSErrors: true,
      timeout: 120_000,
    },
  ],
});
