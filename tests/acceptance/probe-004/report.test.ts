import { describe, expect, it } from "vitest";

import { overallVerdict, renderMarkdown, reportStem, writeReport } from "./report.js";
import type { AcceptanceRun, ScenarioResult } from "./report.js";

/**
 * 004/T080 — the report writer.
 *
 * The report is the artifact the owner reads instead of watching the run, so the two things it must
 * never do are call a slice done while something did not pass, and bury a `not-run` scenario in a
 * list of greens. Everything here is asserted on the rendered text and the written pair of files;
 * nothing spawns an agent or touches the owner's browser.
 */

const ENVIRONMENT = {
  endpoint: "http://127.0.0.1:9222",
  browserVersion: "Chrome/152.0.7300.0",
  extensionBuild: "adgpccmmbgnchnphfaoabfflfcepbopd (loaded)",
  referenceVersion: "Claude in Chrome (loaded)",
  bridgeInstall: "host manifest + HKCU key + dist/mcp-server.js",
  claudeVersion: "2.1.266 (Claude Code)",
} as const;

function run(scenarios: ScenarioResult[]): AcceptanceRun {
  return { timestamp: "2026-09-09T13:24:05.000Z", slices: ["S0"], ...ENVIRONMENT, scenarios };
}

const PASSED: ScenarioResult = {
  id: "s0-first-call",
  page: "about:blank",
  baselineSource: "reference",
  baseline: "tabs_context lists 3 tabs",
  observed: "tabs_context lists 3 tabs",
  verdict: "pass",
  rawAnswers: "PASSING-RAW-ANSWER",
};

const FAILED: ScenarioResult = {
  id: "s0-pairing-timing",
  page: "about:blank",
  baselineSource: "reference",
  baseline: "first call answers",
  observed: "bridge-unavailable",
  verdict: "fail",
  rawAnswers: "FAILING-RAW-ANSWER",
};

const NOT_RUN: ScenarioResult = {
  id: "s0-artifact-frame",
  page: "https://claude.ai/chat/<artifact>",
  baselineSource: "browser-tree",
  baseline: "frame nodes present",
  observed: "",
  verdict: "not-run",
  reason: "the page the scenario was written against no longer exists",
  replacementPage: "https://claude.ai/chat/2026-09-09-artifact",
};

describe("probe-004 report verdict", () => {
  it("is done only when every scenario passed", () => {
    expect(overallVerdict([PASSED, PASSED])).toBe("done");
  });

  it("is not-done when a scenario failed", () => {
    expect(overallVerdict([PASSED, FAILED])).toBe("not-done");
  });

  it("is not-done when a scenario was not run", () => {
    expect(overallVerdict([PASSED, NOT_RUN])).toBe("not-done");
  });

  it("is not-done when there is nothing to judge", () => {
    expect(overallVerdict([])).toBe("not-done");
  });
});

describe("probe-004 report markdown", () => {
  it("opens with the environment table and a one-line verdict", () => {
    const markdown = renderMarkdown(run([PASSED]));
    // One line longer since T111c (the pairing), T129b (the site modes it set) and T167 (the
    // foreign agent servers it found).
    const head = markdown.split("\n").slice(0, 17).join("\n");
    expect(head).toContain("Chrome/152.0.7300.0");
    expect(head).toContain("2.1.266 (Claude Code)");
    expect(head).toContain("adgpccmmbgnchnphfaoabfflfcepbopd (loaded)");
    expect(head).toContain("**Verdict: done**");
  });

  it("keeps raw answers out of a passing scenario and in a failing one", () => {
    const markdown = renderMarkdown(run([PASSED, FAILED]));
    expect(markdown).not.toContain("PASSING-RAW-ANSWER");
    expect(markdown).toContain("FAILING-RAW-ANSWER");
  });

  it("states a not-run scenario's reason and names its replacement page", () => {
    const markdown = renderMarkdown(run([NOT_RUN]));
    expect(markdown).toContain("the page the scenario was written against no longer exists");
    expect(markdown).toContain("https://claude.ai/chat/2026-09-09-artifact");
    expect(markdown).toContain("**Verdict: not-done**");
  });

  /**
   * 004/T129b - the site modes the run set for itself.
   *
   * An undecided site sends every effect to an owner prompt, and an unanswered prompt times out, so
   * the probe decides the site the way it already decides its own pairing. That is an assumption the
   * run made about the browser, which is what this table is for: a reader who does not see it here
   * cannot tell a scenario that measured an effect from one that measured a mode nobody set.
   */
  it("records the site modes the probe set, and says so when it set none", () => {
    const markdown = renderMarkdown({
      ...run([PASSED]),
      siteModes: ["https://en.wikipedia.org → skip-checks (s4-wikipedia-typing)"],
    });
    expect(markdown).toContain("| Site modes |");
    expect(markdown).toContain("https://en.wikipedia.org → skip-checks (s4-wikipedia-typing)");
    expect(renderMarkdown(run([PASSED]))).toContain("| Site modes | none set by the probe |");
  });

  it("names each problem the environment check reported", () => {
    const markdown = renderMarkdown({ ...run([PASSED]), problems: ["reference extension not found"] });
    expect(markdown).toContain("reference extension not found");
  });
});

describe("probe-004 report files", () => {
  it("writes a filename-safe UTC stem shared by the markdown and the json", async () => {
    expect(reportStem("2026-09-09T13:24:05.000Z")).toBe("004-2026-09-09T13-24-05Z");

    const written = new Map<string, string>();
    const paths = await writeReport(run([PASSED, FAILED]), "reports", async (path, contents) => {
      written.set(path.replaceAll("\\", "/"), contents);
    });

    expect(paths.markdownPath.replaceAll("\\", "/")).toBe("reports/004-2026-09-09T13-24-05Z.md");
    expect(paths.jsonPath.replaceAll("\\", "/")).toBe("reports/004-2026-09-09T13-24-05Z.json");
    expect([...written.keys()].sort()).toEqual([
      "reports/004-2026-09-09T13-24-05Z.json",
      "reports/004-2026-09-09T13-24-05Z.md",
    ]);
    expect(paths.verdict).toBe("not-done");
  });

  it("puts the verdict and every scenario, raw answers included, in the json", async () => {
    const written = new Map<string, string>();
    await writeReport(run([PASSED, FAILED]), "reports", async (path, contents) => {
      written.set(path.replaceAll("\\", "/"), contents);
    });

    const parsed = JSON.parse(written.get("reports/004-2026-09-09T13-24-05Z.json") ?? "");
    expect(parsed.verdict).toBe("not-done");
    expect(parsed.scenarios).toHaveLength(2);
    expect(parsed.scenarios[0].rawAnswers).toBe("PASSING-RAW-ANSWER");
    expect(parsed.browserVersion).toBe("Chrome/152.0.7300.0");
  });
});
