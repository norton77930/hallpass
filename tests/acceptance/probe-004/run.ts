/**
 * Acceptance probe for feature 004 (T073 skeleton).
 *
 * The probe is 004's definition of done: it drives the owner's own Chrome 152 through `claude -p`
 * sessions and writes a report per slice (quickstart.md §5). This file is the CLI entry only - it
 * settles what to run and whether the environment can run it. The scenarios, the agent runner and
 * the report writer arrive with T080-T087; until then a fully configured run says so and exits 0,
 * which is deliberately not the same as passing.
 *
 * Run through `npm run probe:004 -- --slice S3` (or `--all`). It is executed by
 * `node --experimental-strip-types`, which resolves no `.js` specifier to a `.ts` file, while
 * `tsconfig.tests.json` sets `allowImportingTsExtensions: false`, so a literal `./report.ts` import
 * does not typecheck either. The way through is a **dynamic import of a URL built at run time**
 * (`loadProbeModule` below): Node loads and strips the sibling `.ts`, and TypeScript never resolves
 * a non-literal specifier, so neither side has to be fought. The helpers themselves import only
 * `node:` builtins and workspace packages, so nothing further down the chain needs the same trick,
 * and the unit tests import them normally through Vite.
 *
 * Exit codes: 0 ran, 1 a scenario failed (from T087), 2 the run was refused before it started.
 */

import { fileURLToPath } from "node:url";

/**
 * The `.mcp.json` a probe session is given: one server, `hallpass`, pointed at THIS checkout's
 * `packages/agent-host/dist/mcp-server.js` (008/T237). Built here rather than read from a committed
 * file: a checkout-specific `.mcp.json` is the maintainer's own (it names an absolute path and is not
 * published, 009/FR-128), and a probe run from a worktree must exercise the worktree's host, not the
 * main checkout's - the same trap the worktree's `node_modules` set for unit tests.
 */
export async function probeMcpConfig(repositoryRoot: string): Promise<string> {
  const { join } = await import("node:path");
  const config = {
    mcpServers: {
      hallpass: {
        command: "node",
        args: [join(repositoryRoot, "packages", "agent-host", "dist", "mcp-server.js")],
      },
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * The owner's slice order from plan.md; `--all` means exactly this list, in this order.
 * S7 and S8 are feature 005's two scenarios (form values, downloads), run through this same harness;
 * S9 (recording) and S10 (dialogs) are feature 008's (T237). S12 (viewport) is feature 012's; S13 (upload_image) is feature 013's (T346); S14 (site transition) is feature 014's (T391); S17 (session site plan) is feature 017's (T492); S18 (two browsers) is feature 018's (T514)
 * (T322); 011 had no probe scenario of its own, so there is no S11.
 */
export const PROBE_SLICES = ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S12", "S13", "S14", "S17", "S18"] as const;

export type ProbeSlice = (typeof PROBE_SLICES)[number];

export type ParsedArgs =
  | { ok: true; slices: ProbeSlice[] }
  | { ok: false; message: string };

const USAGE = [
  "usage: npm run probe:004 -- --slice <S0..S10, S12..S14, S17, S18>",
  "       npm run probe:004 -- --all",
  "",
  "  --slice <S0..S10, S12..S14, S17, S18>  run one slice's acceptance scenarios",
  "  --all             run every slice, in the order S0..S10, S12..S14, S17, S18",
  "",
  "  --slice and --all are mutually exclusive; exactly one is required.",
].join("\n");

const ENDPOINT_VARIABLE = "HALLPASS_CDP_ENDPOINT";

const ENDPOINT_MISSING = [
  `probe-004: ${ENDPOINT_VARIABLE} is not set - the probe attaches to the owner's Chrome, it never launches one.`,
  '  PowerShell: $env:HALLPASS_CDP_ENDPOINT = "http://127.0.0.1:9222"',
  "  Start that Chrome from the shortcut described in specs/004-reference-parity-bridge/quickstart.md §1",
  "  (one-time owner setup), then re-run.",
].join("\n");

function isProbeSlice(value: string): value is ProbeSlice {
  return (PROBE_SLICES as readonly string[]).includes(value);
}

/** Turns argv into the slice list, or into the reason the run is refused. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let all = false;
  let slice: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--all") {
      all = true;
      continue;
    }
    if (argument === "--slice") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, message: `probe-004: --slice needs a value (S0..S10, S12..S14, S17).\n\n${USAGE}` };
      }
      slice = value;
      index += 1;
      continue;
    }
    return { ok: false, message: `probe-004: unknown argument "${argument}".\n\n${USAGE}` };
  }

  if (all && slice !== undefined) {
    return { ok: false, message: `probe-004: --slice and --all cannot be combined.\n\n${USAGE}` };
  }
  if (all) {
    return { ok: true, slices: [...PROBE_SLICES] };
  }
  if (slice === undefined) {
    return { ok: false, message: USAGE };
  }
  if (!isProbeSlice(slice)) {
    return { ok: false, message: `probe-004: "${slice}" is not a slice; expected one of ${PROBE_SLICES.join(", ")}.\n\n${USAGE}` };
  }
  return { ok: true, slices: [slice] };
}

/** The whole CLI as a function, so the tests read its decisions without spawning a process. */
export function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  write: (line: string) => void,
): number {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    write(parsed.message);
    return 2;
  }

  const endpoint = env[ENDPOINT_VARIABLE];
  if (endpoint === undefined || endpoint.trim() === "") {
    write(ENDPOINT_MISSING);
    return 2;
  }

  write(`probe-004: endpoint ${endpoint}, slices ${parsed.slices.join(", ")}`);
  return 0;
}

/**
 * Loads a sibling helper.
 *
 * The specifier is built rather than written; see the note at the top of this file. The cast is the
 * price of that, and it is a small one: each helper's types are checked where they are used, which
 * is in its own test.
 */
async function loadProbeModule<T>(file: string): Promise<T> {
  return (await import(new URL(file, import.meta.url).href)) as T;
}

/**
 * The helpers `runProbe` works through, as one value.
 *
 * They are a parameter rather than six imports so the run's *own* decisions - does a report survive
 * a scenario that threw, does a repeated scenario run as often as it says - can be asserted without
 * a browser, an agent session or a dollar of the owner's quota. The real run passes nothing and gets
 * the real six.
 */
export type ProbeModules = {
  environment: typeof import("./environment.js");
  report: typeof import("./report.js");
  scenario: typeof import("./scenarios.js");
  runner: typeof import("./agent-runner.js");
  pairing: typeof import("./pairing.js");
  baseline: typeof import("./baseline.js");
};

async function loadProbeModules(): Promise<ProbeModules> {
  return {
    environment: await loadProbeModule<typeof import("./environment.js")>("./environment.ts"),
    report: await loadProbeModule<typeof import("./report.js")>("./report.ts"),
    scenario: await loadProbeModule<typeof import("./scenarios.js")>("./scenarios.ts"),
    runner: await loadProbeModule<typeof import("./agent-runner.js")>("./agent-runner.ts"),
    pairing: await loadProbeModule<typeof import("./pairing.js")>("./pairing.ts"),
    baseline: await loadProbeModule<typeof import("./baseline.js")>("./baseline.ts"),
  };
}

/**
 * The run itself: check the environment, run the slice's scenarios, write the report (T087).
 *
 * The environment check is not a formality: the probe is a statement about the owner's own machine,
 * so a missing extension or an uninstalled bridge refuses the run rather than producing a report
 * about a browser that was not the one under test.
 *
 * Everything after it is arranged around one rule - **a scenario that cannot run is recorded, not
 * skipped**. A browser the probe could not prepare, an agent that errored, an answer that did not
 * parse: each becomes a `not-run` or `fail` row with its reason, because the report is the
 * instrument every later slice is measured with and a missing row is a missing measurement.
 */
export async function runProbe(
  slices: readonly string[],
  endpoint: string,
  write: (line: string) => void,
  modules?: ProbeModules,
): Promise<number> {
  const {
    environment: environmentModule,
    report: reportModule,
    scenario: scenarioModule,
    runner: runnerModule,
    pairing: pairingModule,
    baseline: baselineModule,
  } = modules ?? (await loadProbeModules());

  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const probeRoot = fileURLToPath(new URL("./", import.meta.url));
  const deps = await environmentModule.realEnvironmentDeps(
    endpoint,
    repositoryRoot,
    realPairingProbe({ endpoint, repositoryRoot, probeRoot, write, environmentModule, pairingModule, runnerModule }),
  );
  const { problems, ...table } = await environmentModule.checkEnvironment(deps);
  const timestamp = new Date().toISOString();

  const notes: string[] = [];
  // What the run decided about the owner's sites before it measured anything (004/T129b).
  const siteModes: string[] = [];
  const finish = async (scenarios: import("./report.js").ScenarioResult[]): Promise<number> => {
    const run = { timestamp, slices: [...slices], ...table, problems, notes, siteModes, scenarios };
    const paths = await reportModule.writeReport(run, `${probeRoot}reports`);
    write(reportModule.renderMarkdown(run));
    write(`probe-004: report ${paths.markdownPath}`);
    write(`probe-004: report ${paths.jsonPath}`);
    write(`probe-004: verdict ${paths.verdict}`);
    return paths.verdict === "done" ? 0 : 1;
  };

  if (problems.length > 0) {
    write(`probe-004: refusing to run — ${problems.length} environment problem(s).`);
    await finish([]);
    return 2;
  }

  const results: import("./report.js").ScenarioResult[] = [];
  const context: ScenarioContext = {
    endpoint,
    repositoryRoot,
    probeRoot,
    write,
    note: (line) => void notes.push(line),
    recordSiteMode: (line) => void siteModes.push(line),
    scenarioModule,
    runnerModule,
    pairingModule,
    baselineModule,
    environmentModule,
  };

  /**
   * Every scenario, and then the report - **whatever the scenarios did** (004/T111a).
   *
   * The catch is the whole point of the shape: on 2026-09-09 four paid S0 sessions ran, answered,
   * and were thrown away because the code between them and `finish` raised. A run that reached its
   * scenarios now always leaves a report, and the thing that stopped it is a row in it rather than
   * a stack trace on a console nobody kept.
   */
  try {
    for (const slice of slices) {
      const scenarios = await scenarioModule.loadScenarios(`${probeRoot}scenarios`, slice);
      for (const scenario of scenarios) {
        // A repeated scenario is one claim measured several times (SC-031's five pairing runs), so
        // it runs whole - setup included - once per repetition and answers with a single row.
        const repeat = Math.max(1, scenario.repeat ?? 1);
        const attempts: import("./report.js").ScenarioResult[] = [];
        for (let index = 0; index < repeat; index += 1) {
          const of = repeat === 1 ? "" : ` run ${index + 1}/${repeat}`;
          write(`probe-004: running ${scenario.id} (${scenario.evidence})${of}`);
          attempts.push(await runOneScenario(scenario, context));
        }
        results.push(repeat === 1 ? attempts[0]! : mergeRepeats(attempts));
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    write(`probe-004: the run stopped early — ${detail}`);
    results.push({
      id: "probe-run",
      page: "—",
      baselineSource: "browser-tree",
      baseline: "the run reaches every scenario of its slices",
      observed: detail,
      verdict: "not-run",
      reason: `the run stopped early: ${detail}`,
    });
  }

  // An open DevTools socket keeps Node alive; the tree baseline holds one per page it read.
  baselineModule.closeBaselineSockets?.();
  return await finish(results);
}

/**
 * The warm-up session, and why it is a session (004/T111c).
 *
 * It is the smallest thing that raises a `pair-request`: one tool call, three turns, a few cents. The
 * accept is scheduled *alongside* it rather than before it, exactly as `s2-pairing-20s` does, because
 * B27 established that the CDP helper can only answer a request already in flight - with nothing
 * pending there is no request to answer and the seeded record does not become the owner's decision.
 *
 * The warm-up's own answer is not read: whether it worked is decided by re-reading the durable record
 * afterwards, which is the same question the next scenario's first call will ask.
 */
const WARM_UP_ACCEPT_MS = 8_000;

export function realPairingProbe(context: {
  endpoint: string;
  repositoryRoot: string;
  probeRoot: string;
  write: (line: string) => void;
  environmentModule: typeof import("./environment.js");
  pairingModule: typeof import("./pairing.js");
  runnerModule: typeof import("./agent-runner.js");
}): import("./environment.js").PairingProbe {
  const pairingDeps = {
    endpoint: context.endpoint,
    extensionId: context.environmentModule.AGENT_EXTENSION_ID,
    fetch: (url: string) => fetch(url),
    evaluate: context.pairingModule.realEvaluate,
  };

  return {
    agentId: async () => {
      const { hostDataDirectory } = await import("@hallpass/agent-host");
      return context.pairingModule.readAgentId(hostDataDirectory(process.env));
    },
    isPaired: (agentId) => context.pairingModule.isAgentPaired(pairingDeps, agentId),
    establish: async (agentId) => {
      context.write(`probe-004: ${agentId} is not paired — running a warm-up session to raise the request`);
      const accepting = context.pairingModule.acceptPairingAfter(
        pairingDeps,
        {
          agentId,
          displayName: "Claude Code (probe warm-up)",
          origin: "probe-004",
          acceptedAt: new Date().toISOString(),
        },
        WARM_UP_ACCEPT_MS,
      );

      try {
        await context.runnerModule.runConcurrently(
          [
            {
              id: "warm-up-pairing",
              slice: "warm-up",
              page: "about:blank",
              prompt:
                "You are a probe warm-up. Call mcp__hallpass__tabs_context once, with no arguments, then answer with JSON matching the schema: scenario = \"warm-up-pairing\", steps = one entry with the tool name and the result (or its error) truncated to 200 characters, observed = \"warmed\". Do not explain and do not retry.",
              answerSchema: {
                type: "object",
                additionalProperties: false,
                required: ["scenario", "steps", "observed"],
                properties: {
                  scenario: { type: "string" },
                  steps: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["tool", "outcome"],
                      properties: { tool: { type: "string" }, outcome: { type: "string" } },
                    },
                  },
                  observed: { type: "string" },
                },
              },
              maxTurns: 3,
              maxBudgetUsd: 0.2,
              timeoutMs: 120_000,
            },
          ],
          {
            spawn: context.runnerModule.defaultSpawner,
            paths: { mcpConfig: ".mcp.json" },
            tempRoot: `${context.probeRoot}reports/.sessions`,
            mcpConfig: await probeMcpConfig(context.repositoryRoot),
            onWorkspaceLeftBehind: (directory, detail) =>
              context.write(`probe-004: warm-up workspace left behind — ${directory} (${detail})`),
          },
          1,
        );
      } catch (error) {
        return { established: false, detail: `the warm-up session failed: ${error instanceof Error ? error.message : String(error)}` };
      }

      const accept = await accepting;
      const paired = await context.pairingModule.isAgentPaired(pairingDeps, agentId).catch(() => false);
      return paired
        ? { established: true, detail: accept.detail }
        : { established: false, detail: `the record still has no pairing after the warm-up (${accept.detail})` };
    },
  };
}

/**
 * The repetitions of one scenario, as the one row the report shows (004/T111a).
 *
 * `pass` only when every repetition passed: the file asked for the same claim N times because one
 * run of it does not settle it, and a row that reported the last answer would be the probe deciding
 * which run counted.
 */
export function mergeRepeats(
  attempts: readonly import("./report.js").ScenarioResult[],
): import("./report.js").ScenarioResult {
  const total = attempts.length;
  const label = (index: number) => `run ${index + 1}/${total}`;
  const reasons = attempts
    .map((attempt, index) => (attempt.reason === undefined ? undefined : `${label(index)}: ${attempt.reason}`))
    .filter((reason): reason is string => reason !== undefined);

  return {
    ...attempts[0]!,
    observed: attempts.map((attempt, index) => `${label(index)}: ${attempt.observed === "" ? "—" : attempt.observed}`).join("; "),
    verdict: attempts.every((attempt) => attempt.verdict === "pass")
      ? "pass"
      : attempts.some((attempt) => attempt.verdict === "fail")
        ? "fail"
        : "not-run",
    ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
    rawAnswers: attempts
      .map((attempt, index) => `// ${label(index)}: ${attempt.rawAnswers ?? "(no answer recorded)"}`)
      .join("; "),
  };
}

/**
 * The origin one scenario's page belongs to - the key `site-mode-store` uses (004/T129b).
 *
 * `URL.origin` rather than a hand-assembled scheme and host, for the reason the store gives: it
 * already knows a default port is not written out, and two spellings of one site would be two
 * records with the owner's decision on only one of them.
 */
export function siteOfPage(page: string): string | undefined {
  try {
    const origin = new URL(page).origin;
    return origin === "null" || origin === "" ? undefined : origin;
  } catch {
    return undefined;
  }
}

type ScenarioContext = {
  endpoint: string;
  repositoryRoot: string;
  probeRoot: string;
  write: (line: string) => void;
  /** Adds a line to the report's own notes - what the run had to survive, not what it measured. */
  note: (line: string) => void;
  /** Adds a site the run decided for itself to the environment table (004/T129b). */
  recordSiteMode: (line: string) => void;
  scenarioModule: typeof import("./scenarios.js");
  runnerModule: typeof import("./agent-runner.js");
  pairingModule: typeof import("./pairing.js");
  baselineModule: typeof import("./baseline.js");
  environmentModule: typeof import("./environment.js");
};

/** How long the T137 before-capture waits for its own tab to settle before reading the tree. */
const CONTAINMENT_BEFORE_CAPTURE_WAIT_MS = 6_000;

/**
 * One scenario end to end: prepare the browser, run the session(s), judge the answer.
 *
 * The concurrent case is not a loop with a pool bolted on - `runConcurrently` gives each session its
 * own working directory, which is the only way `claude` starts one mcp-server per session, which is
 * the whole of what E1 is about. A concurrent scenario passes only when *every* session passed, and
 * the row names which ones did not.
 */
async function runOneScenario(
  scenario: import("./scenarios.js").ProbeScenarioFile,
  context: ScenarioContext,
): Promise<import("./report.js").ScenarioResult> {
  const { endpoint, probeRoot, write } = context;
  const pairingDeps = {
    endpoint,
    extensionId: context.environmentModule.AGENT_EXTENSION_ID,
    fetch: (url: string) => fetch(url),
    evaluate: context.pairingModule.realEvaluate,
  };

  const notRun = (reason: string): import("./report.js").ScenarioResult => ({
    id: scenario.id,
    page: scenario.page,
    baselineSource: "browser-tree" as const,
    baseline: context.scenarioModule.expectationLabel(scenario.expect),
    observed: "",
    verdict: "not-run" as const,
    reason,
  });

  // --- prepare the browser ---------------------------------------------------------------
  let ownerTabId: string | undefined;
  try {
    if (scenario.setup?.resetPairing === true) {
      await context.pairingModule.resetPairing(pairingDeps);
      write(`probe-004: ${scenario.id} pairing state cleared`);
    }
    /**
     * The site's mode, before any session starts (004/T129b).
     *
     * Keyed by the *origin* of the page the scenario names, because that is how `site-mode-store`
     * keys a decision; a path would be a second site the owner never decided about. A mode that
     * could not be set is a note rather than a refusal - the scenario still runs, and the report
     * says the site was left as the owner had it, so a prompt timing out afterwards reads as this
     * and not as a product failure.
     */
    if (typeof scenario.setup?.siteMode === "string") {
      const site = siteOfPage(scenario.page);
      if (site === undefined) {
        context.note(`${scenario.id}: no site mode set — ${scenario.page} has no origin to decide about`);
      } else {
        const outcome = await context.pairingModule.setSiteMode(pairingDeps, site, scenario.setup.siteMode);
        context.recordSiteMode(
          `${site} → ${outcome.set ? scenario.setup.siteMode : `not set (${outcome.detail})`} (${scenario.id})`,
        );
        write(`probe-004: ${scenario.id} site mode — ${outcome.detail}`);
      }
    }
    if (typeof scenario.setup?.openOwnerTab === "string") {
      // Opened by the probe over CDP, so it is a tab the agent's session did not create - which is
      // exactly the tab E3 says 003 cannot see.
      const opened = await fetch(`${endpoint}/json/new?${scenario.setup.openOwnerTab}`, { method: "PUT" });
      const target = (await opened.json()) as { id?: string };
      ownerTabId = target.id;
      write(`probe-004: ${scenario.id} opened owner tab ${scenario.setup.openOwnerTab}`);
    }
  } catch (error) {
    return notRun(`browser preparation failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  /**
   * The names the prompt hands the agent, and where they come from (004/T137).
   *
   * A capture taken **before** the session runs, deliberately separate from the one T117b already
   * takes **after** it - the module comment above `run.ts`'s `judgeContainment` call explains why both
   * are kept. Only a scenario whose prompt actually carries the placeholder pays for this: it opens
   * its own short-lived tab over CDP (the same `/json/new` + `/json/close` shape `openOwnerTab` uses
   * above), because there is nothing else open to this page yet - the agent's own `tabs_create` is
   * still a step in the prompt this capture is building.
   */
  let containmentBefore: import("./baseline.js").PageTreeBaseline | undefined;
  let sessionPrompt = scenario.prompt;
  if (
    scenario.expect.kind === "tree-containment" &&
    scenario.prompt.includes(context.scenarioModule.CONTAINMENT_NAMES_PLACEHOLDER)
  ) {
    try {
      const opened = await fetch(`${endpoint}/json/new?${scenario.page}`, { method: "PUT" });
      const target = (await opened.json()) as { id?: string };
      // The same settle time the scenario's own steps ask for once the agent opens the page itself -
      // this capture needs it loaded, not merely requested.
      await new Promise((resolve) => setTimeout(resolve, CONTAINMENT_BEFORE_CAPTURE_WAIT_MS));
      containmentBefore = await context.baselineModule.readPageTreeBaseline(
        { endpoint, fetch: (url: string) => fetch(url), send: context.baselineModule.realSend },
        scenario.page,
      );
      if (target.id !== undefined) {
        await fetch(`${endpoint}/json/close/${target.id}`).catch(() => undefined);
      }
    } catch (error) {
      context.note(`${scenario.id}: before-capture not taken — ${error instanceof Error ? error.message : String(error)}`);
    }
    if (containmentBefore === undefined) {
      context.note(`${scenario.id}: the prompt's candidate-names placeholder was left unfilled — no before-capture`);
    } else {
      sessionPrompt = scenario.prompt.replace(
        context.scenarioModule.CONTAINMENT_NAMES_PLACEHOLDER,
        context.scenarioModule
          .buildCandidateNames(containmentBefore)
          .map((name) => `"${name}"`)
          .join(", "),
      );
    }
  }

  // The delayed accept runs alongside the session, not before it: the point of E2 is what the
  // in-flight call does while the owner is still reading the prompt.
  let accepting: Promise<{ accepted: boolean; detail: string }> | undefined;
  if (typeof scenario.setup?.acceptPairingAfterMs === "number") {
    const { hostDataDirectory } = await import("@hallpass/agent-host");
    const agentId = await context.pairingModule.readAgentId(hostDataDirectory(process.env));
    accepting =
      agentId === undefined
        ? Promise.resolve({ accepted: false, detail: "no agent-id file; the bridge has never run" })
        : context.pairingModule.acceptPairingAfter(
            pairingDeps,
            { agentId, displayName: "Claude Code (probe)", origin: "probe-004", acceptedAt: new Date().toISOString() },
            scenario.setup.acceptPairingAfterMs,
          );
  }

  /**
   * The relay kill, scheduled rather than awaited (SC-030): the sessions are already running when
   * their browser-side piece dies, which is the only way the "next call succeeds within 10 s" claim
   * can be measured at all. Chrome respawns the host on the worker's next connect.
   */
  let killed: Promise<string> | undefined;
  if (typeof scenario.setup?.killRelayAfterMs === "number") {
    const delay = scenario.setup.killRelayAfterMs;
    killed = new Promise<string>((resolve) => {
      setTimeout(async () => {
        try {
          const { execFile } = await import("node:child_process");
          const script =
            "$ErrorActionPreference='SilentlyContinue'; " +
            "$p = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*native-host.js*' }); " +
            "foreach ($proc in $p) { Stop-Process -Id $proc.ProcessId -Force }; " +
            "if ($p.Count -gt 0) { 'relay-killed' } else { 'relay-absent' }; exit 0";
          execFile("powershell", ["-NoProfile", "-Command", script], (_error, stdout) => {
            const detail = `relay kill at ${delay} ms: ${String(stdout).trim()}`;
            write(`probe-004: ${scenario.id} ${detail}`);
            resolve(detail);
          });
        } catch (error) {
          resolve(`relay kill failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }, delay);
    });
  }

  /**
   * The one-session kill (004/T099b, FR-058): the same shape as the relay kill above, aimed at one
   * agent session instead of the browser's side of the bridge. The session it takes is the one the
   * file marked `expected-killed`, found by start order, and the note records the pid and how many
   * servers were running so a run that killed the wrong one reads as such in the report.
   */
  let killedServer: Promise<string> | undefined;
  if (typeof scenario.setup?.killServerAfterMs === "number") {
    const delay = scenario.setup.killServerAfterMs;
    const target = Math.max(
      0,
      (scenario.sessions ?? []).findIndex((session) => session.judge === "expected-killed"),
    );
    killedServer = new Promise<string>((resolve) => {
      setTimeout(async () => {
        try {
          const { execFile } = await import("node:child_process");
          const script =
            "$ErrorActionPreference='SilentlyContinue'; " +
            "$p = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*mcp-server.js*' } | Sort-Object CreationDate); " +
            `if ($p.Count -gt ${target}) { $victim = $p[${target}]; Stop-Process -Id $victim.ProcessId -Force; ` +
            "'server-killed pid=' + $victim.ProcessId + ' of ' + $p.Count } " +
            "else { 'server-absent of ' + $p.Count }; exit 0";
          execFile("powershell", ["-NoProfile", "-Command", script], (_error, stdout) => {
            const detail = `session #${target + 1} server kill at ${delay} ms: ${String(stdout).trim()}`;
            write(`probe-004: ${scenario.id} ${detail}`);
            resolve(detail);
          });
        } catch (error) {
          resolve(`server kill failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }, delay);
    });
  }

  // --- run the session(s) ----------------------------------------------------------------
  // `sessionPrompt` is `scenario.prompt` unchanged for every scenario that carries no T137
  // placeholder, so this substitution is a no-op for all of them.
  const concurrency = scenario.concurrency ?? 1;
  const copies = Array.from({ length: concurrency }, (_, index) => ({
    ...scenario,
    ...(concurrency === 1 ? {} : { id: `${scenario.id}#${index + 1}` }),
    prompt: sessionPrompt,
  }));
  const outcomes = await context.runnerModule.runConcurrently(
    copies,
    {
      spawn: context.runnerModule.defaultSpawner,
      // Relative on purpose: `runConcurrently` writes this file into each session's own workspace,
      // and the spawner uses `shell: true` on Windows, which splits an absolute path at a space in
      // the repository path (the first live run's five refused sessions).
      paths: { mcpConfig: ".mcp.json" },
      tempRoot: `${probeRoot}reports/.sessions`,
      mcpConfig: await probeMcpConfig(context.repositoryRoot),
      // A workspace Windows would not let go of is litter, and litter is never worth a run's
      // evidence: it is named in the report and swept by hand (T111a).
      onWorkspaceLeftBehind: (directory, detail) =>
        context.note(`${scenario.id}: session workspace left behind — ${directory} (${detail})`),
    },
    concurrency,
  );

  const pairingNote = accepting === undefined ? undefined : (await accepting).detail;
  const killNote = killed === undefined ? undefined : await killed;
  const serverKillNote = killedServer === undefined ? undefined : await killedServer;
  if (ownerTabId !== undefined) {
    await fetch(`${endpoint}/json/close/${ownerTabId}`).catch(() => undefined);
  }

  // --- judge -----------------------------------------------------------------------------
  // SC-036 (T117b): the page's own tree, read now, from the page this scenario names - the same
  // run, so what is compared is the page the session actually saw and not one read minutes later.
  let tree: import("./baseline.js").PageTreeBaseline | undefined;
  if (scenario.expect.kind === "tree-containment") {
    try {
      tree = await context.baselineModule.readPageTreeBaseline(
        { endpoint, fetch: (url: string) => fetch(url), send: context.baselineModule.realSend },
        scenario.page,
      );
    } catch (error) {
      context.note(`${scenario.id}: browser tree not captured — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const containment = outcomes.map((outcome) =>
    scenario.expect.kind === "tree-containment" && outcome.ok
      ? context.scenarioModule.judgeContainment(tree, outcome.answer, containmentBefore, context.scenarioModule.CONTAINMENT_DECOYS)
      : undefined,
  );

  // 005/T187 B19: the path a scenario names is checked here, on the owner's disk, after the caller
  // returned - the caller's sandbox cannot see it. The check is beside the word check, not in place
  // of it: both have to hold.
  const { existsSync } = await import("node:fs");
  const files = outcomes.map((outcome) =>
    outcome.ok ? context.scenarioModule.judgeFile(scenario, outcome.answer, existsSync) : undefined,
  );

  const observed = outcomes.map((outcome, index) =>
    outcome.ok
      ? [containment[index]?.detail ?? outcome.answer.observed, files[index]?.detail].filter((part) => part !== undefined).join("; ")
      : `${outcome.error}: ${outcome.detail.slice(0, 200)}`,
  );
  const verdicts = outcomes.map((outcome, index) =>
    outcome.ok &&
    (containment[index]?.verdict ?? context.scenarioModule.judge(scenario.expect, outcome.answer.observed)) === "pass" &&
    files[index]?.verdict !== "fail"
      ? "pass"
      : "fail",
  );
  // T099b: what each session was for, so a session the scenario killed on purpose is reported
  // beside its answer and left out of the verdict.
  const roles = copies.map((_, index) => context.scenarioModule.sessionJudge(scenario, index));

  return {
    id: scenario.id,
    page: scenario.page,
    baselineSource: "browser-tree",
    baseline:
      scenario.expect.kind === "tree-containment"
        ? `${scenario.evidence}: browser tree of ${tree?.url ?? scenario.page} — ${tree?.nodeCount ?? 0} nodes, ${tree?.frameCount ?? 0} frames, ${tree?.named.headings.length ?? 0} headings, ${tree?.named.links.length ?? 0} links, ${tree?.named.controls.length ?? 0} controls`
        : `${scenario.evidence}: ${context.scenarioModule.expectationLabel(scenario.expect)}`,
    observed: observed
      .map(
        (value, index) =>
          `${copies[index]!.id}${roles[index] === "expected-killed" ? " [expected-killed]" : ""} → ${value}`,
      )
      .join("; "),
    verdict: context.scenarioModule.scenarioVerdict(verdicts, roles),
    rawAnswers: JSON.stringify(
      {
        pairing: pairingNote,
        relayKill: killNote,
        serverKill: serverKillNote,
        outcomes: outcomes.map((outcome) => (outcome.ok ? outcome.answer : outcome)),
      },
      undefined,
      2,
    ),
  };
}

if (import.meta.main) {
  const lines: string[] = [];
  const write = (line: string) => void lines.push(line);
  let code = main(process.argv.slice(2), process.env, write);

  if (code === 0) {
    const parsed = parseArgs(process.argv.slice(2));
    try {
      code = await runProbe(parsed.ok ? parsed.slices : [], process.env[ENDPOINT_VARIABLE] ?? "", write);
    } catch (error) {
      // An unreachable browser is fatal by design (environment.ts); it is a refusal, not a failure.
      write(error instanceof Error ? error.message : String(error));
      code = 2;
    }
  }

  // A refusal belongs on stderr: `npm run probe:004` is called from scripts that read stdout.
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(`${lines.join("\n")}\n`);
  process.exit(code);
}
