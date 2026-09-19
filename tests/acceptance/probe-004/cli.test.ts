import { describe, expect, it } from "vitest";

import * as baselineModule from "./baseline.js";
import * as pairingModule from "./pairing.js";
import * as reportModule from "./report.js";
import type { AcceptanceRun } from "./report.js";
import * as runnerModule from "./agent-runner.js";
import { PROBE_SLICES, main, parseArgs, runProbe } from "./run.js";
import type { ProbeModules } from "./run.js";
import * as scenariosModule from "./scenarios.js";
import type { ProbeScenarioFile } from "./scenarios.js";

/**
 * 004/T073 — the probe's front door.
 *
 * The probe is the definition of done for every 004 slice, so the one thing that must never happen
 * is a run that looks successful without having touched the owner's browser. The CLI therefore
 * refuses in two places - no slice selection, and no `HALLPASS_CDP_ENDPOINT` - and refuses loudly, with
 * exit code 2 and a message that says what to set and where it is written down.
 *
 * No scenarios exist yet (T080-T087); until they do, a fully configured run says so and exits 0.
 */

const ENDPOINT = { HALLPASS_CDP_ENDPOINT: "http://127.0.0.1:9222" };

/** Collects what the CLI would have written, so the assertions can read it. */
function record(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => void lines.push(line) };
}

describe("probe-004 argument parsing", () => {
  it("accepts a single slice", () => {
    expect(parseArgs(["--slice", "S3"])).toEqual({ ok: true, slices: ["S3"] });
  });

  it("accepts --all as every slice", () => {
    expect(parseArgs(["--all"])).toEqual({ ok: true, slices: [...PROBE_SLICES] });
  });

  it("prints usage when neither --slice nor --all is given", () => {
    const parsed = parseArgs([]);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toContain("--slice");
    expect(parsed.ok === false && parsed.message).toContain("--all");
  });

  it("refuses --slice and --all together", () => {
    const parsed = parseArgs(["--all", "--slice", "S1"]);
    expect(parsed.ok).toBe(false);
  });

  it("refuses a slice outside S0..S10", () => {
    const parsed = parseArgs(["--slice", "S99"]);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toContain("S99");
  });
});

describe("probe-004 main", () => {
  it("exits 2 with usage when no selection is given", () => {
    const out = record();
    expect(main([], ENDPOINT, out.write)).toBe(2);
    expect(out.lines.join("\n")).toContain("--slice");
  });

  it("exits 2 naming HALLPASS_CDP_ENDPOINT and the quickstart section when it is unset", () => {
    const out = record();
    expect(main(["--all"], {}, out.write)).toBe(2);
    const printed = out.lines.join("\n");
    expect(printed).toContain("HALLPASS_CDP_ENDPOINT");
    expect(printed).toContain("quickstart.md");
  });

  // The "no scenarios implemented yet" line moved to `runProbe` with T084: it is only true once the
  // environment has been checked, and `main` deliberately touches nothing outside its arguments.
  it("exits 0 with the run it would perform once slice and endpoint are both present", () => {
    const out = record();
    expect(main(["--slice", "S0"], ENDPOINT, out.write)).toBe(0);
    expect(out.lines.join("\n")).toContain("probe-004: endpoint http://127.0.0.1:9222, slices S0");
  });
});

/**
 * T111a — what a paid run must leave behind, whatever else happens.
 *
 * The 2026-09-09 S0 run reached all four of its scenarios and then threw in the cleanup that runs
 * after them, so the report was never written and four observed values — the run's entire product —
 * were lost. The two tests below pin the two halves of the answer: a run that reached its scenarios
 * always leaves a report, even when one of them explodes; and a scenario that says `repeat` is run
 * that many times with one row that accounts for all of them, which is the shape SC-031's five
 * unpair-and-accept runs need (`concurrency` would run them at once, sharing one pairing reset).
 *
 * `runProbe` takes its helpers as a parameter for exactly this: no browser, no `claude`, no quota.
 */
const FAKE_SCENARIO: ProbeScenarioFile = {
  id: "s0-owner-tab",
  slice: "S0",
  evidence: "E3",
  page: "https://example.com/",
  prompt: "report what tabs_context returned",
  answerSchema: { type: "object" },
  expect: { kind: "observed-equals", value: "owner-tab-listed" },
  maxTurns: 12,
  maxBudgetUsd: 0.5,
  timeoutMs: 240_000,
};

function fakeModules(
  scenarios: ProbeScenarioFile[],
  runConcurrently: typeof runnerModule.runConcurrently,
  written: AcceptanceRun[],
): ProbeModules {
  return {
    environment: {
      AGENT_EXTENSION_ID: "adgpccmmbgnchnphfaoabfflfcepbopd",
      realEnvironmentDeps: async () => ({}),
      checkEnvironment: async () => ({
        problems: [],
        endpoint: "http://127.0.0.1:9222",
        browserVersion: "Chrome/152",
        extensionBuild: "agent",
        referenceVersion: "reference",
        bridgeInstall: "installed",
        claudeVersion: "2.1.266",
        pairing: "found — agent-abc is already accepted",
      }),
    } as unknown as typeof import("./environment.js"),
    report: {
      ...reportModule,
      writeReport: async (run) => {
        written.push(run);
        return { markdownPath: "md", jsonPath: "json", verdict: reportModule.overallVerdict(run.scenarios) };
      },
    },
    scenario: { ...scenariosModule, loadScenarios: async () => scenarios },
    runner: { ...runnerModule, runConcurrently },
    pairing: pairingModule,
    baseline: baselineModule,
  };
}

describe("probe-004 runProbe", () => {
  it("writes the report even when a scenario throws on its way out", async () => {
    const written: AcceptanceRun[] = [];
    const out = record();
    const modules = fakeModules([FAKE_SCENARIO], async () => {
      throw Object.assign(new Error("EBUSY: resource busy or locked, rmdir 'reports/.sessions/s0-owner-tab-NELnSO'"), {
        code: "EBUSY",
      });
    }, written);

    const code = await runProbe(["S0"], "http://127.0.0.1:9222", out.write, modules);

    expect(written).toHaveLength(1);
    // The crash is a row, not a silence: a report that simply omitted the scenario would read as a
    // clean run of nothing.
    expect(JSON.stringify(written[0]?.scenarios)).toContain("EBUSY");
    expect(code).toBe(1);
  });

  it("runs a scenario with repeat: 3 three times and judges the row on all three", async () => {
    const answers = ["owner-tab-listed", "owner-tab-listed", "owner-tab-missing"];
    const written: AcceptanceRun[] = [];
    const out = record();
    let calls = 0;
    const modules = fakeModules([{ ...FAKE_SCENARIO, repeat: 3 }], async () => {
      const observed = answers[calls] ?? "unexpected-extra-run";
      calls += 1;
      return [{ ok: true, scenario: FAKE_SCENARIO.id, answer: { scenario: FAKE_SCENARIO.id, steps: [], observed }, stdout: "" }];
    }, written);

    await runProbe(["S0"], "http://127.0.0.1:9222", out.write, modules);

    expect(calls).toBe(3);
    const rows = written[0]?.scenarios ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.observed).toContain("run 3/3");
    for (const answer of answers) expect(rows[0]?.observed).toContain(answer);
    // Two of three passing is not a pass: the scenario is five runs of one claim, not five claims.
    expect(rows[0]?.verdict).toBe("fail");
  });
/**
   * 004/T129b - the probe decides the site, and the report says it did.
   *
   * An undecided site turns every effect into an owner prompt that times out unattended, so the
   * three effect scenarios would have measured the prompt rather than the hover, the typing or the
   * reference. The mode is applied over the extension's own state before the session starts, from
   * the origin of the page the scenario names, and it is an assumption of the run - so it belongs in
   * the environment table, where a reader can see what the run took for granted.
   */
  it("sets the site mode a scenario declares and records it in the environment table", async () => {
    const written: AcceptanceRun[] = [];
    const out = record();
    const applied: Array<{ site: string; mode: string }> = [];
    const scenario = {
      ...FAKE_SCENARIO,
      id: "s4-wikipedia-typing",
      page: "https://en.wikipedia.org/wiki/Main_Page",
      setup: { siteMode: "skip-checks" as const },
    };
    const modules = {
      ...fakeModules([scenario], async () => [
        { ok: true as const, scenario: scenario.id, answer: { scenario: scenario.id, steps: [], observed: "owner-tab-listed" }, stdout: "" },
      ], written),
      pairing: {
        ...pairingModule,
        setSiteMode: async (_deps: unknown, site: string, mode: string) => {
          applied.push({ site, mode });
          return { set: true, detail: `${site} set to ${mode} via CDP` };
        },
      } as unknown as typeof pairingModule,
    };

    await runProbe(["S0"], "http://127.0.0.1:9222", out.write, modules);

    // The origin, not the page: the store keys a decision by origin and a path would be a second site.
    expect(applied).toEqual([{ site: "https://en.wikipedia.org", mode: "skip-checks" }]);
    expect(written[0]?.siteModes).toEqual([
      "https://en.wikipedia.org → skip-checks (s4-wikipedia-typing)",
    ]);
  });

  /**
   * 004/T117b - the row an SC-036 scenario produces.
   *
   * The tree is captured in the same run, from the page the scenario names, and the row says what
   * the read did not carry. Before this the baseline column held the expectation string, so the
   * standard's comparison half had nothing behind it.
   */
  it("judges a tree-containment scenario against the tree it captured, naming what the read missed", async () => {
    const written: AcceptanceRun[] = [];
    const out = record();
    const scenario = { ...FAKE_SCENARIO, id: "s3-tree", expect: { kind: "tree-containment" as const } };
    const modules = {
      ...fakeModules([scenario], async () => [
        {
          ok: true as const,
          scenario: scenario.id,
          answer: {
            scenario: scenario.id,
            steps: [],
            observed: "read",
            fullRead: ["Overview", "Share"],
          },
          stdout: "",
        },
      ], written),
      baseline: {
        ...baselineModule,
        readPageTreeBaseline: async () => ({
          url: "https://example.com/",
          nodeCount: 40,
          frameCount: 2,
          sampleNames: [],
          named: { headings: ["Overview", "Evidence"], links: [], controls: ["Share"] },
        }),
      },
    };

    await runProbe(["S0"], "http://127.0.0.1:9222", out.write, modules);

    const row = (written[0]?.scenarios ?? [])[0];
    expect(row?.verdict).toBe("fail");
    expect(row?.observed).toContain('full read missing (headings/links) "Evidence"');
    expect(row?.observed).toContain("controls 1/1 in the full read");
    // The baseline column is now the page, not the expectation string.
    expect(row?.baseline).toContain("browser tree");
    expect(row?.baseline).toContain("40 nodes");
  });
});
