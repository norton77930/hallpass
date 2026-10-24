import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 024 T791: the fake ACP agent with knobs a gate can change between steps.
 *
 * The broker's test agent (`HALLPASS_BROKER_TEST_AGENT`) is one fixed argv for every agent, and the
 * fake's `FAKE_ACP_*` variables reach it only through the browser's environment - fixed for the whole
 * browser run. So a gate that wants a working agent for one step and a failing one for the next
 * (quickstart L5: passed, then failed naming the model server) needs a level of indirection: this
 * wrapper reads `FAKE_ACP_SWITCH_FILE` (a JSON object of variable names to values, `null` removing
 * one) each time it is launched, lays it over its own environment, and runs `fake-acp-agent.ts` with
 * the same arguments and stdio. A missing or unreadable file changes nothing.
 *
 *     HALLPASS_BROKER_TEST_AGENT=["node","--experimental-strip-types","<checkout>/tests/harness/fake-acp-agent-switch.ts"]
 *     FAKE_ACP_SWITCH_FILE=<scratch>/fake-switch.json      e.g. {"FAKE_ACP_FAIL_AT":"prompt"}
 *
 * Imports only `node:` modules, so it runs under `--experimental-strip-types`.
 */

export function switchedEnvironment(
  base: Record<string, string | undefined>,
  switchFile: string | undefined,
): Record<string, string | undefined> {
  if (switchFile === undefined || switchFile === "") return { ...base };
  let overrides: unknown;
  try {
    overrides = JSON.parse(readFileSync(switchFile, "utf8"));
  } catch {
    return { ...base };
  }
  if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) return { ...base };
  const next = { ...base };
  for (const [name, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (value === null) delete next[name];
    else if (typeof value === "string") next[name] = value;
  }
  return next;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(self)) {
  const env = switchedEnvironment(process.env, process.env.FAKE_ACP_SWITCH_FILE);
  const child = spawn(process.execPath, ["--experimental-strip-types", join(dirname(self), "fake-acp-agent.ts"), ...process.argv.slice(2)], {
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  process.on("SIGTERM", forward);
  process.on("SIGINT", forward);
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal === null ? 0 : 1));
  });
}
