import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join, win32 } from "node:path";
import { CONVERSATION_AGENTS, type ConversationAgent, type ConversationError } from "@hallpass/contracts";
import { isProcessAlive } from "../bridge-link.js";
import { ADAPTER_NPM_CI_ARGS, AGENT_DESCRIPTIONS, adapterDirectory, packagePin } from "./agents.js";
import { redactedTail } from "./redact.js";
import type { runCommand } from "./run-command.js";

/**
 * The first-use install of the pinned ACP adapter (019/T532, T533; R-314), on the owner's consent -
 * and, the same way, of a fetched ACP agent (021 R-345: DeepSeek). An installed program (Hermes) is
 * never downloaded.
 *
 * Hallpass writes no download or hashing code of its own: the installed Node's npm runs
 * `npm ci` against the `package.json` + `package-lock.json` Hallpass ships, which checks every
 * tarball against the lockfile's `integrity` hash and so refuses anything altered or unpinned.
 * The command line is the agent's (`npmCiArgs`): for an adapter `--omit=optional` leaves out its
 * bundled CLI (the owner's own CLI is used, R-315); a fetched agent keeps its optional dependencies,
 * which hold its platform native bindings (R-357). `--ignore-scripts` means no install script runs.
 *
 * The work happens in `agents\<agent>\.staging-<broker pid>-<random>` and the folder is renamed to
 * `agents\<agent>\<adapter version>` only after the pinned adapter is verified inside it, so a
 * folder with that name is always a complete install. Any failure removes the staging folder
 * (FR-300); `cleanStaging` removes what a crash of the broker itself left behind.
 *
 * Progress is phases only. npm prints no byte counts to a pipe, so the panel shows an indeterminate
 * bar with the expected size (R-314); `InstallProgress.bytes` is there for a runner that can tell.
 */

/** The adapters' `npm ci` command line (R-314); a fetched agent's is its own (R-357). */
export const NPM_CI_ARGS: readonly string[] = ADAPTER_NPM_CI_ARGS;

const STAGING_PREFIX = ".staging-";
const DETAIL_MAX = 600;

/**
 * The shipped `agents` folder, from the folder of the broker's entry: beside it in the package's
 * flat `host/` (`host/broker.js` + `host/agents`), else beside that folder in the dev build
 * (`packages/agent-host/dist/broker.js` + `packages/agent-host/agents`).
 */
export function shippedManifestsDirectory(
  entryDir: string,
  isDirectory: (path: string) => boolean = (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true,
): string {
  const beside = join(entryDir, "agents");
  return isDirectory(beside) ? beside : join(entryDir, "..", "agents");
}

export type InstallPhase = "preparing" | "downloading" | "finishing";
export type InstallProgress = { phase: InstallPhase; bytes?: number };

export type InstallPorts = {
  /** `%LOCALAPPDATA%\hallpass`. */
  dataDir: string;
  /** The shipped `agents` folder: `<agent>\package.json` + `package-lock.json`. */
  manifestsDir: string;
  /** The node whose npm runs (`process.execPath`); `npm.cmd` is looked for next to it. */
  nodePath: string;
  /** Runs a command to completion (injected in tests). */
  run: typeof runCommand;
  randomSuffix?: () => string;
};

export type InstallResult = { ok: true; directory: string } | { ok: false; error: ConversationError };

const failure = (detail: string): InstallResult => ({
  ok: false,
  error: { code: "install-failed", detail: detail.slice(0, DETAIL_MAX) },
});

const isFile = (path: string) =>
  stat(path).then(
    (info) => info.isFile(),
    () => false,
  );

const removeTree = (path: string) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

/** The pinned package's package.json inside an `npm ci` tree, or undefined. */
async function pinnedAdapterPresent(agent: ConversationAgent, tree: string): Promise<boolean> {
  const adapter = packagePin(agent);
  if (adapter === undefined) return false;
  try {
    const manifest = JSON.parse(
      await readFile(win32.join(tree, "node_modules", ...adapter.package.split("/"), "package.json"), "utf8"),
    ) as { version?: unknown };
    return manifest.version === adapter.version;
  } catch {
    return false;
  }
}

/** `npm.cmd` next to the running node, else the one on the PATH (R-314). */
async function npmCommand(nodePath: string): Promise<string> {
  const beside = win32.join(win32.dirname(nodePath), "npm.cmd");
  return (await isFile(beside)) ? beside : "npm.cmd";
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function installAgent(
  agent: ConversationAgent,
  ports: InstallPorts,
  onProgress?: (progress: InstallProgress) => void,
): Promise<InstallResult> {
  const description = AGENT_DESCRIPTIONS[agent];
  // 021 R-345: an installed program (Hermes) comes from its own installer; Hallpass downloads nothing for it.
  if (description.kind === "installed") return failure(`${description.label} is installed with its own installer; Hallpass downloads nothing for it.`);
  const pin = { package: description.package, version: description.version };
  onProgress?.({ phase: "preparing" });
  const agentDir = win32.join(ports.dataDir, "agents", agent);
  const finalDir = adapterDirectory(ports.dataDir, agent);
  // T572: named with this broker's pid, so another browser's broker starting meanwhile leaves it alone.
  const suffix = (ports.randomSuffix ?? (() => randomBytes(6).toString("hex")))();
  const staging = win32.join(agentDir, `${STAGING_PREFIX}${process.pid}-${suffix}`);
  try {
    await mkdir(agentDir, { recursive: true });
    if (await pinnedAdapterPresent(agent, finalDir)) {
      onProgress?.({ phase: "finishing" });
      return { ok: true, directory: finalDir };
    }
    // A folder with the final name that is not a verified install is a leftover; it would block the rename.
    await removeTree(finalDir);

    await mkdir(staging);
    for (const name of ["package.json", "package-lock.json"]) {
      try {
        await copyFile(win32.join(ports.manifestsDir, agent, name), win32.join(staging, name));
      } catch {
        return failure(`The pinned ${name} for ${description.label} is missing from this Hallpass install.`);
      }
    }

    onProgress?.({ phase: "downloading" });
    let run;
    try {
      run = await ports.run(await npmCommand(ports.nodePath), description.npmCiArgs, {
        cwd: staging,
        // R-346: 10 minutes for the slim adapters (57-77 MB on a poor connection), 30 for DeepSeek's 611 packages.
        timeoutMs: description.installTimeoutMs,
      });
    } catch (error) {
      return failure(`npm could not be started: ${redactedTail(messageOf(error), 400)}`);
    }
    if (run.timedOut) return failure("npm ci did not finish in time and was stopped.");
    if (run.code !== 0) {
      const head = `npm ci failed (exit ${run.code ?? "none"}): `;
      return failure(head + redactedTail(run.stderr || run.stdout, DETAIL_MAX - head.length));
    }
    if (!(await pinnedAdapterPresent(agent, staging))) {
      return failure(`npm finished, but ${pin.package} ${pin.version} is not in the result.`);
    }

    onProgress?.({ phase: "finishing" });
    try {
      await rename(staging, finalDir);
    } catch (error) {
      // Another install of the same adapter won the rename: the result is the same folder.
      if (await pinnedAdapterPresent(agent, finalDir)) return { ok: true, directory: finalDir };
      return failure(`The install could not be put in place: ${redactedTail(messageOf(error), 400)}`);
    }
    return { ok: true, directory: finalDir };
  } catch (error) {
    return failure(`The install failed: ${redactedTail(messageOf(error), 400)}`);
  } finally {
    // After a successful rename `staging` no longer exists; after any failure this is the cleanup.
    await removeTree(staging).catch(() => {});
  }
}

/** `.staging-<pid>-<random>`: the pid of the broker whose install it is. */
const STAGING_OWNER = /^\.staging-(\d+)-/u;

/**
 * Remove the `.staging-*` folders under `agents\<agent>` - what a crash mid-install left (run at
 * broker start). T572: not one whose owning broker is alive - another browser's broker may be
 * downloading into it right now. A folder of this broker's own pid is an earlier process's (the pid
 * was reused); one with no pid in its name is from before the pid was in it.
 */
export async function cleanStaging(
  dataDir: string,
  options: { isAlive?: (pid: number) => boolean; selfPid?: number } = {},
): Promise<string[]> {
  const isAlive = options.isAlive ?? isProcessAlive;
  const selfPid = options.selfPid ?? process.pid;
  const removed: string[] = [];
  for (const agent of CONVERSATION_AGENTS) {
    const agentDir = win32.join(dataDir, "agents", agent);
    let entries;
    try {
      entries = await readdir(agentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.name.startsWith(STAGING_PREFIX)) continue;
      const owner = STAGING_OWNER.exec(entry.name);
      if (owner !== null) {
        const pid = Number(owner[1]);
        if (pid !== selfPid && isAlive(pid)) continue;
      }
      const path = win32.join(agentDir, entry.name);
      try {
        await removeTree(path);
        removed.push(path);
      } catch {
        // Held open by something: the next start tries again.
      }
    }
  }
  return removed;
}
