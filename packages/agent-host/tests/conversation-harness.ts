import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConversationEventPayload } from "@hallpass/contracts";
import type { AdapterLaunchSpec } from "../src/broker/agents.js";
import { ConversationPool, type Clock, type ClockTimer, type ConversationPoolOptions } from "../src/broker/conversation.js";
import { memoryConversationIndex, memoryFolderList, type ConversationIndex } from "../src/broker/conversation-index.js";

/**
 * Shared pieces of the 019/S4 conversation tests (T535-T538, T540): the fake ACP agent as a real
 * stdio process, a clock that can jump forward (idle limit) while still keeping real time (text
 * coalescing), and a recorder for the events a conversation emits.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..", "..");
export const FAKE_AGENT = join(REPO_ROOT, "tests", "harness", "fake-acp-agent.ts");

/** The fake agent as an adapter launch spec: the broker's node on the harness file. */
export function fakeAgentSpec(env: Record<string, string> = {}): AdapterLaunchSpec {
  return { command: process.execPath, args: ["--experimental-strip-types", FAKE_AGENT], env };
}

/**
 * Real time plus an offset `advance` can add to: timers due inside the jump fire at once, the rest
 * keep running on real time. That is what lets a test skip the 10-minute idle limit while the 50 ms
 * text coalescing still happens in real time.
 */
export class TestClock implements Clock {
  private offset = 0;
  private readonly timers = new Set<{ due: number; fire: () => void; handle: ReturnType<typeof setTimeout> }>();

  now(): number {
    return Date.now() + this.offset;
  }

  setTimer(fn: () => void, ms: number): ClockTimer {
    const timer = {
      due: this.now() + ms,
      fire: () => {
        if (!this.timers.delete(timer)) return;
        clearTimeout(timer.handle);
        fn();
      },
      handle: setTimeout(() => timer.fire(), ms),
    };
    this.timers.add(timer);
    return { cancel: () => {
      this.timers.delete(timer);
      clearTimeout(timer.handle);
    } };
  }

  advance(ms: number): void {
    this.offset += ms;
    const now = this.now();
    for (const timer of [...this.timers].sort((a, b) => a.due - b.due)) if (timer.due <= now) timer.fire();
  }
}

export type Recorded = ConversationEventPayload & { at: number };

export function recorder(clock: Clock) {
  const events: Recorded[] = [];
  return {
    events,
    onEvent: (payload: ConversationEventPayload) => events.push({ ...payload, at: clock.now() }),
    of: (conversationId: string) => events.filter((event) => event.conversationId === conversationId),
    types: (conversationId?: string) =>
      events.filter((event) => conversationId === undefined || event.conversationId === conversationId).map((event) => event.event.type),
  };
}

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

export type FakeLogLine = Record<string, unknown> & {
  method?: string;
  event?: string;
  params?: Record<string, unknown>;
};

export async function readFakeLog(path: string): Promise<FakeLogLine[]> {
  try {
    return (await readFile(path, "utf8"))
      .split(/\r?\n/u)
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as FakeLogLine);
  } catch {
    return [];
  }
}

/** Every pid the fake agent logged (its own start and any children): what a test kills at the end. */
export async function killLoggedPids(path: string): Promise<void> {
  for (const line of await readFakeLog(path)) {
    if (typeof line.pid === "number" && line.pid !== process.pid) {
      try {
        process.kill(line.pid);
      } catch {
        // already gone
      }
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

/** The pid of a process that has already exited: a lease holder that is gone. */
export async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
  await new Promise((done) => child.once("exit", done));
  return child.pid!;
}

/* ------------------------------------------------------------------------------------------- */
/* A pool of conversations over the fake agent                                                  */
/* ------------------------------------------------------------------------------------------- */

export type PoolHarnessOptions = {
  browserRunId?: string;
  brokerPid?: number;
  index?: ConversationIndex;
  /** Added to the fake agent's environment; the scenario follows the agent unless this sets it. */
  env?: Record<string, string>;
  isAlive?: (pid: number) => boolean;
  cap?: number;
  clock?: TestClock;
  /** A directory shared with another harness (same log and store); not removed by this one. */
  dir?: string;
  /**
   * Keep transcripts in the fake's store file so `session/load` works across processes (default).
   * Off for tests that run several agents at once and never load: the fake writes the file without
   * locking, and two agents writing together corrupt it.
   */
  store?: boolean;
  /** In place of the plain spawn of the agent (a test that rewrites what the fake says). */
  spawnAgent?: ConversationPoolOptions["spawnAgent"];
};

export async function poolHarness(options: PoolHarnessOptions = {}) {
  const dir = options.dir ?? (await makeTempDir("hallpass-conv-"));
  const logPath = join(dir, "fake-acp.log");
  const storePath = join(dir, "fake-acp-store.json");
  const clock = options.clock ?? new TestClock();
  const rec = recorder(clock);
  const index = options.index ?? memoryConversationIndex();
  const folders = memoryFolderList();
  const pool = new ConversationPool({
    dataDir: join(dir, "data"),
    browserRunId: options.browserRunId ?? "run-test",
    brokerPid: options.brokerPid ?? process.pid,
    index,
    folders,
    clock,
    ...(options.cap === undefined ? {} : { cap: options.cap }),
    ...(options.isAlive === undefined ? {} : { isAlive: options.isAlive }),
    ...(options.spawnAgent === undefined ? {} : { spawnAgent: options.spawnAgent }),
    onEvent: rec.onEvent,
    resolveLaunch: async (agent) => ({
      ok: true,
      spec: fakeAgentSpec({
        FAKE_ACP_LOG: logPath,
        ...(options.store === false ? {} : { FAKE_ACP_STORE: storePath }),
        FAKE_ACP_SCENARIO: agent === "codex" ? "codex" : "claude",
        ...options.env,
      }),
      versions: { agent, tested: "1.0.0", found: "1.0.0" },
    }),
  });

  const start = async (agent: "claude-code" | "codex" = "claude-code"): Promise<string> => {
    const started = await pool.start(agent, { kind: "scratch" });
    if (!started.ok) throw new Error(`start failed: ${started.error.code} ${started.error.detail}`);
    return started.value!.conversationId!;
  };

  /** Send, then wait until the turn has ended (a `state` event other than running/waiting after the send). */
  const turn = async (conversationId: string, text: string, timeoutMs = 10_000): Promise<void> => {
    const from = rec.events.length;
    const sent = await pool.send(conversationId, text);
    if (!sent.ok) throw new Error(`send failed: ${sent.error.code} ${sent.error.detail}`);
    await waitFor(() => turnEnded(rec.events.slice(from), conversationId), `the turn "${text}" to end`, timeoutMs);
  };

  const cleanup = async (): Promise<void> => {
    await pool.shutdown().catch(() => undefined);
    await killLoggedPids(logPath);
    if (options.dir === undefined) await removeDir(dir);
  };

  return { dir, logPath, storePath, clock, rec, index, folders, pool, start, turn, cleanup, log: () => readFakeLog(logPath) };
}

/**
 * Whether `events` hold a whole turn of that conversation: a `running` state and, after it, a state
 * other than running or waiting (a resume's `starting`/`idle` before the turn do not count).
 */
export function turnEnded(events: Recorded[], conversationId: string): boolean {
  const states = events.flatMap((entry) =>
    entry.conversationId === conversationId && entry.event.type === "state" ? [entry.event.state] : [],
  );
  const running = states.indexOf("running");
  return running >= 0 && states.slice(running + 1).some((state) => state !== "running" && state !== "waiting-for-owner");
}

/** The fake agent's requests of one method, in order. */
export function requests(log: FakeLogLine[], method: string): FakeLogLine[] {
  return log.filter((line) => line.method === method);
}
