/**
 * The acceptance report (004/T081, R-118, data-model `AcceptanceRun`).
 *
 * Every slice of 004 ends with a report rather than with a claim, so this file decides two things
 * the owner would otherwise have to check by hand: whether the slice is done (only when *every*
 * scenario passed - a `not-run` scenario is not a small gap, it is an unanswered question), and how
 * much of the agent's output is worth reading (its raw answer is signal on a failure and noise on a
 * pass).
 *
 * Both the markdown and the JSON are written from the same run object under the same stem, so the
 * human copy and the machine copy can never drift apart. The writer is a parameter with a real
 * default: the tests assert the produced text without touching the disk.
 */

export type ScenarioVerdict = "pass" | "fail" | "not-run";

/** Where a scenario's expected answer came from - the reference extension, or the browser's own tree (R-118). */
export type BaselineSource = "reference" | "browser-tree";

export type ScenarioResult = {
  id: string;
  page: string;
  baselineSource: BaselineSource;
  baseline: string;
  observed: string;
  verdict: ScenarioVerdict;
  /** The agent's structured answer, verbatim. Rendered only when the scenario did not pass. */
  rawAnswers?: string;
  /** Why a `not-run` scenario did not run. Required for `not-run`, meaningless otherwise. */
  reason?: string;
  /** When the reason is that the page changed, the page the scenario must be re-pointed at. */
  replacementPage?: string;
};

/** The environment table's contents; produced by `environment.ts` and copied into the run. */
export type AcceptanceEnvironment = {
  endpoint: string;
  browserVersion: string;
  extensionBuild: string;
  referenceVersion: string;
  bridgeInstall: string;
  claudeVersion: string;
  /** Found already accepted, or established by a warm-up session before the run (004/T111c). */
  pairing?: string;
  /** Other sessions' agent-bridge servers attached when the run started; any is a refusal (004/T167). */
  foreignAgentServers?: string;
  /**
   * The site modes the probe set for its scenarios, one line each (004/T129b).
   *
   * An assumption the run made about the browser, so it belongs beside the browser and the bridge: a
   * reader who cannot see it cannot tell a scenario that measured an effect from one that measured a
   * mode nobody set. Empty means the run decided nothing and every site answered as the owner left
   * it.
   */
  siteModes?: string[];
};

export type AcceptanceRun = AcceptanceEnvironment & {
  /** ISO-8601 UTC; the report's identity. */
  timestamp: string;
  slices: string[];
  /** Named environment problems, so a degraded run says what was missing instead of looking clean. */
  problems?: string[];
  /**
   * What the run had to survive, as opposed to what it measured (004/T111a).
   *
   * A session workspace Windows would not let the probe remove is the first of these: the run
   * carries on, and the directory left behind is named here so it is swept by hand rather than
   * discovered as a growing pile.
   */
  notes?: string[];
  scenarios: ScenarioResult[];
};

export type OverallVerdict = "done" | "not-done";

export type ReportPaths = { markdownPath: string; jsonPath: string; verdict: OverallVerdict };

/** Writes one file. The default reaches for `node:fs/promises`; tests pass a recorder. */
export type ReportWriter = (path: string, contents: string) => Promise<void>;

/**
 * `done` only when there is something to judge and all of it passed.
 *
 * An empty list is `not-done` on purpose: "no scenarios ran" is the shape a broken probe has, and it
 * must never be the shape a finished slice has.
 */
export function overallVerdict(scenarios: readonly ScenarioResult[]): OverallVerdict {
  if (scenarios.length === 0) {
    return "not-done";
  }
  return scenarios.every((scenario) => scenario.verdict === "pass") ? "done" : "not-done";
}

/**
 * The shared stem of the two files: `004-<UTC timestamp>` with the colons and the fractional
 * seconds removed, because a colon is not a legal character in a Windows filename.
 */
export function reportStem(timestamp: string): string {
  const utc = new Date(timestamp).toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-");
  return `004-${utc}`;
}

function environmentTable(run: AcceptanceRun): string[] {
  const rows: Array<[string, string]> = [
    ["Run", run.timestamp],
    ["Slices", run.slices.join(", ")],
    ["CDP endpoint", run.endpoint],
    ["Browser", run.browserVersion],
    ["Agent build", run.extensionBuild],
    ["Reference", run.referenceVersion],
    ["Bridge install", run.bridgeInstall],
    ["`claude` CLI", run.claudeVersion],
    ["Pairing", run.pairing ?? "not recorded"],
    ["Foreign agent servers", run.foreignAgentServers ?? "not checked"],
    ["Site modes", run.siteModes !== undefined && run.siteModes.length > 0 ? run.siteModes.join("; ") : "none set by the probe"],
  ];
  return ["| Item | Value |", "| --- | --- |", ...rows.map(([item, value]) => `| ${item} | ${value} |`)];
}

function scenarioSection(scenario: ScenarioResult): string[] {
  const lines = [
    `### ${scenario.id} — ${scenario.verdict}`,
    "",
    `- page: ${scenario.page}`,
    `- baseline (${scenario.baselineSource}): ${scenario.baseline}`,
    `- observed: ${scenario.observed === "" ? "—" : scenario.observed}`,
  ];

  if (scenario.verdict === "not-run") {
    lines.push(`- not run because: ${scenario.reason ?? "no reason recorded — treat as a probe bug"}`);
    if (scenario.replacementPage !== undefined) {
      lines.push(`- replacement page: ${scenario.replacementPage}`);
    }
  }

  // A passing agent answer is thousands of characters nobody reads; a failing one is the evidence.
  if (scenario.verdict !== "pass" && scenario.rawAnswers !== undefined) {
    lines.push("", "<details><summary>raw agent answer</summary>", "", "```json", scenario.rawAnswers, "```", "", "</details>");
  }

  lines.push("");
  return lines;
}

/** The human copy: environment first, verdict on one line, then a section per scenario. */
export function renderMarkdown(run: AcceptanceRun): string {
  const verdict = overallVerdict(run.scenarios);
  const lines = [
    `# Acceptance run 004 — ${run.slices.join(", ")}`,
    "",
    ...environmentTable(run),
    "",
    `**Verdict: ${verdict}** — ${run.scenarios.filter((s) => s.verdict === "pass").length}/${run.scenarios.length} scenarios passed.`,
    "",
  ];

  if (run.problems !== undefined && run.problems.length > 0) {
    lines.push("## Environment problems", "", ...run.problems.map((problem) => `- ${problem}`), "");
  }

  if (run.notes !== undefined && run.notes.length > 0) {
    lines.push("## Run notes", "", ...run.notes.map((note) => `- ${note}`), "");
  }

  lines.push("## Scenarios", "");
  if (run.scenarios.length === 0) {
    lines.push("No scenarios implemented yet for this slice.", "");
  }
  for (const scenario of run.scenarios) {
    lines.push(...scenarioSection(scenario));
  }

  return lines.join("\n");
}

const defaultWriter: ReportWriter = async (path, contents) => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
};

/** Writes `<directory>/004-<timestamp>.md` and `.json` and answers with both paths and the verdict. */
export async function writeReport(
  run: AcceptanceRun,
  directory: string,
  write: ReportWriter = defaultWriter,
): Promise<ReportPaths> {
  const stem = reportStem(run.timestamp);
  const separator = directory.endsWith("/") || directory.endsWith("\\") ? "" : "/";
  const markdownPath = `${directory}${separator}${stem}.md`;
  const jsonPath = `${directory}${separator}${stem}.json`;
  const verdict = overallVerdict(run.scenarios);

  await write(markdownPath, renderMarkdown(run));
  // The JSON keeps every raw answer, passing ones included: it is the machine copy, not the read.
  await write(jsonPath, `${JSON.stringify({ ...run, verdict }, undefined, 2)}\n`);

  return { markdownPath, jsonPath, verdict };
}
