import { win32 } from "node:path";
import type { AdapterLaunchSpec } from "./agents.js";
import { runCommand } from "./run-command.js";

/**
 * The broker's test-mode overrides (019 T526, T549, T564; 024 T791), honoured only with `HALLPASS_TEST_MODE=1`:
 *
 * - `HALLPASS_BROKER_TEST_AGENT`, a JSON argv that replaces every adapter launch, so the relay-process
 *   tests and the packaged gate run the fake ACP agent instead of an installed one;
 * - `HALLPASS_BROKER_TEST_IDLE_MS`, the idle limit (FR-297) in place of ten minutes, so the gate can
 *   watch an idle stop and the resume that follows (US4.3) - the "fake clock" of T564;
 * - `HALLPASS_BROKER_TEST_MACHINE` (024), the absolute path of a JSON file, read at every readiness
 *   check, saying what "the machine" holds - which agent programs, what their `--version` prints,
 *   Hermes' MCP component, Git Bash (`test-machine.ts`) - so the settings page's gate can show each
 *   agent in the state it chose. Only with the test agent: a made-up machine must not lead to a real
 *   launch;
 * - `HALLPASS_BROKER_TEST_INSTALL` (024), a JSON argv run in place of `npm ci`, in the install tree,
 *   with the install's own bound and cancel (`testInstallRun`), so the gate can watch a slow download's
 *   progress, its cancel and its interruption. Only with the test agent, as the machine.
 *
 * Anything else is no override. `codes` are the log codes the broker writes for what it read. None of
 * these names a test module: the fakes are programs the environment names.
 */
export type BrokerTestOverrides = {
  agent?: AdapterLaunchSpec;
  idleMs?: number;
  machineFile?: string;
  install?: TestCommand;
  codes: string[];
};

/** A command line from the environment: the program and its arguments. */
export type TestCommand = { command: string; args: string[] };

/** Bounds on the idle override: at least a second, at most a day. */
const IDLE_MIN_MS = 1_000;
const IDLE_MAX_MS = 24 * 60 * 60_000;

/** A JSON array of one or more strings, as a command line; undefined otherwise. */
function parseArgv(raw: string): TestCommand | undefined {
  let argv: unknown;
  try {
    argv = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === "string")) return undefined;
  const [command, ...args] = argv as string[];
  return { command: command!, args };
}

/** A drive or UNC path, nothing relative (`C:machine.json` is relative to that drive's folder). */
const isAbsoluteWindowsPath = (path: string): boolean => /^(?:[A-Za-z]:\\|\\\\)/u.test(path) && win32.isAbsolute(path) && !path.includes("\0");

export function readBrokerTestOverrides(env: Record<string, string | undefined>): BrokerTestOverrides {
  const overrides: BrokerTestOverrides = { codes: [] };
  if (env.HALLPASS_TEST_MODE !== "1") return overrides;

  const rawAgent = env.HALLPASS_BROKER_TEST_AGENT;
  if (rawAgent !== undefined && rawAgent.length > 0) {
    const argv = parseArgv(rawAgent);
    if (argv !== undefined) {
      overrides.agent = { command: argv.command, args: argv.args, env: {} };
      overrides.codes.push("broker.test-agent");
    } else {
      overrides.codes.push("broker.test-agent-invalid");
    }
  }

  const rawIdle = env.HALLPASS_BROKER_TEST_IDLE_MS;
  if (rawIdle !== undefined && rawIdle.length > 0) {
    const idleMs = /^\d+$/u.test(rawIdle) ? Number(rawIdle) : Number.NaN;
    if (Number.isSafeInteger(idleMs) && idleMs >= IDLE_MIN_MS && idleMs <= IDLE_MAX_MS) {
      overrides.idleMs = idleMs;
      overrides.codes.push("broker.test-idle");
    } else {
      overrides.codes.push("broker.test-idle-invalid");
    }
  }

  const rawMachine = env.HALLPASS_BROKER_TEST_MACHINE;
  if (rawMachine !== undefined && rawMachine.length > 0) {
    if (overrides.agent === undefined) overrides.codes.push("broker.test-machine-without-agent");
    else if (!isAbsoluteWindowsPath(rawMachine)) overrides.codes.push("broker.test-machine-invalid");
    else {
      overrides.machineFile = rawMachine;
      overrides.codes.push("broker.test-machine");
    }
  }

  const rawInstall = env.HALLPASS_BROKER_TEST_INSTALL;
  if (rawInstall !== undefined && rawInstall.length > 0) {
    // Only with the test agent, as the machine: a gate's environment sets them together.
    if (overrides.agent === undefined) overrides.codes.push("broker.test-install-without-agent");
    else {
      const argv = parseArgv(rawInstall);
      if (argv !== undefined) {
        overrides.install = argv;
        overrides.codes.push("broker.test-install");
      } else {
        overrides.codes.push("broker.test-install-invalid");
      }
    }
  }
  return overrides;
}

/**
 * 024: the install's `run` with `npm ci` replaced by `command` - whatever npm file and arguments the
 * install asks for - keeping what the install gave it: the tree as the working folder, its bound and
 * its cancel signal, so the install's own progress, verification, cancel and cleanup run as with npm.
 */
export function testInstallRun(command: TestCommand, run: typeof runCommand = runCommand): typeof runCommand {
  return (_file, _args, options) => run(command.command, command.args, options);
}
