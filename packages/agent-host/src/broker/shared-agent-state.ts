import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CONVERSATION_AGENTS,
  agentInstallStateFileSchema,
  agentTestResultSchema,
  type AgentInstallState,
  type AgentTestResult,
  type ConversationAgent,
  type ConversationInstallState,
} from "@hallpass/contracts";
import { isProcessAlive, writeHostFileAtomically } from "../bridge-link.js";

/**
 * 024 R-375 (D-024-16, FR-396; data-model "Per computer"): what every browser's broker on this
 * computer shares about an agent, beside its installed trees in `<data>\agents\<agent>\`:
 *
 * - `install-state.json` - the download in flight or the last one's outcome (`AgentInstallState`),
 *   written whole (temp + rename) by the broker that runs it, each second while it runs (R-376);
 * - `last-test.json` - the last Test's result (`AgentTestResult`, R-379);
 * - `install.lock` - `{ pid, browserId }` of the broker whose install runs now, created exclusively,
 *   removed at its end, and stale once that pid is gone, so a broker that died leaves no lock that
 *   holds the next download off.
 *
 * The lock is an optimisation - it spares a second `npm ci` and lets one browser show another's
 * progress; correctness rests on `install.ts`, where each install writes its own folder and the first
 * pointer written wins (T572). Liveness is the holder's pid alone, so a pid Windows has reused for an
 * unrelated process keeps a dead broker's lock (and its running state) looking alive - known, accepted.
 *
 * A broker whose settings page asked lately reads them again every second (`watchSharedState`; how
 * long is `commands.ts`' `SHARED_STATE_WATCH_IDLE_MS`, and on while a live broker's download runs) and
 * sends what changed, so a download another browser's broker runs shows its progress here too. R-378: a
 * running state whose broker is gone is an interrupted download - shown so at once, and written so at
 * the next broker start (`markInterruptedInstalls`) until the next attempt overwrites it.
 *
 * The paths come from the data folder the broker derives through `host-paths.ts` and an agent id
 * from the contract's closed list, so no file name here comes from outside.
 */

export const INSTALL_STATE_FILE = "install-state.json";
export const LAST_TEST_FILE = "last-test.json";
export const INSTALL_LOCK_FILE = "install.lock";

/** How often a watching broker reads the files again (R-375: at most a second). */
export const SHARED_STATE_POLL_MS = 1_000;

export const agentStateDirectory = (dataDir: string, agent: ConversationAgent): string => win32.join(dataDir, "agents", agent);
export const installStatePath = (dataDir: string, agent: ConversationAgent): string =>
  win32.join(agentStateDirectory(dataDir, agent), INSTALL_STATE_FILE);
export const lastTestPath = (dataDir: string, agent: ConversationAgent): string => win32.join(agentStateDirectory(dataDir, agent), LAST_TEST_FILE);
export const installLockPath = (dataDir: string, agent: ConversationAgent): string =>
  win32.join(agentStateDirectory(dataDir, agent), INSTALL_LOCK_FILE);

/** The phases of a download still under way; any other is its end. */
const RUNNING_PHASES: ReadonlySet<AgentInstallState["phase"]> = new Set(["preparing", "downloading", "finishing"]);
export const isRunningInstallPhase = (phase: AgentInstallState["phase"]): boolean => RUNNING_PHASES.has(phase);

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Written whole; one out of contract is refused here rather than left for every reader to drop. */
export async function writeInstallState(dataDir: string, agent: ConversationAgent, state: AgentInstallState): Promise<void> {
  await writeHostFileAtomically(installStatePath(dataDir, agent), agentInstallStateFileSchema.parse(state));
}

/** None when missing, damaged or out of contract (a reader never acts on half a record). */
export async function readInstallState(dataDir: string, agent: ConversationAgent): Promise<AgentInstallState | undefined> {
  const parsed = agentInstallStateFileSchema.safeParse(await readJson(installStatePath(dataDir, agent)));
  return parsed.success ? parsed.data : undefined;
}

export async function writeLastTest(dataDir: string, agent: ConversationAgent, result: AgentTestResult): Promise<void> {
  await writeHostFileAtomically(lastTestPath(dataDir, agent), agentTestResultSchema.parse(result));
}

export async function readLastTest(dataDir: string, agent: ConversationAgent): Promise<AgentTestResult | undefined> {
  const parsed = agentTestResultSchema.safeParse(await readJson(lastTestPath(dataDir, agent)));
  return parsed.success ? parsed.data : undefined;
}

export type SharedAgentFacts = { install?: AgentInstallState; lastTest?: AgentTestResult };
export type SharedStateSnapshot = Record<ConversationAgent, SharedAgentFacts>;

/** Every agent's two files, read together. */
export async function readSharedState(dataDir: string): Promise<SharedStateSnapshot> {
  const entries = await Promise.all(
    CONVERSATION_AGENTS.map(async (agent): Promise<[ConversationAgent, SharedAgentFacts]> => {
      const [install, lastTest] = await Promise.all([readInstallState(dataDir, agent), readLastTest(dataDir, agent)]);
      return [agent, { ...(install === undefined ? {} : { install }), ...(lastTest === undefined ? {} : { lastTest }) }];
    }),
  );
  return Object.fromEntries(entries) as SharedStateSnapshot;
}

/**
 * R-378: the state as the overview carries it - without the pid; a running one whose broker is gone
 * is `interrupted` (no time left to show), whether or not a broker start has rewritten it yet.
 */
export function shownInstallState(state: AgentInstallState, isAlive: (pid: number) => boolean = isProcessAlive): ConversationInstallState {
  const { pid, ...shown } = state;
  if (isRunningInstallPhase(state.phase) && !isAlive(pid)) return { ...shown, phase: "interrupted", etaSeconds: null };
  return shown;
}

/**
 * R-378 (D-024-9): at broker start, a state left running by a broker that is gone - the browser was
 * closed mid-download, which ends its broker and the job ends npm - becomes `interrupted` and stays so
 * until the next attempt. `selfPid`: a state naming this process's own pid is an earlier process's
 * (the pid was reused), since this broker has started nothing yet. Returns the agents it rewrote.
 */
export async function markInterruptedInstalls(
  dataDir: string,
  options: { isAlive?: (pid: number) => boolean; selfPid?: number; now?: () => number } = {},
): Promise<ConversationAgent[]> {
  const isAlive = options.isAlive ?? isProcessAlive;
  const selfPid = options.selfPid ?? process.pid;
  const now = options.now ?? Date.now;
  const marked: ConversationAgent[] = [];
  for (const agent of CONVERSATION_AGENTS) {
    const state = await readInstallState(dataDir, agent);
    if (state === undefined || !isRunningInstallPhase(state.phase)) continue;
    if (state.pid !== selfPid && isAlive(state.pid)) continue;
    try {
      await writeInstallState(dataDir, agent, { ...state, phase: "interrupted", etaSeconds: null, endedAt: new Date(now()).toISOString() });
      marked.push(agent);
    } catch {
      // Not writable now: the overview shows it interrupted anyway (`shownInstallState`).
    }
  }
  return marked;
}

/* ------------------------------------------------------------------------------------------- */
/* The install lock                                                                             */
/* ------------------------------------------------------------------------------------------- */

export type InstallLockHolder = { pid: number; browserId: string };
export type InstallLockResult = { acquired: true; release(): Promise<void> } | { acquired: false; holder: InstallLockHolder };

const sameHolder = (a: InstallLockHolder | undefined, b: InstallLockHolder): boolean => a?.pid === b.pid && a.browserId === b.browserId;

function parseHolder(value: unknown): InstallLockHolder | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { pid, browserId } = value as { pid?: unknown; browserId?: unknown };
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && typeof browserId === "string" ? { pid, browserId } : undefined;
}

/**
 * The lock's holder; a file just created exclusively may be empty for a moment (created, then
 * written), so an unreadable one is read again briefly before it counts as garbage.
 */
async function readHolder(path: string): Promise<{ present: boolean; holder?: InstallLockHolder }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return { present: false };
      text = "";
    }
    const holder = parseHolder(((): unknown => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return undefined;
      }
    })());
    if (holder !== undefined) return { present: true, holder };
    await delay(20);
  }
  return { present: true };
}

/**
 * R-375: take `agents\<agent>\install.lock` for this broker, or say who holds it. Created with an
 * exclusive create, so two brokers never both create it. A lock whose broker is gone (or that holds
 * no holder at all) is stale: it is moved aside under a name of this broker's own and removed only
 * when what was moved is the stale lock that was read - when another broker had replaced it in the
 * meantime, that broker's lock is put back (a hard link, which fails rather than overwrite) and its
 * broker keeps it. `self.pid` in a lock is an earlier process's, as in `markInterruptedInstalls`.
 */
export async function acquireInstallLock(
  dataDir: string,
  agent: ConversationAgent,
  self: InstallLockHolder,
  isAlive: (pid: number) => boolean = isProcessAlive,
): Promise<InstallLockResult> {
  const path = installLockPath(dataDir, agent);
  await mkdir(agentStateDirectory(dataDir, agent), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await writeFile(path, `${JSON.stringify({ pid: self.pid, browserId: self.browserId })}\n`, { encoding: "utf8", flag: "wx" });
      return { acquired: true, release: () => releaseInstallLock(dataDir, agent, self) };
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
    }
    const { present, holder } = await readHolder(path);
    if (!present) continue;
    if (holder !== undefined && holder.pid !== self.pid && isAlive(holder.pid)) return { acquired: false, holder };
    // Stale: moved aside, then removed only if it is still the one read above.
    const aside = `${path}.${self.pid}.${randomBytes(4).toString("hex")}.stale`;
    try {
      await rename(path, aside);
    } catch {
      continue;
    }
    const moved = parseHolder(await readJson(aside));
    if (holder !== undefined && moved !== undefined && !sameHolder(moved, holder)) {
      // Another broker took it over between the read and the move: its lock goes back.
      await link(aside, path).catch(() => undefined);
    }
    await rm(aside, { force: true }).catch(() => undefined);
  }
  const { holder } = await readHolder(path);
  if (holder !== undefined) return { acquired: false, holder };
  throw new Error("the install lock could not be taken");
}

/** Removes the lock only while it is this broker's: never one another broker took over since. */
export async function releaseInstallLock(dataDir: string, agent: ConversationAgent, self: InstallLockHolder): Promise<void> {
  const path = installLockPath(dataDir, agent);
  const { present, holder } = await readHolder(path);
  if (present && sameHolder(holder, self)) await rm(path, { force: true }).catch(() => undefined);
}

/** The holder of an agent's lock while its broker is alive; none for no lock or a stale one. */
export async function liveInstallLockHolder(
  dataDir: string,
  agent: ConversationAgent,
  isAlive: (pid: number) => boolean = isProcessAlive,
): Promise<InstallLockHolder | undefined> {
  const { holder } = await readHolder(installLockPath(dataDir, agent));
  return holder !== undefined && isAlive(holder.pid) ? holder : undefined;
}

/* ------------------------------------------------------------------------------------------- */
/* Watching                                                                                      */
/* ------------------------------------------------------------------------------------------- */

export type SharedStateWatch = {
  /** Reads what is there now (not a change) and then again every `intervalMs`; resolves after the first read. */
  start(): Promise<void>;
  stop(): void;
  readonly watching: boolean;
};

/**
 * R-375: another broker's change reaches this one only through the files, so while a settings page
 * is connected they are read again every second and `onChange` hears that something differs from
 * the last read. Reads never overlap; the timer does not keep the process alive. `keepWatching` is
 * asked before each read, with what the last read found: `false` ends the watch there, as `stop` would.
 */
export function watchSharedState(options: {
  dataDir: string;
  onChange: (snapshot: SharedStateSnapshot) => void;
  intervalMs?: number;
  keepWatching?: (last: SharedStateSnapshot | undefined) => boolean;
}): SharedStateWatch {
  const intervalMs = options.intervalMs ?? SHARED_STATE_POLL_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let generation = 0;
  let last: string | undefined;
  let lastSnapshot: SharedStateSnapshot | undefined;

  const read = async (): Promise<SharedStateSnapshot> => readSharedState(options.dataDir);
  const schedule = (mine: number, startedAt: number): void => {
    if (!running || mine !== generation) return;
    timer = setTimeout(() => void tick(mine), Math.max(0, intervalMs - (Date.now() - startedAt)));
    timer.unref?.();
  };
  const tick = async (mine: number): Promise<void> => {
    if (options.keepWatching?.(lastSnapshot) === false) {
      if (mine === generation) running = false;
      return;
    }
    const startedAt = Date.now();
    const snapshot = await read().catch(() => undefined);
    if (!running || mine !== generation) return;
    if (snapshot !== undefined) {
      lastSnapshot = snapshot;
      const text = JSON.stringify(snapshot);
      if (text !== last) {
        last = text;
        options.onChange(snapshot);
      }
    }
    schedule(mine, startedAt);
  };

  return {
    async start() {
      if (running) return;
      running = true;
      const mine = ++generation;
      const startedAt = Date.now();
      const snapshot = await read().catch(() => undefined);
      if (snapshot !== undefined) {
        last = JSON.stringify(snapshot);
        lastSnapshot = snapshot;
      }
      schedule(mine, startedAt);
    },
    stop() {
      running = false;
      generation += 1;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    get watching() {
      return running;
    },
  };
}
