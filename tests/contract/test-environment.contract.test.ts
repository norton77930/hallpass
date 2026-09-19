import { describe, expect, it } from "vitest";
import packagedGateConfig from "../../playwright.extension.config.js";
import { readFile } from "node:fs/promises";
import {
  TEST_EXTENSION_ID,
  TEST_PAGE_ALLOW_PORT,
  TEST_PAGE_DENY_PORT,
  TEST_PAGE_UNKNOWN_PORT,
} from "../../packages/test-kit/src/build-config.js";
import { PAGE_FIXTURE_HOST } from "../../packages/test-kit/src/page-fixture.js";
import {
  parseBrowserMajor,
  releaseMatrixProfiles,
  validateReleaseEnvironment,
} from "../release/release-environment.js";
import { classifyLeafValidity, leafValidityMessage } from "../../packages/test-kit/src/test-pki.js";

/**
 * WP10 claim 1 (review L14): the test TLS leaf lives for thirty days (seven until 2026-09-16, when the
 * owner chose a lifetime that does not interrupt every week). When it lapses, every packaged
 * case fails at once with `ERR_CERT_DATE_INVALID`, which reads exactly like a product regression -
 * it did on 2026-09-03. The harness has to name the cause and the fix instead.
 */
describe("WP10 test PKI expiry is reported as an environment fault", () => {
  const now = Date.parse("2026-09-05T00:00:00.000Z");

  it("separates a lapsed leaf from one about to lapse from a usable one", () => {
    expect(classifyLeafValidity("2026-09-04T23:59:59.000Z", now)).toBe("expired");
    // Inside the last day: a gate that starts now can outlive its own certificate.
    expect(classifyLeafValidity("2026-09-05T06:00:00.000Z", now)).toBe("expiring");
    expect(classifyLeafValidity("2026-09-08T00:00:00.000Z", now)).toBe("usable");
    // A certificate whose validity cannot be read is not evidence that it is fine.
    expect(classifyLeafValidity("not a date", now)).toBe("expired");
  });

  it("names the cause and the one command that fixes it", () => {
    for (const state of ["expired", "expiring"] as const) {
      const message = leafValidityMessage(state, "2026-09-04T23:59:59.000Z");
      expect(message).toContain("npm run test:certs:install");
      expect(message).toContain("test-pki.leaf-");
      // The lifetime is the fact that makes this recur, so the message states it - and it must
      // agree with `$LeafDays` in scripts/test-pki.ps1.
      expect(message).toMatch(/thirty days|30 days/i);
    }
  });
});

describe("T015 test environment contract", () => {
  /**
   * A packaged-gate failure is only evidence if it can still be read afterwards. Three intermittent
   * failures on 2026-09-02 left nothing to diagnose: one run hung with no per-test timeout able to
   * reach it, and the artifacts of the other two were removed when the next run cleaned the shared
   * output directory.
   */
  it("bounds a packaged gate run and keeps each run's failure artifacts readable", () => {
    // A per-test timeout cannot end a run that stalls in setup, teardown, or process exit.
    expect(typeof packagedGateConfig.globalTimeout).toBe("number");
    expect(packagedGateConfig.globalTimeout).toBeGreaterThan(packagedGateConfig.timeout ?? 0);

    // A shared output directory is wiped at the start of the next run, taking the evidence with it.
    expect(packagedGateConfig.outputDir).toMatch(/^test-results[\/].+/);

    // Retrying would turn an intermittent failure green and hide exactly what needs investigating.
    expect(packagedGateConfig.retries).toBe(0);
  });

  it("lets every packaged gate run record a machine-readable result", async () => {
    // A CLI --reporter flag replaces the configured reporter array wholesale rather than adding to it,
    // so a runner that passes one silently drops the machine-readable report for its own runs.
    const reporters = (packagedGateConfig.reporter ?? []) as unknown as Array<
      [string, Record<string, unknown>?]
    >;
    const json = reporters.find((entry) => entry[0] === "json");
    expect(json?.[1]?.outputFile).toMatch(/^test-results[\/].+[\/]report\.json$/);

    const matrixRunner = await readFile("tests/release/run-p1-matrix.ts", "utf8");
    // Matches the flag only as a spawned argument, not as prose in a comment.
    expect(matrixRunner).not.toMatch(/["']--reporter/);
  });

  it("parses the major from a Windows ProductVersion", () => {
    expect(parseBrowserMajor("151.0.7922.174\r\n")).toBe("151");
  });

  /**
   * The page fixtures are on 127.0.0.1, which the extension holds no host permission for, and on
   * three ports the deterministic origin-safety adapter answers differently about. One host and
   * three distinct ports is what makes allow / deny / unknown separable at all.
   */
  it("pins 127.0.0.1 page fixtures on three distinct ports", () => {
    expect(PAGE_FIXTURE_HOST).toBe("127.0.0.1");
    expect(new Set([TEST_PAGE_ALLOW_PORT, TEST_PAGE_DENY_PORT, TEST_PAGE_UNKNOWN_PORT]).size).toBe(3);
    for (const port of [TEST_PAGE_ALLOW_PORT, TEST_PAGE_DENY_PORT, TEST_PAGE_UNKNOWN_PORT]) {
      expect(port).toBeGreaterThan(1024);
    }
  });

  it("pins a stable test Extension ID separate from production", async () => {
    expect(TEST_EXTENSION_ID).toMatch(/^[a-p]{32}$/);
    const testKit = await import("@hallpass/test-kit");
    expect(testKit.assertProductionRejectsTestIdentity).toBeTypeOf("function");
  });

  it("requires an exact CurrentUser CA thumbprint before harness startup", async () => {
    const env = await import("../../packages/test-kit/src/service-fixture.js");
    expect(env.assertTestPkiReady).toBeTypeOf("function");
    const missing = env.assertTestPkiReady({ installedThumbprint: "abc" });
    expect(missing.ok).toBe(false);
    const mismatch = env.assertTestPkiReady({
      thumbprint: "AAA",
      installedThumbprint: "BBB",
    });
    expect(mismatch.ok).toBe(false);
  });

  it("requires DNS SAN localhost and IP SAN 127.0.0.1 on the test leaf", async () => {
    const env = await import("../../packages/test-kit/src/service-fixture.js");
    const result = env.assertLeafSans({
      dns: ["localhost"],
      ip: ["127.0.0.1"],
    });
    expect(result.ok).toBe(true);
    expect(env.assertLeafSans({ dns: ["localhost"], ip: [] }).ok).toBe(false);
  });

  it("fails release runners closed without two distinct exact browser binaries", () => {
    expect(validateReleaseEnvironment({}, () => true)).toEqual({
      ok: false,
      reason: "release-harness-disabled: set HALLPASS_E2E=1",
    });
    expect(validateReleaseEnvironment({ HALLPASS_E2E: "1" }, () => true)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("CHROME_CURRENT_PATH"),
    });
    expect(
      validateReleaseEnvironment(
        {
          HALLPASS_E2E: "1",
          CHROME_CURRENT_PATH: "C:/Chrome/151/chrome.exe",
          CHROME_PREVIOUS_PATH: "C:/Chrome/151-copy/chrome.exe",
          CHROME_CURRENT_MAJOR: "151",
          CHROME_PREVIOUS_MAJOR: "151",
        },
        () => true,
      ),
    ).toEqual({ ok: false, reason: "release-majors-must-be-distinct" });
  });

  it("accepts two distinct exact release browser binaries", () => {
    const source = {
      HALLPASS_E2E: "1",
      CHROME_CURRENT_PATH: "C:/Chrome/151/chrome.exe",
      CHROME_PREVIOUS_PATH: "C:/Chrome/150/chrome.exe",
      CHROME_CURRENT_MAJOR: "151",
      CHROME_PREVIOUS_MAJOR: "150",
    };
    expect(
      validateReleaseEnvironment(
        source,
        () => true,
        (path) => (path.includes("/151/") ? "151" : "150"),
      ),
    ).toEqual({
      ok: true,
      value: source,
    });
  });

  it("rejects a declared major that does not match the browser binary", () => {
    const source = {
      HALLPASS_E2E: "1",
      CHROME_CURRENT_PATH: "C:/Chrome/151/chrome.exe",
      CHROME_PREVIOUS_PATH: "C:/Chrome/150/chrome.exe",
      CHROME_CURRENT_MAJOR: "151",
      CHROME_PREVIOUS_MAJOR: "150",
    };
    expect(
      validateReleaseEnvironment(
        source,
        () => true,
        (path) => (path.includes("/151/") ? "150" : "150"),
      ),
    ).toEqual({
      ok: false,
      reason: "release-major-mismatch: CHROME_CURRENT_MAJOR",
    });
  });

  it("expands the exact release environment into four packaged Extension profiles", () => {
    expect(
      releaseMatrixProfiles({
        HALLPASS_E2E: "1",
        CHROME_CURRENT_PATH: "C:/Chrome/151/chrome.exe",
        CHROME_PREVIOUS_PATH: "C:/Chrome/150/chrome.exe",
        CHROME_CURRENT_MAJOR: "151",
        CHROME_PREVIOUS_MAJOR: "150",
      }),
    ).toEqual([
      { channel: "current", major: "151", locale: "en-US", executablePath: "C:/Chrome/151/chrome.exe" },
      { channel: "current", major: "151", locale: "zh-TW", executablePath: "C:/Chrome/151/chrome.exe" },
      { channel: "previous", major: "150", locale: "en-US", executablePath: "C:/Chrome/150/chrome.exe" },
      { channel: "previous", major: "150", locale: "zh-TW", executablePath: "C:/Chrome/150/chrome.exe" },
    ]);
  });
});
