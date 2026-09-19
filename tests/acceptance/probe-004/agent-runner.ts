/**
 * The agent runner (004/T083, R-118).
 *
 * A scenario is answered by a real coding agent, not by a test harness: that is the whole point of
 * the probe, because a harness cannot reproduce one mcp-server per session (E1) or the client's own
 * call bound (E2). Every such run costs the owner's quota, so this file is built to be exercised
 * without one - the spawner is a parameter whose default is the real `claude`, and the tests pass a
 * fake that answers from a literal.
 *
 * ## The flag set, verified against `claude --help` on 2.1.266 (2026-09-09)
 *
 * `-p`, `--model`, `--effort`, `--output-format json`, `--mcp-config`, `--strict-mcp-config` and
 * `--allowedTools` are all documented as R-118 assumed. Two corrections to R-118:
 *
 * - `--json-schema` takes the **schema itself as JSON text**, not a path: the CLI parses the value
 *   and refuses with "--json-schema is not valid JSON". The scenario therefore carries the schema
 *   as data and it is stringified into the argument.
 * - `--max-turns <turns>` exists but is hidden from `--help`. It is a real, parsed option, so the
 *   quota bound R-118 asked for is kept.
 *
 * `--allowedTools` takes a comma-separated list and matches patterns (`Bash(git *)` in its own help
 * text; `mcp__claude-in-chrome__*` and `mcp__*__*` appear as permission patterns in the CLI), so the
 * two servers are allowed wholesale and nothing else is.
 */

import { spawn } from "node:child_process";

/** Both bridges, and only those: the reference supplies the baseline, `hallpass` the observation. */
export const ALLOWED_TOOLS = "mcp__hallpass__*,mcp__claude-in-chrome__*";

export const AGENT_COMMAND = "claude";

/** The per-scenario spend cap when a scenario file does not set its own (brief B4). */
export const DEFAULT_MAX_BUDGET_USD = 0.5;

export type ProbeScenario = {
  id: string;
  slice: string;
  /** The page the scenario is about; recorded in the report, opened by the agent itself. */
  page: string;
  prompt: string;
  /** The JSON Schema the answer must satisfy, as data (see the note above about `--json-schema`). */
  answerSchema: unknown;
  maxTurns: number;
  /**
   * The hard dollar cap for this one session (`--max-budget-usd`, verified on 2.1.266).
   *
   * `--max-turns` alone does not bound the spend - one turn can read a large page - and every
   * scenario here runs on the owner's own quota, so the cap travels with the scenario rather than
   * being a global the runner remembers.
   */
  maxBudgetUsd?: number;
  timeoutMs: number;
  /** When true the scenario is one of several run at once (the multi-session reproductions). */
  concurrent?: boolean;
};

export type ProbePaths = { mcpConfig: string };

/** The agent's structured answer (contracts/README.md §5). */
export type ProbeAnswer = {
  scenario: string;
  steps: Array<{ tool: string; args: unknown; outcome: string; raw?: unknown }>;
  baseline?: string;
  observed: string;
  notes?: string;
  /**
   * What a tree-containment scenario saw, in a form the harness can compare (004/T117b).
   *
   * `fullRead` is every name the "return the whole page" read gave back; SC-036 Amendment 2
   * (2026-09-10) judges headings, links **and** controls against it. `defaultRead` is kept for the
   * report's own record (it is not viewport-comparable to the browser's ungated tree) but is no
   * longer part of the containment verdict. The scenario's own answer schema is what asks for them,
   * so no other scenario is made to carry them.
   */
  fullRead?: string[];
  defaultRead?: string[];
  /**
   * The T137 shape: the names, from the candidate list the prompt handed the agent, that it could
   * not find on the page. Present only on a scenario that asks the cheaper question; a scenario that
   * still asks for a transcript carries `fullRead`/`defaultRead` instead, never both.
   */
  notFound?: string[];
};

export type ScenarioFailure = "agent-error" | "agent-bad-output" | "agent-timeout";

export type ScenarioOutcome =
  | { ok: true; scenario: string; answer: ProbeAnswer; stdout: string }
  | { ok: false; scenario: string; error: ScenarioFailure; detail: string };

/**
 * The slice of a child process this runner needs.
 *
 * It is deliberately narrower than `ChildProcess`: a fake that satisfies this is a few lines, and a
 * fake nobody minds writing is what keeps the tests off the owner's quota.
 */
export type ProbeChild = {
  stdin: { write: (chunk: string) => void; end: () => void };
  onStdout: (listener: (chunk: string) => void) => void;
  onStderr: (listener: (chunk: string) => void) => void;
  onExit: (listener: (code: number | null) => void) => void;
  kill: () => void;
};

export type ProbeSpawner = (command: string, args: readonly string[], options: { cwd: string }) => ProbeChild;

/** A cancellable delay, so a two-minute timeout costs a test nothing. */
export type Schedule = (callback: () => void, ms: number) => { cancel: () => void };

export type RunScenarioDeps = {
  spawn: ProbeSpawner;
  cwd: string;
  paths: ProbePaths;
  schedule?: Schedule | undefined;
};

/** How much of an unusable answer is worth keeping in the report. */
const RAW_KEEP = 500;

const defaultSchedule: Schedule = (callback, ms) => {
  const handle = setTimeout(callback, ms);
  return { cancel: () => clearTimeout(handle) };
};

/**
 * The real spawner: the only place in the probe that can start a paid agent session.
 *
 * **No `shell`.** The first two live runs (2026-09-09) both died in it: `cmd.exe` split the
 * repository path at the space it contains, and then ate the quotes inside the
 * `--json-schema` value ("--json-schema is not valid JSON"). `claude` is a real `.exe` on this
 * machine, so libuv finds it on PATH without a shell and every argument reaches it verbatim, which
 * is what a schema and a multi-line prompt need.
 */
export const defaultSpawner: ProbeSpawner = (command, args, options) => {
  const child = spawn(command, [...args], { cwd: options.cwd });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  return {
    stdin: {
      write: (chunk) => void child.stdin?.write(chunk),
      end: () => void child.stdin?.end(),
    },
    onStdout: (listener) => void child.stdout?.on("data", listener),
    onStderr: (listener) => void child.stderr?.on("data", listener),
    onExit: (listener) => void child.on("close", listener),
    kill: () => void child.kill(),
  };
};

/** The exact argument list a scenario turns into. Asserted, not run. */
export function buildArgs(scenario: ProbeScenario, paths: ProbePaths): string[] {
  return [
    "-p",
    "--model",
    "sonnet",
    "--effort",
    "low",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(scenario.answerSchema),
    "--mcp-config",
    paths.mcpConfig,
    "--strict-mcp-config",
    "--allowedTools",
    ALLOWED_TOOLS,
    "--max-turns",
    String(scenario.maxTurns),
    "--max-budget-usd",
    String(scenario.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD),
  ];
}

/**
 * Digs the scenario answer out of `--output-format json`.
 *
 * The CLI answers with its own envelope and puts the structured answer in `result` (as text) or in
 * `structured_output`; both are accepted, and so is a bare answer, because the shape that matters is
 * the scenario answer, not the envelope that carried it.
 */
export function parseAnswer(stdout: string): ProbeAnswer | undefined {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }

  const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

  const outer = record(envelope);
  let candidate: unknown = outer?.structured_output ?? outer?.structuredOutput ?? outer?.result ?? envelope;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }

  const answer = record(candidate);
  if (answer === undefined || typeof answer.scenario !== "string" || !Array.isArray(answer.steps)) {
    return undefined;
  }
  return answer as unknown as ProbeAnswer;
}

/**
 * One agent session for one scenario.
 *
 * The prompt goes in on stdin rather than as an argument: it is long, it is multi-line, and a
 * command line is one more parser between the scenario file and the agent.
 */
export function runScenario(scenario: ProbeScenario, deps: RunScenarioDeps): Promise<ScenarioOutcome> {
  const schedule = deps.schedule ?? defaultSchedule;
  const child = deps.spawn(AGENT_COMMAND, buildArgs(scenario, deps.paths), { cwd: deps.cwd });

  return new Promise<ScenarioOutcome>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = schedule(() => {
      if (settled) {
        return;
      }
      settled = true;
      // A hung session holds an mcp-server and a debugger attachment; it is killed, not waited out.
      child.kill();
      resolve({
        ok: false,
        scenario: scenario.id,
        error: "agent-timeout",
        detail: `no answer within ${scenario.timeoutMs} ms`,
      });
    }, scenario.timeoutMs);

    child.onStdout((chunk) => void (stdout += chunk));
    child.onStderr((chunk) => void (stderr += chunk));
    child.onExit((code) => {
      if (settled) {
        return;
      }
      settled = true;
      timer.cancel();

      if (code !== 0 && code !== null) {
        resolve({
          ok: false,
          scenario: scenario.id,
          error: "agent-error",
          detail: `exit ${code}: ${(stderr || stdout).slice(0, RAW_KEEP)}`,
        });
        return;
      }

      const answer = parseAnswer(stdout);
      if (answer === undefined) {
        resolve({ ok: false, scenario: scenario.id, error: "agent-bad-output", detail: stdout.slice(0, RAW_KEEP) });
        return;
      }
      resolve({ ok: true, scenario: scenario.id, answer, stdout });
    });

    child.stdin.write(scenario.prompt);
    child.stdin.end();
  });
}

export type RunConcurrentlyDeps = {
  spawn: ProbeSpawner;
  paths: ProbePaths;
  /** Where the per-session working directories are created; they are removed again afterwards. */
  tempRoot: string;
  /** The `.mcp.json` every session gets a copy of. */
  mcpConfig: string;
  schedule?: Schedule | undefined;
  /** Test seam: called once per prepared workspace, before its agent is spawned. */
  onWorkspaceReady?: (directory: string) => Promise<void>;
  /** Removes one finished workspace. A parameter so the retry policy is testable without a busy directory. */
  removeWorkspace?: (directory: string) => Promise<void>;
  /** Told about a workspace the retries could not remove, so the report can name it (T111a). */
  onWorkspaceLeftBehind?: (directory: string, detail: string) => void;
  /** How long to wait between removal attempts; 0 in tests. */
  cleanupRetryDelayMs?: number;
};

/** How many times a workspace removal is tried before the directory is left behind. */
export const CLEANUP_ATTEMPTS = 4;

const CLEANUP_RETRY_DELAY_MS = 250;

/**
 * Removes the finished workspaces, and never throws (004/T111a).
 *
 * This is where the 2026-09-09 S0 run died: Windows answers `EBUSY` when a directory is still some
 * process's cwd, the removal threw out of the `finally`, and a paid run lost all four of its
 * observed values on the way out. A directory the probe could not delete is litter and litter is
 * not worth a run, so the removal is retried - the holding process usually exits in the meantime -
 * and then given up on out loud: the caller is told which directory was left behind and the report
 * says so.
 */
async function removeWorkspaces(directories: readonly string[], deps: RunConcurrentlyDeps): Promise<void> {
  const { rm } = await import("node:fs/promises");
  const remove = deps.removeWorkspace ?? ((directory: string) => rm(directory, { recursive: true, force: true }));
  const delay = deps.cleanupRetryDelayMs ?? CLEANUP_RETRY_DELAY_MS;

  for (const directory of directories) {
    let failure: unknown;
    for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        await remove(directory);
        failure = undefined;
        break;
      } catch (error) {
        failure = error;
        if (attempt < CLEANUP_ATTEMPTS && delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    if (failure !== undefined) {
      const code = (failure as { code?: string }).code;
      const message = failure instanceof Error ? failure.message : String(failure);
      deps.onWorkspaceLeftBehind?.(
        directory,
        `${code ?? "error"} after ${CLEANUP_ATTEMPTS} attempts: ${message}`,
      );
    }
  }
}

/**
 * Runs `k` scenarios at once, each in its **own** working directory.
 *
 * The separate directories are the point, not a tidiness habit: `claude` starts one mcp-server per
 * session per project, so sessions sharing a directory would share a server and the run would prove
 * nothing about the failure the owner actually hit (E1). Every workspace is prepared before any
 * agent starts, so the pool is genuinely `k` wide from the first moment.
 */
export async function runConcurrently(
  scenarios: readonly ProbeScenario[],
  deps: RunConcurrentlyDeps,
  k: number,
): Promise<ScenarioOutcome[]> {
  const { mkdir, mkdtemp, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  await mkdir(deps.tempRoot, { recursive: true });

  const workspaces: string[] = [];
  for (const scenario of scenarios) {
    const directory = await mkdtemp(join(deps.tempRoot, `${scenario.id}-`));
    await writeFile(join(directory, ".mcp.json"), deps.mcpConfig, "utf8");
    await deps.onWorkspaceReady?.(directory);
    workspaces.push(directory);
  }

  const outcomes: ScenarioOutcome[] = new Array(scenarios.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < scenarios.length) {
      const index = next;
      next += 1;
      // `runScenario` spawns before its first await, so a pool of `k` workers is `k` live sessions.
      outcomes[index] = await runScenario(scenarios[index]!, {
        spawn: deps.spawn,
        cwd: workspaces[index]!,
        paths: deps.paths,
        schedule: deps.schedule,
      });
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(k, scenarios.length)) }, worker));
  } finally {
    await removeWorkspaces(workspaces, deps);
  }

  return outcomes;
}
