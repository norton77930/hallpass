import { readdir, readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ALLOWED_TOOLS, buildArgs, runConcurrently, runScenario } from "./agent-runner.js";
import type { ProbeChild, ProbeScenario, ProbeSpawner } from "./agent-runner.js";

/**
 * 004/T082 — the agent runner.
 *
 * `claude -p` costs the owner's quota, so nothing here spawns one: the spawner is a parameter and
 * every test passes a fake that answers from a literal. What is actually being pinned down is the
 * argument list (a wrong flag is a wasted paid run), the three ways an agent session can fail
 * without producing an answer, and the fact that concurrent scenarios get *separate* working
 * directories - one mcp-server per session is exactly the shape that reproduces the owner's E1.
 */

const SCENARIO: ProbeScenario = {
  id: "s0-first-call",
  slice: "S0",
  page: "about:blank",
  prompt: "Call tabs_context through hallpass and report what you saw.",
  answerSchema: { type: "object", properties: { scenario: { type: "string" } }, required: ["scenario"] },
  maxTurns: 8,
  timeoutMs: 120_000,
};

const PATHS = { mcpConfig: "D:/probe/.mcp.json" } as const;

const ANSWER = {
  scenario: "s0-first-call",
  steps: [{ tool: "tabs_context", args: {}, outcome: "ok", raw: "3 tabs" }],
  baseline: "3 tabs",
  observed: "3 tabs",
  notes: "first call answered",
};

type FakeAgent = {
  /** What the fake child writes on stdout before exiting; `undefined` means "never answers". */
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
};

type Recorded = { args: string[]; cwd: string; stdin: string; killed: boolean };

/**
 * A spawner that answers from a literal. It records what it was given so the assertions read the
 * call the way `claude` would have received it.
 */
function fakeSpawner(reply: (call: Recorded) => FakeAgent): { spawn: ProbeSpawner; calls: Recorded[]; live: number[] } {
  const calls: Recorded[] = [];
  const live: number[] = [];
  let concurrent = 0;

  const spawn: ProbeSpawner = (_command, args, options) => {
    const call: Recorded = { args: [...args], cwd: options.cwd, stdin: "", killed: false };
    calls.push(call);
    concurrent += 1;
    live.push(concurrent);

    const listeners: { stdout: Array<(c: string) => void>; stderr: Array<(c: string) => void>; exit: Array<(c: number | null) => void> } = {
      stdout: [],
      stderr: [],
      exit: [],
    };

    const child: ProbeChild = {
      stdin: {
        write: (chunk) => void (call.stdin += chunk),
        end: () => {
          const agent = reply(call);
          // Answer on the next tick so the caller has attached its listeners first.
          queueMicrotask(() => {
            if (agent.stdout !== undefined) {
              for (const listener of listeners.stdout) listener(agent.stdout);
            }
            if (agent.stderr !== undefined) {
              for (const listener of listeners.stderr) listener(agent.stderr);
            }
            if (agent.stdout === undefined && agent.stderr === undefined && agent.exitCode === undefined) {
              return; // the hung agent: no output, no exit
            }
            concurrent -= 1;
            for (const listener of listeners.exit) listener(agent.exitCode ?? 0);
          });
        },
      },
      onStdout: (cb) => void listeners.stdout.push(cb),
      onStderr: (cb) => void listeners.stderr.push(cb),
      onExit: (cb) => void listeners.exit.push(cb),
      kill: () => {
        call.killed = true;
        concurrent -= 1;
      },
    };
    return child;
  };

  return { spawn, calls, live };
}

/** A timer the test fires by hand, so a 120 s timeout costs no wall-clock time. */
function fakeTimer(): { schedule: (fn: () => void, ms: number) => { cancel: () => void }; fire: () => void; delays: number[] } {
  let pending: (() => void) | undefined;
  const delays: number[] = [];
  return {
    schedule: (fn, ms) => {
      delays.push(ms);
      pending = fn;
      return { cancel: () => void (pending = undefined) };
    },
    fire: () => pending?.(),
    delays,
  };
}

const temporaryRoots: string[] = [];

afterEach(() => {
  temporaryRoots.length = 0;
});

describe("probe-004 buildArgs", () => {
  it("builds the verified claude -p flag set for a scenario", () => {
    expect(buildArgs(SCENARIO, PATHS)).toEqual([
      "-p",
      "--model",
      "sonnet",
      "--effort",
      "low",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(SCENARIO.answerSchema),
      "--mcp-config",
      "D:/probe/.mcp.json",
      "--strict-mcp-config",
      "--allowedTools",
      ALLOWED_TOOLS,
      "--max-turns",
      "8",
      // Turns alone do not bound the spend; the dollar cap is the one the owner feels (brief B4).
      "--max-budget-usd",
      "0.5",
    ]);
  });

  it("allows both bridges' tools and nothing else", () => {
    expect(ALLOWED_TOOLS).toBe("mcp__hallpass__*,mcp__claude-in-chrome__*");
  });
});

describe("probe-004 runScenario", () => {
  it("feeds the prompt on stdin and parses the structured answer", async () => {
    const fake = fakeSpawner(() => ({ stdout: JSON.stringify({ type: "result", result: JSON.stringify(ANSWER) }) }));
    const outcome = await runScenario(SCENARIO, { spawn: fake.spawn, cwd: "D:/probe", paths: PATHS });

    expect(fake.calls[0]?.stdin).toBe(SCENARIO.prompt);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.answer).toEqual(ANSWER);
  });

  it("reports agent-error with the captured stderr on a non-zero exit", async () => {
    const fake = fakeSpawner(() => ({ stderr: "no such model", exitCode: 1 }));
    const outcome = await runScenario(SCENARIO, { spawn: fake.spawn, cwd: "D:/probe", paths: PATHS });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toBe("agent-error");
    expect(outcome.ok === false && outcome.detail).toContain("no such model");
  });

  it("reports agent-bad-output keeping the first 500 characters of unparseable stdout", async () => {
    const noise = "x".repeat(900);
    const fake = fakeSpawner(() => ({ stdout: noise }));
    const outcome = await runScenario(SCENARIO, { spawn: fake.spawn, cwd: "D:/probe", paths: PATHS });

    expect(outcome.ok === false && outcome.error).toBe("agent-bad-output");
    expect(outcome.ok === false && outcome.detail).toHaveLength(500);
  });

  it("reports agent-timeout and kills the child when no answer arrives in time", async () => {
    const fake = fakeSpawner(() => ({}));
    const timer = fakeTimer();
    const pending = runScenario(SCENARIO, { spawn: fake.spawn, cwd: "D:/probe", paths: PATHS, schedule: timer.schedule });

    await Promise.resolve();
    timer.fire();
    const outcome = await pending;

    expect(timer.delays).toEqual([SCENARIO.timeoutMs]);
    expect(outcome.ok === false && outcome.error).toBe("agent-timeout");
    expect(fake.calls[0]?.killed).toBe(true);
  });
});

describe("probe-004 runConcurrently", () => {
  it("runs k scenarios at once, each in its own working directory holding the probe's .mcp.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-004-test-"));
    temporaryRoots.push(root);
    const scenarios = [1, 2, 3].map((n) => ({ ...SCENARIO, id: `s0-session-${n}` }));
    const seen: Array<{ cwd: string; mcp: string }> = [];

    const fake = fakeSpawner((call) => {
      seen.push({ cwd: call.cwd, mcp: "" });
      return { stdout: JSON.stringify({ type: "result", result: JSON.stringify(ANSWER) }) };
    });

    const outcomes = await runConcurrently(scenarios, {
      spawn: fake.spawn,
      paths: PATHS,
      tempRoot: root,
      mcpConfig: '{"mcpServers":{"hallpass":{}}}',
    }, 3);

    expect(outcomes).toHaveLength(3);
    expect(Math.max(...fake.live)).toBe(3);

    const directories = new Set(seen.map((entry) => entry.cwd));
    expect(directories.size).toBe(3);

    // Each session got its own `.mcp.json`, and the temp root is empty again afterwards.
    expect(await readdir(root)).toEqual([]);
  });

  it("gives every session a working directory that contains the probe's .mcp.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-004-test-"));
    temporaryRoots.push(root);
    const contents: string[] = [];

    const fake = fakeSpawner((call) => {
      contents.push(call.cwd);
      return { stdout: JSON.stringify({ type: "result", result: JSON.stringify(ANSWER) }) };
    });

    let observed = "";
    await runConcurrently([SCENARIO], {
      spawn: fake.spawn,
      paths: PATHS,
      tempRoot: root,
      mcpConfig: '{"mcpServers":{"hallpass":{}}}',
      onWorkspaceReady: async (directory) => {
        observed = await readFile(join(directory, ".mcp.json"), "utf8");
      },
    }, 1);

    expect(observed).toBe('{"mcpServers":{"hallpass":{}}}');
    expect(contents[0]).toContain("probe-004-test-");
  });

  it("never runs more than k at once", async () => {
    const scenarios = [1, 2, 3, 4].map((n) => ({ ...SCENARIO, id: `s0-session-${n}` }));
    const root = await mkdtemp(join(tmpdir(), "probe-004-test-"));
    temporaryRoots.push(root);
    const fake = fakeSpawner(() => ({ stdout: JSON.stringify({ type: "result", result: JSON.stringify(ANSWER) }) }));

    await runConcurrently(scenarios, { spawn: fake.spawn, paths: PATHS, tempRoot: root, mcpConfig: "{}" }, 2);

    expect(Math.max(...fake.live)).toBe(2);
    expect(fake.calls).toHaveLength(4);
  });
});

/**
 * T111a — the cleanup that cost a paid run its evidence.
 *
 * The 2026-09-09 S0 run died here: Windows refused to remove a session's workspace with `EBUSY`
 * while the agent process it had just finished still held it as its cwd, the `finally` threw, and
 * the run never reached its report. A directory the probe cannot delete is litter; four observed
 * values are the run. So the removal retries, and then gives up *out loud* - the run continues and
 * the report names what was left behind.
 */
describe("probe-004 runConcurrently cleanup", () => {
  it("retries a workspace removal that fails, then leaves it behind instead of throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-004-test-"));
    temporaryRoots.push(root);
    const fake = fakeSpawner(() => ({ stdout: JSON.stringify({ type: "result", result: JSON.stringify(ANSWER) }) }));
    const attempts: string[] = [];
    const leftBehind: Array<{ directory: string; detail: string }> = [];

    const outcomes = await runConcurrently([SCENARIO], {
      spawn: fake.spawn,
      paths: PATHS,
      tempRoot: root,
      mcpConfig: "{}",
      cleanupRetryDelayMs: 0,
      removeWorkspace: async (directory) => {
        attempts.push(directory);
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${directory}'`), { code: "EBUSY" });
      },
      onWorkspaceLeftBehind: (directory, detail) => void leftBehind.push({ directory, detail }),
    }, 1);

    // The answer survived the failed cleanup, which is the whole point.
    expect(outcomes[0]?.ok).toBe(true);
    expect(attempts.length).toBeGreaterThan(1);
    expect(leftBehind).toHaveLength(1);
    expect(leftBehind[0]?.directory).toBe(attempts[0]);
    expect(leftBehind[0]?.detail).toContain("EBUSY");
  });
});
