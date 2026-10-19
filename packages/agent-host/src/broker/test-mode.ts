import type { AdapterLaunchSpec } from "./agents.js";

/**
 * The broker's test-mode overrides (019 T526, T549, T564), honoured only with `HALLPASS_TEST_MODE=1`:
 *
 * - `HALLPASS_BROKER_TEST_AGENT`, a JSON argv that replaces every adapter launch, so the relay-process
 *   tests and the packaged gate run the fake ACP agent instead of an installed one;
 * - `HALLPASS_BROKER_TEST_IDLE_MS`, the idle limit (FR-297) in place of ten minutes, so the gate can
 *   watch an idle stop and the resume that follows (US4.3) - the "fake clock" of T564.
 *
 * Anything else is no override. `codes` are the log codes the broker writes for what it read.
 */
export type BrokerTestOverrides = { agent?: AdapterLaunchSpec; idleMs?: number; codes: string[] };

/** Bounds on the idle override: at least a second, at most a day. */
const IDLE_MIN_MS = 1_000;
const IDLE_MAX_MS = 24 * 60 * 60_000;

export function readBrokerTestOverrides(env: Record<string, string | undefined>): BrokerTestOverrides {
  const overrides: BrokerTestOverrides = { codes: [] };
  if (env.HALLPASS_TEST_MODE !== "1") return overrides;

  const rawAgent = env.HALLPASS_BROKER_TEST_AGENT;
  if (rawAgent !== undefined && rawAgent.length > 0) {
    let argv: unknown;
    try {
      argv = JSON.parse(rawAgent);
    } catch {
      argv = undefined;
    }
    if (Array.isArray(argv) && argv.length > 0 && argv.every((part) => typeof part === "string")) {
      const [command, ...args] = argv as string[];
      overrides.agent = { command: command!, args, env: {} };
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
  return overrides;
}
