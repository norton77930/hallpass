import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { copyFile, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { CONVERSATION_AGENTS, type ConversationAgent, type ConversationError } from "@hallpass/contracts";
import { isProcessAlive } from "../bridge-link.js";
import {
  ADAPTER_NPM_CI_ARGS,
  AGENT_DESCRIPTIONS,
  INSTALL_TREE_PREFIX,
  READ_RETRY,
  UnreadableInstallFileError,
  adapterDirectory,
  installPointerPath,
  installedAdapterDirectory,
  packagePin,
  parseInstallPointer,
  readInstallFile,
  type ReadRetry,
} from "./agents.js";
import { redactedTail } from "./redact.js";
import { markInterruptedInstalls } from "./shared-agent-state.js";
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
 * R-362: the tree is never moved. Until 0.15.0 `npm ci` ran in a staging folder that was then
 * renamed to `agents\<agent>\<version>`; under a real-time file scanner that one rename of DeepSeek's
 * 611 packages took 41 minutes (the scanner walks the moved tree before the call returns). Now
 * `npm ci` runs in `agents\<agent>\.install-<broker pid>-<random>` and the tree stays there: once the
 * pinned package is verified inside it, the small pointer `<version>.installed.json` naming it is
 * created whole (a hard link of a written file, which fails when the pointer exists), and only a
 * tree a pointer names is installed (`installedAdapterDirectory`), so launch never sees a
 * half-written one. A 0.15.0 `<version>` folder (renamed whole, so complete) still counts when
 * there is no pointer.
 *
 * T572: every install writes its own folder, so two brokers (two browsers) installing at once never
 * touch each other's tree. The first to create the pointer wins; the other finds the pointer, removes
 * its own tree (never named, so nothing runs from it) and answers with the winner's. Any failure
 * removes the install's own folder (FR-300); `cleanStaging` removes what a crash of a broker left
 * behind - never a tree a pointer names, nor one whose broker is alive.
 *
 * R-362 (L3): only a pointer or pinned package.json that is not there, or does not say the pinned
 * install, is missing or damaged. One the file system will not let be read (a real-time file scanner
 * holding it open) is read again briefly, then the install fails saying so: no download, no pointer
 * replaced, no tree removed because of it.
 *
 * Progress is the phases, and - 024 R-376 addendum - an estimate: npm prints no byte counts to a
 * pipe, and walking DeepSeek's 63 600 files takes seconds, so each second the installed package
 * folders (a `package.json` there) are counted against what the shipped lockfile expects
 * (`expectedPackageEntries`), and time left comes from the last 30 s (`createInstallEstimator`).
 *
 * 024 R-377: an install can be cancelled (`InstallControl.signal`): npm's whole process tree is ended
 * and its folder removed as after any failure.
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

/** 024 R-376 addendum: how often the install tree's package folders are counted while npm runs. */
export const INSTALL_ESTIMATE_INTERVAL_MS = 1_000;
/** The estimate never says more than this until the pinned package is verified in the tree. */
export const INSTALL_ESTIMATE_CAP = 95;
/** Time left is said only from this percent on ... */
const ETA_FROM_PERCENT = 10;
/** ... and from the growth over this last stretch. */
const ETA_WINDOW_MS = 30_000;

/** One count of the tree: installed package folders of the expected ones; percent and time left as said. */
export type InstallEstimate = { installed: number; expected: number; percent: number | null; etaSeconds: number | null };

/** 024 R-376 / R-377: what the caller of `installAgent` hears and can do beyond the phases. */
export type InstallControl = {
  /** Aborted: npm's process tree is ended and the install fails as cancelled (R-377). */
  signal?: AbortSignal;
  /** Each count of the tree during `downloading` (R-376 addendum). */
  onEstimate?: (estimate: InstallEstimate) => void;
};

/**
 * 024 R-376 addendum: the package folders an `npm ci` of this lockfile leaves - its entries under
 * `node_modules/` (nested ones too), less every optional one for an adapter (`--omit=optional`), and
 * for a fetched agent less the optional ones whose `os` / `cpu` leave this platform out. Measured:
 * Codex 18 expected = 18 installed, DeepSeek 613 expected for 611 installed.
 */
export function expectedPackageEntries(
  lockText: string,
  kind: "adapter" | "fetched",
  platform: { os: string; cpu: string } = { os: process.platform, cpu: process.arch },
): string[] {
  const packages = (JSON.parse(lockText) as { packages?: Record<string, { optional?: unknown; os?: unknown; cpu?: unknown }> }).packages ?? {};
  const allows = (list: unknown, value: string): boolean => {
    if (!Array.isArray(list) || list.length === 0) return true;
    const entries = list.filter((item): item is string => typeof item === "string");
    if (entries.includes(`!${value}`)) return false;
    const positive = entries.filter((item) => !item.startsWith("!"));
    return positive.length === 0 || positive.includes(value);
  };
  return Object.entries(packages)
    .filter(([key, entry]) => {
      if (!key.startsWith("node_modules/")) return false;
      if (entry.optional !== true) return true;
      return kind === "fetched" && allows(entry.os, platform.os) && allows(entry.cpu, platform.cpu);
    })
    .map(([key]) => key);
}

/**
 * 024 R-376 addendum: percent = installed / expected, none before the first folder (Preparing), at
 * most 95 until verified; time left only from 10 % on, from the growth since the oldest count of the
 * last 30 s, and none while nothing grew in that stretch.
 */
export function createInstallEstimator(expected: number): { sample(installed: number, at: number): InstallEstimate } {
  const counts: { installed: number; at: number }[] = [];
  return {
    sample(installed, at) {
      const base = counts.find((count) => count.at >= at - ETA_WINDOW_MS);
      counts.push({ installed, at });
      while (counts.length > 0 && counts[0]!.at < at - ETA_WINDOW_MS) counts.shift();
      if (installed <= 0 || expected <= 0) return { installed, expected, percent: null, etaSeconds: null };
      const share = Math.min(installed / expected, 1);
      const percent = Math.min(INSTALL_ESTIMATE_CAP, Math.floor(share * 100));
      let etaSeconds: number | null = null;
      if (share * 100 >= ETA_FROM_PERCENT && base !== undefined && at > base.at && installed > base.installed) {
        const perMs = (installed - base.installed) / (at - base.at);
        etaSeconds = Math.round(Math.max(expected - installed, 0) / perMs / 1000);
      }
      return { installed, expected, percent, etaSeconds };
    },
  };
}

/** How many of the expected package folders hold their `package.json` now. */
async function countInstalled(tree: string, entries: readonly string[]): Promise<number> {
  const present = await Promise.all(entries.map((key) => isFile(win32.join(tree, ...key.split("/"), "package.json"))));
  return present.filter(Boolean).length;
}

/** Counts the tree each `intervalMs` while npm runs, one count at a time; `stop` ends it. */
function estimateWhileRunning(
  tree: string,
  kind: "adapter" | "fetched",
  intervalMs: number,
  onEstimate: (estimate: InstallEstimate) => void,
): { stop(): void } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let estimator: ReturnType<typeof createInstallEstimator> | undefined;
  let entries: string[] | undefined;
  const tick = async (): Promise<void> => {
    try {
      entries ??= expectedPackageEntries(await readFile(win32.join(tree, "package-lock.json"), "utf8"), kind);
      estimator ??= createInstallEstimator(entries.length);
      const installed = await countInstalled(tree, entries);
      if (!stopped) onEstimate(estimator.sample(installed, Date.now()));
    } catch {
      // A lockfile that cannot be read leaves the estimate out; the phases still go on.
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), intervalMs);
      timer.unref?.();
    }
  };
  timer = setTimeout(() => void tick(), 0);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

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
  /** Reads a small file whole: the pointer, a package.json (injected in tests). */
  readText?: (path: string) => Promise<string>;
  /** How a read the file system refused is tried again (R-362, L3; injected in tests). */
  readRetry?: ReadRetry;
  /** 024 R-376 addendum: how often the tree is counted (default `INSTALL_ESTIMATE_INTERVAL_MS`; injected in tests). */
  estimateIntervalMs?: number;
};

export type InstallResult = { ok: true; directory: string } | { ok: false; error: ConversationError };

const failure = (detail: string): InstallResult => ({
  ok: false,
  error: { code: "install-failed", detail: detail.slice(0, DETAIL_MAX) },
});

/** 024 R-377: what a cancelled install answers; the contract has no code of its own for it. */
export const INSTALL_CANCELLED_DETAIL = "You cancelled the download.";

const isFile = (path: string) =>
  stat(path).then(
    (info) => info.isFile(),
    () => false,
  );

const removeTree = (path: string) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

/**
 * Whether the pinned package's package.json is inside an `npm ci` tree, at the pinned version.
 * R-362 (L3): one held open throws `UnreadableInstallFileError` rather than reading as absent.
 */
async function pinnedAdapterPresent(agent: ConversationAgent, tree: string, read: Read, retry: ReadRetry): Promise<boolean> {
  const adapter = packagePin(agent);
  if (adapter === undefined) return false;
  const text = await readInstallFile(read, win32.join(tree, "node_modules", ...adapter.package.split("/"), "package.json"), retry);
  if (text === undefined) return false;
  try {
    return (JSON.parse(text) as { version?: unknown } | null)?.version === adapter.version;
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
  control: InstallControl = {},
): Promise<InstallResult> {
  const description = AGENT_DESCRIPTIONS[agent];
  const { signal } = control;
  const cancelled = (): boolean => signal?.aborted === true;
  // 021 R-345: an installed program (Hermes) comes from its own installer; Hallpass downloads nothing for it.
  if (description.kind === "installed") return failure(`${description.label} is installed with its own installer; Hallpass downloads nothing for it.`);
  const pin = { package: description.package, version: description.version };
  onProgress?.({ phase: "preparing" });
  const agentDir = win32.join(ports.dataDir, "agents", agent);
  const legacyDir = adapterDirectory(ports.dataDir, agent);
  // T572: named with this broker's pid, so another browser's broker starting meanwhile leaves it alone.
  const suffix = (ports.randomSuffix ?? (() => randomBytes(6).toString("hex")))();
  const tree = win32.join(agentDir, `${INSTALL_TREE_PREFIX}${process.pid}-${suffix}`);
  const read = ports.readText ?? readText;
  const retry = ports.readRetry ?? READ_RETRY;
  let keepTree = false;
  try {
    await mkdir(agentDir, { recursive: true });
    let current;
    try {
      current = await installedAdapterDirectory(ports.dataDir, agent, read, retry);
      if (await pinnedAdapterPresent(agent, current, read, retry)) {
        onProgress?.({ phase: "finishing" });
        return { ok: true, directory: current };
      }
    } catch (error) {
      if (!(error instanceof UnreadableInstallFileError)) throw error;
      // R-362 (L3): held open is not missing - a download now could replace a good install.
      return failure(`The ${description.label} install already here could not be checked: ${redactedTail(error.message, 400)}. Try again in a moment.`);
    }
    // A 0.15.0 `<version>` folder that is not a verified install is a leftover nothing launches from.
    // A pointer's tree that is not (damaged since) is left alone: the pointer is replaced below.
    if (current === legacyDir) await removeTree(legacyDir);

    await mkdir(tree);
    for (const name of ["package.json", "package-lock.json"]) {
      try {
        await copyFile(win32.join(ports.manifestsDir, agent, name), win32.join(tree, name));
      } catch {
        return failure(`The pinned ${name} for ${description.label} is missing from this Hallpass install.`);
      }
    }

    if (cancelled()) return failure(INSTALL_CANCELLED_DETAIL);
    onProgress?.({ phase: "downloading" });
    const estimating =
      control.onEstimate === undefined
        ? undefined
        : estimateWhileRunning(tree, description.kind, ports.estimateIntervalMs ?? INSTALL_ESTIMATE_INTERVAL_MS, control.onEstimate);
    let run;
    try {
      run = await ports.run(await npmCommand(ports.nodePath), description.npmCiArgs, {
        cwd: tree,
        // R-346: 10 minutes for the slim adapters (57-77 MB on a poor connection), 30 for DeepSeek's 611 packages.
        timeoutMs: description.installTimeoutMs,
        // 024 R-377: cancel ends npm's whole tree.
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      return failure(`npm could not be started: ${redactedTail(messageOf(error), 400)}`);
    } finally {
      estimating?.stop();
    }
    if (run.aborted === true || cancelled()) return failure(INSTALL_CANCELLED_DETAIL);
    if (run.timedOut) return failure("npm ci did not finish in time and was stopped.");
    if (run.code !== 0) {
      const head = `npm ci failed (exit ${run.code ?? "none"}): `;
      return failure(head + redactedTail(run.stderr || run.stdout, DETAIL_MAX - head.length));
    }
    if (!(await pinnedAdapterPresent(agent, tree, read, retry))) {
      return failure(`npm finished, but ${pin.package} ${pin.version} is not in the result.`);
    }

    onProgress?.({ phase: "finishing" });
    let directory;
    try {
      directory = await pointAt(agent, ports.dataDir, tree, `${tree}.pointer`, read, retry);
    } catch (error) {
      return failure(`The install could not be put in place: ${redactedTail(messageOf(error), 400)}`);
    }
    keepTree = directory === tree;
    return { ok: true, directory };
  } catch (error) {
    return failure(`The install failed: ${redactedTail(messageOf(error), 400)}`);
  } finally {
    // After any failure, or when another broker's install was in place first, this is the cleanup.
    if (!keepTree) await removeTree(tree).catch(() => {});
  }
}

type Read = (path: string) => Promise<string>;
const readText: Read = (path) => readFile(path, "utf8");

/**
 * Make the pointer name `tree` (verified), and answer with the install that is in place.
 * T572: the pointer is created by a hard link of a fully written file, which fails when it exists,
 * so the first finished install wins whole and no reader sees half a pointer. A pointer that is
 * there and names a verified install is kept (the caller drops its own tree); one whose tree was
 * damaged since is replaced (a small-file rename, not of the tree). R-362 (L3): one that cannot be
 * read, or whose tree's package.json cannot, is never replaced - `UnreadableInstallFileError` fails the install.
 */
async function pointAt(
  agent: ConversationAgent,
  dataDir: string,
  tree: string,
  temp: string,
  read: Read,
  retry: ReadRetry,
): Promise<string> {
  const pointer = installPointerPath(dataDir, agent);
  await writeFile(temp, `${JSON.stringify({ folder: win32.basename(tree) })}\n`, { flag: "wx" });
  try {
    try {
      await link(temp, pointer);
      return tree;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const current = await installedAdapterDirectory(dataDir, agent, read, retry);
    if (await pinnedAdapterPresent(agent, current, read, retry)) return current;
    await rename(temp, pointer);
    return tree;
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

/**
 * 024 R-378: what a broker does with the agent folders when it starts - a download left running by a
 * broker that is gone is marked `interrupted` (shown until the next attempt), then `cleanStaging`
 * removes what it left behind, as before.
 */
export async function prepareAgentsAtStart(
  dataDir: string,
  options: Parameters<typeof cleanStaging>[1] = {},
): Promise<{ interrupted: ConversationAgent[]; staged: string[] }> {
  const interrupted = await markInterruptedInstalls(dataDir, {
    ...(options.isAlive === undefined ? {} : { isAlive: options.isAlive }),
    ...(options.selfPid === undefined ? {} : { selfPid: options.selfPid }),
  }).catch((): ConversationAgent[] => []);
  const staged = await cleanStaging(dataDir, options).catch((): string[] => []);
  return { interrupted, staged };
}

/** `.staging-<pid>-<random>` (0.15.0) and `.install-<pid>-<random>[.pointer]`: the pid of the broker whose install it is. */
const INSTALL_WORK_OWNER = /^\.(?:staging|install)-(\d+)-/u;
const POINTER_SUFFIX = ".installed.json";

/**
 * The tree folders the pointers in `agentDir` name now (lower case). Undefined when the folder or a
 * pointer cannot be read (R-362, L3): which tree is installed is then not known.
 */
async function namedTrees(agentDir: string, read: Read, retry: ReadRetry): Promise<Set<string> | undefined> {
  try {
    const named = new Set<string>();
    for (const entry of await readdir(agentDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(POINTER_SUFFIX)) continue;
      const text = await readInstallFile(read, win32.join(agentDir, entry.name), retry);
      const folder = text === undefined ? undefined : parseInstallPointer(text);
      if (folder !== undefined) named.add(folder.toLowerCase());
    }
    return named;
  } catch {
    return undefined;
  }
}

/**
 * Remove what a crash mid-install left under `agents\<agent>` (run at broker start): 0.15.0's
 * `.staging-*` folders and `.install-*` trees and pointer files that no `<version>.installed.json`
 * names. T572: not one whose owning broker is alive - another browser's broker may be downloading
 * into it right now - and never a tree a pointer names (R-362: that is the install, maybe running).
 * A folder of this broker's own pid is an earlier process's (the pid was reused); one with no pid
 * in its name is from before the pid was in it.
 *
 * R-362 (L1): an installer creates its pointer before it exits, so the pointers are read again after
 * a tree's broker is found dead - one that named its tree and exited between the first read and the
 * pid check is seen then. (L3): when a pointer cannot be read, nothing of that agent is removed.
 */
export async function cleanStaging(
  dataDir: string,
  options: {
    isAlive?: (pid: number) => boolean;
    selfPid?: number;
    readText?: (path: string) => Promise<string>;
    readRetry?: ReadRetry;
  } = {},
): Promise<string[]> {
  const isAlive = options.isAlive ?? isProcessAlive;
  const selfPid = options.selfPid ?? process.pid;
  const read = options.readText ?? readText;
  const retry = options.readRetry ?? READ_RETRY;
  const removed: string[] = [];
  for (const agent of CONVERSATION_AGENTS) {
    const agentDir = win32.join(dataDir, "agents", agent);
    let entries;
    try {
      entries = await readdir(agentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const named = await namedTrees(agentDir, read, retry);
    if (named === undefined) continue;
    for (const entry of entries) {
      if (!entry.name.startsWith(STAGING_PREFIX) && !entry.name.startsWith(INSTALL_TREE_PREFIX)) continue;
      if (named.has(entry.name.toLowerCase())) continue;
      const owner = INSTALL_WORK_OWNER.exec(entry.name);
      if (owner !== null) {
        const pid = Number(owner[1]);
        if (pid !== selfPid && isAlive(pid)) continue;
      }
      const namedNow = await namedTrees(agentDir, read, retry);
      if (namedNow === undefined || namedNow.has(entry.name.toLowerCase())) continue;
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
