/**
 * Scenario loading and judging (004/T086, T087).
 *
 * A scenario is a file, not code, for one reason: the S0 files are written to *fail* on the 003
 * build and to be re-run unchanged as the S1-S3 acceptance scenarios. If the expectation lived in
 * code it would be edited when the behaviour changed, and the run that proves the fix would no
 * longer be the run that measured the failure.
 *
 * So the judgement here is deliberately thin - it compares the agent's own `observed` string against
 * the expectation the file carries. Everything clever belongs in the prompt, where the agent can be
 * told exactly what to report.
 */

import { SITE_MODES, type SiteMode } from "@hallpass/contracts";

import type { ProbeAnswer, ProbeScenario } from "./agent-runner.js";
import type { PageTreeBaseline } from "./baseline.js";

export type ScenarioExpectation =
  | { kind: "observed-equals"; value: string }
  | { kind: "observed-contains"; value: string }
  /**
   * SC-036, as a verdict the harness reaches (004/T117b).
   *
   * The other two kinds compare a word the agent wrote against a word the file carries, which is
   * why the acceptance standard's "compared against the baseline" had no machinery behind it. This
   * kind is judged against the browser's own tree for the scenario's page, captured in the same
   * run: **containment**, not a ratio. It carries no `value` - what it expects is the page.
   */
  | { kind: "tree-containment" };

/**
 * What one session of a scenario is there to prove (004/T099b).
 *
 * `pass` is every session's role unless the file says otherwise. `expected-killed` names a session
 * the scenario destroys on purpose: its answer is recorded because it is evidence of what a dying
 * session looks like, but the claim being measured is about the sessions that survive it, so it
 * does not decide the verdict. Without this a scenario could not kill anything - the runner
 * required every session to pass, which made a deliberate kill indistinguishable from a defect.
 */
export type SessionJudge = "pass" | "expected-killed";

const SESSION_JUDGES: readonly string[] = ["pass", "expected-killed"];

/** A scenario file: the runner's part, plus what the report needs and how it is judged. */
export type ProbeScenarioFile = ProbeScenario & {
  /** Which of the owner's 2026-09-09 failures this reproduces (E1-E4), or the task that added it. */
  evidence: string;
  expect: ScenarioExpectation;
  maxBudgetUsd: number;
  /** How many sessions run at once. `3` is E1's reproduction; absent means one. */
  concurrency?: number;
  /**
   * How many times the whole scenario runs, one after another (004/T111a, SC-031).
   *
   * Not `concurrency` with another name: `concurrency` starts several sessions against **one**
   * preparation, which is meaningless for a scenario whose preparation is "unpair, then accept
   * after 20 s". A repetition redoes the setup and the session, and the scenario's row is judged on
   * all of them, so "five pairing runs in a row all did this" is one invocation and one answer.
   */
  repeat?: number;
  /**
   * What each session is for, in the order the sessions are numbered (`#1`, `#2`, ...).
   * A session the file says nothing about has to pass.
   */
  sessions?: Array<{ judge: SessionJudge }>;
  /** Prepare the browser before the sessions start. */
  setup?: {
    /** Clear the durable pairing state first (E2). */
    resetPairing?: boolean;
    /**
     * The owner's standing decision for the scenario's own site, set before the sessions start
     * (004/T129b).
     *
     * A site nobody has decided about is `ask`, and every effect on it becomes a prompt only the
     * owner's side panel can answer - so an unattended effect scenario measures a prompt timing out
     * rather than the hover, the keystroke or the reference it was written for. This is the same
     * class of environment step as the pairing the probe already establishes for itself, and the
     * run records what it set.
     *
     * A scenario that is *about* consent names `ask` here or says nothing at all: its claim is the
     * prompt, and a mode set for it would delete the very thing it measures.
     */
    siteMode?: SiteMode;
    /** Seed the pairing after this many ms, standing in for the owner's reading time (E2). */
    acceptPairingAfterMs?: number;
    /** Open this page over CDP so it is an owner tab the agent did not create (E3). */
    openOwnerTab?: string;
    /**
     * Kill the relay Chrome spawned this many ms after the sessions start (SC-030).
     *
     * It runs alongside the session for the same reason the delayed accept does: the claim is about
     * what a *live* session's next call does after the browser-side piece dies, so a kill before the
     * session started would measure a cold start instead.
     */
    killRelayAfterMs?: number;
    /**
     * Kill the mcp-server of the `expected-killed` session this many ms after the sessions start
     * (FR-058, SC-030).
     *
     * The relay kill above takes the browser's side away from everyone; this takes one *agent*
     * session away from the browser, which is the other half of the claim: the survivor keeps
     * working and never inherits the dead session's tab. Which process belongs to which session is
     * read from their start order - the sessions are spawned in order, so the oldest `mcp-server.js`
     * is session `#1` - and the kill says out loud how many it found and which pid it took, so a
     * run that killed the wrong one is visible in the report rather than silently passing.
     */
    killServerAfterMs?: number;
  };
  /**
   * The answer field carrying a path the harness checks for existence after the caller returns
   * (005/T187 B19, SC-042 "exists on disk").
   *
   * The caller is `claude -p` sandboxed to its own workspace: it cannot see the owner's Downloads
   * folder, so a check it made would measure its sandbox and not the download. The extension
   * reports the path; the caller copies it into this field; the run looks. A scenario that names
   * no field is judged as before.
   */
  verifyFile?: string;
  /** What the same file expects once the slice that fixes it lands; recorded, never asserted here. */
  expectedAfterFix?: string;
};

const REQUIRED = ["id", "slice", "evidence", "page", "prompt", "answerSchema", "expect"] as const;

/** Parses one scenario file, naming the field that is wrong rather than failing on `undefined`. */
export function parseScenarioFile(source: unknown, path: string): ProbeScenarioFile {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new Error(`probe-004: ${path} is not a scenario object`);
  }
  const record = source as Record<string, unknown>;
  for (const field of REQUIRED) {
    if (record[field] === undefined) {
      throw new Error(`probe-004: ${path} is missing "${field}"`);
    }
  }
  const expect = record.expect as { kind?: unknown };
  if (expect.kind !== "observed-equals" && expect.kind !== "observed-contains" && expect.kind !== "tree-containment") {
    throw new Error(`probe-004: ${path} has an unknown expect.kind "${String(expect.kind)}"`);
  }
  const setup = record.setup as { siteMode?: unknown } | undefined;
  if (setup?.siteMode !== undefined && !(SITE_MODES as readonly string[]).includes(String(setup.siteMode))) {
    // Named, not defaulted: a mode the extension has no such thing as would be written into the
    // store, read back by the contract, dropped, and the scenario would meet the `ask` prompt it
    // declared a mode to avoid - with nothing in the report saying why.
    throw new Error(
      `probe-004: ${path} has an unknown setup.siteMode "${String(setup.siteMode)}"; expected one of ${SITE_MODES.join(", ")}`,
    );
  }
  const repeat = record.repeat;
  if (repeat !== undefined && (typeof repeat !== "number" || !Number.isInteger(repeat) || repeat < 1)) {
    throw new Error(`probe-004: ${path} has a "repeat" that is not a whole number of runs ("${String(repeat)}")`);
  }
  const sessions = record.sessions;
  if (sessions !== undefined) {
    if (!Array.isArray(sessions)) {
      throw new Error(`probe-004: ${path} has a "sessions" that is not a list`);
    }
    sessions.forEach((session, index) => {
      const value = (session as { judge?: unknown }).judge;
      if (!SESSION_JUDGES.includes(String(value))) {
        throw new Error(`probe-004: ${path} has an unknown sessions[${index}].judge "${String(value)}"`);
      }
    });
  }
  if (record.verifyFile !== undefined && (typeof record.verifyFile !== "string" || record.verifyFile === "")) {
    throw new Error(`probe-004: ${path} has a "verifyFile" that is not a field name ("${String(record.verifyFile)}")`);
  }
  const scenario = record as unknown as ProbeScenarioFile;
  // Defaults, not overrides: a scenario file that forgets a bound still gets one, and the bound is
  // the owner's quota, so it is never absent.
  //
  // T129d: the turn default is high because turns are not the bound that matters. `maxBudgetUsd` is
  // the real guard - it stops a session at the money, wherever in the work that falls - while a turn
  // count that does not fit the steps stops it *mid tool call*, which spends the money and buys no
  // observation. That is exactly what twelve did to both S4 scenarios at $0.34 of a $0.50 cap. Forty
  // is above what a seven-step scenario plus its environment turns takes; a scenario that wants to
  // be stopped sooner still says so.
  return {
    ...scenario,
    maxTurns: scenario.maxTurns ?? 40,
    maxBudgetUsd: scenario.maxBudgetUsd ?? 0.5,
    timeoutMs: scenario.timeoutMs ?? 240_000,
  };
}

/** The slice's scenarios, in filename order so a report reads the same way twice. */
export async function loadScenarios(directory: string, slice: string): Promise<ProbeScenarioFile[]> {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const scenarios: ProbeScenarioFile[] = [];
  for (const name of names) {
    const path = join(directory, name);
    const parsed = parseScenarioFile(JSON.parse(await readFile(path, "utf8")), path);
    if (parsed.slice === slice) {
      scenarios.push(parsed);
    }
  }
  return scenarios;
}

/** `pass` only when the agent reported what the file expects; anything else is the measurement. */
export function judge(expect: ScenarioExpectation, observed: string): "pass" | "fail" {
  if (expect.kind === "tree-containment") {
    throw new Error("probe-004: a tree-containment scenario is judged by judgeContainment, not by judge");
  }
  if (expect.kind === "observed-equals") {
    return observed.trim() === expect.value ? "pass" : "fail";
  }
  return observed.includes(expect.value) ? "pass" : "fail";
}

/**
 * The file check a scenario asked for (`verifyFile`), or nothing when it asked for none. `exists`
 * is injected so the test never touches a disk; the run passes `fs.existsSync`.
 */
export function judgeFile(
  scenario: ProbeScenarioFile,
  answer: ProbeAnswer,
  exists: (path: string) => boolean,
): { verdict: "pass" | "fail"; detail: string } | undefined {
  if (scenario.verifyFile === undefined) return undefined;
  const path = (answer as unknown as Record<string, unknown>)[scenario.verifyFile];
  if (typeof path !== "string" || path === "") {
    return { verdict: "fail", detail: `no path reported in ${scenario.verifyFile}` };
  }
  return exists(path) ? { verdict: "pass", detail: `file exists: ${path}` } : { verdict: "fail", detail: `file missing: ${path}` };
}

/** How an expectation reads in a report row, for the kinds that carry no word of their own. */
export function expectationLabel(expect: ScenarioExpectation): string {
  if (expect.kind === "observed-equals") {
    return 'expected = "' + expect.value + '"';
  }
  if (expect.kind === "observed-contains") {
    return 'expected ~ "' + expect.value + '"';
  }
  return "expected: the page's own headings, links and controls in the full read (SC-036 Amendment 2)";
}

export type ContainmentOutcome = { verdict: "pass" | "fail"; detail: string };

/**
 * Names match on their **text** (004/T117b, T129a).
 *
 * The tree and the read reach the same string by different routes, so a name is reduced to what a
 * person reads before the two sides are compared: private-use characters and formatting characters
 * go (the extension names a control with a trailing private-use icon glyph the browser's tree does
 * not carry, and the 2026-09-09 run scored 4 of 4 only because the agent silently transcribed the
 * visible text without it - raw containment was 3 of 4), every run of whitespace becomes one space,
 * and case is folded. A check whose answer depends on what an agent chose to copy is not a check.
 *
 * Nothing else is stripped. Punctuation, digits and accents are part of the name, and removing them
 * would start matching names the page never had.
 */
const normalise = (name: string): string =>
  name
    .replace(/[\p{Co}\p{Cf}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

function missingFrom(expected: readonly string[], reported: readonly string[]): string[] {
  const seen = new Set(reported.map(normalise));
  return expected.filter((name) => !seen.has(normalise(name)));
}

/** The names of `names` that do appear in `reported` - `missingFrom`'s complement. */
function presentIn(names: readonly string[], reported: readonly string[]): string[] {
  const seen = new Set(reported.map(normalise));
  return names.filter((name) => seen.has(normalise(name)));
}

const quote = (names: readonly string[], limit = 5): string =>
  names
    .slice(0, limit)
    .map((name) => '"' + name + '"')
    .join(", ") + (names.length > limit ? ` and ${names.length - limit} more` : "");

/** A page's own names, the three roles SC-036 cares about pooled into one list (004/T137). */
function everyNamedNode(tree: PageTreeBaseline): string[] {
  return [...tree.named.headings, ...tree.named.links, ...tree.named.controls];
}

/**
 * Two names guaranteed to be on no real page (004/T137).
 *
 * "Ask which of these is missing" can be passed by an agent that never really read anything - report
 * nothing missing and every genuine name is trivially "found". The decoys close that hole: handed to
 * the agent exactly like the genuine names, they have to be noticed absent. A decoy the agent fails
 * to list is an agent that answered without looking, so `judgeContainment` fails the scenario on it
 * regardless of how the genuine names came out.
 */
export const CONTAINMENT_DECOYS = ["Quazzleworth Compliance Ledger", "Effendorf Diagnostic Toggle 9042"] as const;

/** The token a tree-containment scenario's prompt carries; `run.ts` fills it in before the run. */
export const CONTAINMENT_NAMES_PLACEHOLDER = "{{CANDIDATE_NAMES}}";

/**
 * The candidate list a `notFound`-shaped tree-containment scenario hands the agent (004/T137).
 *
 * The genuine names are `before`'s own headings, links and controls - a capture taken ahead of the
 * session, because the session itself is what puts the page in front of the agent. The decoys are
 * appended after them. The agent is asked only which of this whole list it cannot find; it is never
 * asked to transcribe the page, which is the difference between this and the shape it replaces - a
 * transcript's completeness depends on what the agent chose to copy, and copying is not evidence
 * (the run that produced "21 missing" when the truth was 7).
 */
export function buildCandidateNames(before: PageTreeBaseline): string[] {
  return [...everyNamedNode(before), ...CONTAINMENT_DECOYS];
}

/**
 * SC-036: is the page contained in what the session reported? (004/T117b, Amendment 2 2026-09-10,
 * T137 2026-09-10)
 *
 * Two answer shapes are judged here, told apart by whether `answer.notFound` is present:
 *
 * - **The transcript shape** (`fullRead`) - `s3-artifact-frame` still asks for it: every heading,
 *   link and control the browser's tree names has to be in the copy the agent made.
 * - **The `notFound` shape** (T137) - `s5-github-capacity` moved to it because the transcript
 *   question produced a false answer ("21 missing" when the truth was 7): the agent is handed a
 *   candidate list up front and asked only what is missing from it, decoys included (see
 *   `buildCandidateNames`).
 *
 * `before` and `decoys` are only read by the `notFound` shape; a `fullRead` answer ignores them, so a
 * scenario that has not moved to T137's shape can call this exactly as before.
 *
 * A missing baseline is a failure with its own words either way, because a vacuous baseline would
 * otherwise be a vacuous pass - containment of nothing holds.
 */
export function judgeContainment(
  after: PageTreeBaseline | undefined,
  answer: ProbeAnswer,
  before?: PageTreeBaseline,
  decoys: readonly string[] = CONTAINMENT_DECOYS,
): ContainmentOutcome {
  if (after === undefined) {
    return { verdict: "fail", detail: "no browser tree was captured for this page, so nothing was compared" };
  }
  return answer.notFound === undefined
    ? judgeFullReadContainment(after, answer)
    : judgeNotFoundContainment(before, after, decoys, answer.notFound);
}

/** The transcript shape, unchanged from before T137 (004/T117b, Amendment 2). */
function judgeFullReadContainment(after: PageTreeBaseline, answer: ProbeAnswer): ContainmentOutcome {
  const fullExpected = [...after.named.headings, ...after.named.links];
  const controls = after.named.controls;

  if (answer.fullRead === undefined) {
    return {
      verdict: "fail",
      detail: `the answer reported no full read (the page names ${fullExpected.length} headings and links, ${controls.length} controls)`,
    };
  }

  const parts: string[] = [];
  let verdict: "pass" | "fail" = "pass";

  const missingHeadingsLinks = missingFrom(fullExpected, answer.fullRead);
  parts.push(`headings+links ${fullExpected.length - missingHeadingsLinks.length}/${fullExpected.length} in the full read`);
  if (missingHeadingsLinks.length > 0) {
    verdict = "fail";
    parts.push(`full read missing (headings/links) ${quote(missingHeadingsLinks)}`);
  }

  const missingControls = missingFrom(controls, answer.fullRead);
  parts.push(`controls ${controls.length - missingControls.length}/${controls.length} in the full read`);
  if (missingControls.length > 0) {
    verdict = "fail";
    parts.push(`full read missing (controls) ${quote(missingControls)}`);
  }

  return { verdict, detail: parts.join("; ") };
}

/**
 * The `notFound` shape (004/T137): judged against the intersection of two captures, on purpose.
 *
 * The prompt's genuine names come from `before`, read ahead of the session. The truth this judges
 * against is `after`, captured once the session is done - the same rule T117b already established for
 * the transcript shape, kept here. **The trap**: a name `before` carries but `after` does not would
 * make an agent that correctly reports it absent read as wrong, if it were judged - a page can change
 * while the session runs. So a genuine name is judged only when **both** captures agree it was there;
 * one that only ever existed in one of them decides nothing, either way.
 *
 * The decoys carry no such caveat - neither capture ever has them, because they were never on the
 * page - so their rule is unconditional: both must be in `notFound`, every time.
 */
function judgeNotFoundContainment(
  before: PageTreeBaseline | undefined,
  after: PageTreeBaseline,
  decoys: readonly string[],
  notFound: readonly string[],
): ContainmentOutcome {
  if (before === undefined) {
    return { verdict: "fail", detail: "no browser tree was captured before the run, so the genuine names could not be checked" };
  }

  const genuine = presentIn(everyNamedNode(before), everyNamedNode(after));
  const falselyMissing = presentIn(genuine, notFound);
  const missingDecoys = missingFrom(decoys, notFound);

  const parts: string[] = [];
  let verdict: "pass" | "fail" = "pass";

  parts.push(`genuine names ${genuine.length - falselyMissing.length}/${genuine.length} reported found`);
  if (falselyMissing.length > 0) {
    verdict = "fail";
    parts.push(`wrongly reported not found ${quote(falselyMissing)}`);
  }

  parts.push(`decoys ${decoys.length - missingDecoys.length}/${decoys.length} correctly reported not found`);
  if (missingDecoys.length > 0) {
    verdict = "fail";
    parts.push(`decoys missing from notFound ${quote(missingDecoys)}`);
  }

  return { verdict, detail: parts.join("; ") };
}

/** What session `index` is for; a session the file does not describe has to pass. */
export function sessionJudge(scenario: ProbeScenarioFile, index: number): SessionJudge {
  return scenario.sessions?.[index]?.judge ?? "pass";
}

/**
 * The scenario's own verdict from its sessions' verdicts and their roles.
 *
 * Every session that had to pass did, and there was at least one: a file whose sessions are all
 * `expected-killed` measures nothing, and answering `pass` to that would be a report about a claim
 * nobody made.
 */
export function scenarioVerdict(
  verdicts: readonly ("pass" | "fail")[],
  roles: readonly SessionJudge[],
): "pass" | "fail" {
  const deciding = verdicts.filter((_, index) => (roles[index] ?? "pass") === "pass");
  return deciding.length > 0 && deciding.every((verdict) => verdict === "pass") ? "pass" : "fail";
}
