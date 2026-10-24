import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  conversationOverviewFrameSchema,
  type AgentInstallState,
  type ConversationAgent,
  type ConversationAgentAvailability,
} from "@hallpass/contracts";
import { AGENT_DESCRIPTIONS } from "../src/broker/agents.js";
import { createCommandHandler, type CommandHandlerOptions, type ConsentStore } from "../src/broker/commands.js";
import { memoryConversationIndex, memoryFolderList } from "../src/broker/conversation-index.js";
import { ConversationPool } from "../src/broker/conversation.js";
import type { FolderActions } from "../src/broker/folders.js";
import {
  INSTALL_ESTIMATE_INTERVAL_MS,
  createInstallEstimator,
  expectedPackageEntries,
  installAgent,
  prepareAgentsAtStart,
  type InstallPorts,
} from "../src/broker/install.js";
import { killTree, killTreeAsync, runCommand } from "../src/broker/run-command.js";
import { installLockPath, installStatePath, readInstallState, writeInstallState } from "../src/broker/shared-agent-state.js";
import { deadPid, isAlive, makeTempDir, removeDir, sleep, waitFor } from "./conversation-harness.js";

/**
 * 024 T758, T760, T762 (R-375 - R-378, R-376 addendum; FR-379, D-024-9): a download's progress is an
 * estimate - installed package folders against the count the shipped lockfile expects, at most 95 %
 * until the pinned package is verified, none before the first folder, time left only from 10 % on and
 * from the last 30 s - written to `install-state.json` each second, where another browser's broker
 * reads it instead of running `npm ci` again. Cancel ends npm's whole process tree, removes its
 * `.install-*` folder and the lock within 5 s; a download left running by a broker that died reads as
 * interrupted at the next start, and stays so until the next attempt.
 */

const SHIPPED = resolve(dirname(fileURLToPath(import.meta.url)), "..", "agents");
const CODEX = AGENT_DESCRIPTIONS.codex;

let dir: string;
let data: string;
let manifests: string;
const pools: ConversationPool[] = [];
const spawned: number[] = [];

beforeEach(async () => {
  dir = await makeTempDir("hallpass-install-024-");
  data = join(dir, "data");
  manifests = join(dir, "manifests");
});
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.shutdown().catch(() => undefined);
  for (const pid of spawned.splice(0)) if (isAlive(pid)) killTree(pid);
  await removeDir(dir);
});

const DEPENDENCIES = 19;

/**
 * A small pinned codex manifest: the pinned package and 19 others, plus optional ones an adapter's
 * `npm ci --omit=optional` leaves out - 20 package folders expected.
 */
async function writeManifests(): Promise<string[]> {
  const packages: Record<string, Record<string, unknown>> = {
    "": { name: "hallpass-agent-codex", dependencies: { [CODEX.package]: CODEX.version } },
    [`node_modules/${CODEX.package}`]: { version: CODEX.version },
  };
  for (let index = 1; index <= DEPENDENCIES; index += 1) packages[`node_modules/dep-${index}`] = { version: "1.0.0" };
  packages["node_modules/optional-bundled-cli"] = { version: "1.0.0", optional: true };
  packages["node_modules/@scope/optional-native"] = { version: "1.0.0", optional: true, os: ["win32"] };
  await mkdir(join(manifests, "codex"), { recursive: true });
  await writeFile(join(manifests, "codex", "package.json"), JSON.stringify(packages[""]), "utf8");
  await writeFile(join(manifests, "codex", "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }), "utf8");
  return Object.keys(packages).filter((key) => key !== "" && packages[key]!.optional !== true);
}

async function writePackage(tree: string, key: string, version = "1.0.0"): Promise<void> {
  await mkdir(join(tree, key), { recursive: true });
  await writeFile(join(tree, key, "package.json"), JSON.stringify({ name: key.replace(/^node_modules\//u, ""), version }), "utf8");
}

const BROWSER_A = "chrome-a1";
const BROWSER_B = "edge-b2";
const OTHER_PID = 4_000_777;

type HandlerSetup = {
  browserId?: string;
  pid?: number;
  install?: CommandHandlerOptions["install"];
  availability?: ConversationAgentAvailability["availability"];
  idleMs?: number;
};

function handlerFor(options: HandlerSetup = {}) {
  const sent: Record<string, unknown>[] = [];
  const index = memoryConversationIndex();
  const folders = memoryFolderList();
  const pool = new ConversationPool({
    dataDir: data,
    browserRunId: `run-${options.browserId ?? BROWSER_A}`,
    index,
    folders,
    resolveLaunch: async () => ({ ok: false, error: { code: "agent-missing", detail: "no launches here" } }),
    onEvent: () => undefined,
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
  });
  pools.push(pool);
  const consent: ConsentStore = { read: async () => "granted", write: async () => undefined };
  const installs: ConversationAgent[] = [];
  const handler = createCommandHandler({
    sessionId: "broker-install",
    send: (frame) => sent.push(frame as Record<string, unknown>) > 0,
    pool,
    index,
    folders,
    consent,
    folderActions: {} as FolderActions,
    availability: async (agent) => ({ agent, availability: options.availability ?? "needs-install" }),
    install: async (agent, onProgress, control) => {
      installs.push(agent);
      return options.install ? options.install(agent, onProgress, control) : { ok: true, directory: "x" };
    },
    shared: {
      dataDir: data,
      browserId: options.browserId ?? BROWSER_A,
      pid: options.pid ?? process.pid,
      followIntervalMs: 50,
    },
  });
  let counter = 0;
  const run = async (command: unknown) => {
    const commandId = `c-${++counter}-${Math.random().toString(36).slice(2, 8)}`;
    await handler.handle({ type: "conversation-command", sessionId: "broker-install", commandId, command });
    return sent.find((frame) => frame.type === "conversation-result" && frame.commandId === commandId) as {
      ok: boolean;
      error?: { code: string; detail: string };
    };
  };
  const overviewAgent = (agent: ConversationAgent) => {
    const frame = sent.filter((each) => each.type === "conversation-overview").at(-1);
    return (frame?.agents as ConversationAgentAvailability[] | undefined)?.find((entry) => entry.agent === agent);
  };
  return { handler, sent, run, installs, overviewAgent, pool };
}

describe("024 T758 the estimate (R-376 addendum)", () => {
  it("expects the shipped lockfiles' package folders: all non-optional for an adapter, this platform's for a fetched agent", () => {
    const read = (agent: string) => readFileSync(join(SHIPPED, agent, "package-lock.json"), "utf8");
    // As measured in .scratch/024/install-growth.md (T737): Codex 18, DeepSeek 613.
    expect(expectedPackageEntries(read("codex"), "adapter", { os: "win32", cpu: "x64" })).toHaveLength(18);
    expect(expectedPackageEntries(read("deepseek"), "fetched", { os: "win32", cpu: "x64" })).toHaveLength(613);
    const lock = JSON.stringify({
      packages: {
        "": {},
        "node_modules/a": {},
        "node_modules/a/node_modules/b": {},
        "node_modules/win": { optional: true, os: ["win32"], cpu: ["x64", "arm64"] },
        "node_modules/mac": { optional: true, os: ["darwin"] },
        "node_modules/not-win": { optional: true, os: ["!win32"] },
        "node_modules/arm": { optional: true, cpu: ["arm64"] },
      },
    });
    expect(expectedPackageEntries(lock, "fetched", { os: "win32", cpu: "x64" })).toEqual(["node_modules/a", "node_modules/a/node_modules/b", "node_modules/win"]);
    expect(expectedPackageEntries(lock, "adapter", { os: "win32", cpu: "x64" })).toEqual(["node_modules/a", "node_modules/a/node_modules/b"]);
  });

  it("has no percent before the first folder, stays at most 95 %, and gives time left only from 10 % from the last 30 s", () => {
    const estimate = createInstallEstimator(100);
    expect(estimate.sample(0, 0)).toMatchObject({ percent: null, etaSeconds: null });
    expect(estimate.sample(5, 10_000)).toMatchObject({ percent: 5, etaSeconds: null });
    // 10 % at 20 s: 10 folders in the 30 s window -> one folder per 2 s, 90 to go.
    expect(estimate.sample(10, 20_000)).toMatchObject({ percent: 10, etaSeconds: 180 });
    // Only the last 30 s count: from 20 s to 60 s it went 10 -> 50, so 40 in 40 s, window from 30 s on.
    estimate.sample(20, 30_000);
    expect(estimate.sample(50, 60_000)).toMatchObject({ percent: 50, etaSeconds: 50 });
    expect(estimate.sample(100, 70_000)).toMatchObject({ percent: 95, etaSeconds: 0 });
    // No growth in the window: no time left to say.
    const stalled = createInstallEstimator(10);
    stalled.sample(5, 0);
    expect(stalled.sample(5, 31_000)).toMatchObject({ percent: 50, etaSeconds: null });
  });

  it("is sampled each second during a real download", () => {
    expect(INSTALL_ESTIMATE_INTERVAL_MS).toBe(1_000);
  });
});

describe("024 T758 progress in install-state.json", () => {
  it("writes Preparing with no percent before the first folder, then the estimate each sample, at most 95 % until verified, then done", async () => {
    const expected = await writeManifests();
    const seen: AgentInstallState[] = [];
    const record = async () => {
      const state = await readInstallState(data, "codex");
      if (state !== undefined) seen.push(state);
    };
    const ports: InstallPorts = {
      dataDir: data,
      manifestsDir: manifests,
      nodePath: "C:\\no-such-node\\node.exe",
      estimateIntervalMs: 50,
      run: async (_file, _args, options) => {
        const tree = options!.cwd!;
        // npm runs, no package folder yet: Preparing, without a percent, after the first counts.
        await waitFor(async () => (await readInstallState(data, "codex")) !== undefined, "the first state");
        await sleep(200);
        await record();
        for (const key of expected) {
          await writePackage(tree, key, key.endsWith(CODEX.package) ? CODEX.version : "1.0.0");
          await sleep(30);
        }
        // Every folder is there and npm has not finished: the next counts say so.
        await waitFor(async () => ((await readInstallState(data, "codex"))?.percent ?? 0) >= 95, "the count of every folder");
        await sleep(200);
        await record();
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    };
    const { run } = handlerFor({ install: (agent, onProgress, control) => installAgent(agent, ports, onProgress, control) });
    expect(await run({ type: "ui.conversation.install", payload: { agent: "codex" } })).toMatchObject({ ok: true });

    expect(seen[0]).toMatchObject({ phase: "preparing", percent: null, etaSeconds: null, browserId: BROWSER_A, pid: process.pid });
    // Every folder is there, npm has not finished: still an estimate under 95 %.
    expect(seen[1]).toMatchObject({ phase: "downloading", percent: 95 });
    expect(await readInstallState(data, "codex")).toMatchObject({ phase: "done", percent: 100, etaSeconds: null, endedAt: expect.any(String) });
    // The lock went with the end.
    expect(await readdir(join(data, "agents", "codex"))).not.toContain("install.lock");
  });

  it("a second broker follows the install another live broker's lock holds: no npm ci, that install's progress", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((done) => (finish = done));
    const a = handlerFor({
      install: async (_agent, onProgress, control) => {
        onProgress?.({ phase: "preparing" });
        onProgress?.({ phase: "downloading" });
        control?.onEstimate?.({ installed: 6, expected: 20, percent: 30, etaSeconds: 40 });
        await gate;
        onProgress?.({ phase: "finishing" });
        return { ok: true, directory: "x" };
      },
    });
    const b = handlerFor({ browserId: BROWSER_B, pid: OTHER_PID });
    const first = a.run({ type: "ui.conversation.install", payload: { agent: "codex" } });
    await waitFor(async () => (await readInstallState(data, "codex"))?.percent === 30, "broker A's progress in the file");

    const second = b.run({ type: "ui.conversation.install", payload: { agent: "codex" } });
    await waitFor(() => b.overviewAgent("codex")?.install?.percent === 30, "broker B's overview showing A's progress");
    const shown = b.overviewAgent("codex")!;
    expect(shown).toMatchObject({ installing: "downloading", install: { phase: "downloading", percent: 30, etaSeconds: 40, browserId: BROWSER_A } });
    expect(shown.install).not.toHaveProperty("pid");
    expect(conversationOverviewFrameSchema.safeParse(b.sent.filter((frame) => frame.type === "conversation-overview").at(-1)).success).toBe(true);

    finish();
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    expect(a.installs).toEqual(["codex"]);
    expect(b.installs).toEqual([]);
  });

  it("an install longer than the conversation idle time finishes, and the broker goes on answering", async () => {
    const { run, pool } = handlerFor({
      idleMs: 100,
      install: async () => {
        await sleep(600);
        return { ok: true, directory: "x" };
      },
    });
    expect(await run({ type: "ui.conversation.install", payload: { agent: "deepseek" } })).toMatchObject({ ok: true });
    expect(await readInstallState(data, "deepseek")).toMatchObject({ phase: "done" });
    expect(await run({ type: "ui.conversation.check-agents", payload: {} })).toMatchObject({ ok: true });
    expect(await pool.views()).toEqual([]);
  });
});

describe("024 T760 cancel (R-377)", () => {
  /**
   * A stand-in npm: `npm.cmd` beside the "node" the install uses, running a script that records its
   * pid and its child's, starts that child in the install folder (so a survivor would hold the folder
   * open), and writes package folders until it is killed.
   */
  async function slowNpm(): Promise<{ ports: InstallPorts; pids: string }> {
    await writeManifests();
    const bin = join(dir, "bin");
    const pids = join(dir, "npm-pids.txt");
    const script = join(dir, "slow-npm.mjs");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "node.exe"), "", "utf8");
    await writeFile(
      script,
      [
        'import { spawn } from "node:child_process";',
        'import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: process.cwd(), stdio: "ignore" });',
        `appendFileSync(${JSON.stringify(pids)}, process.pid + "\\n" + child.pid + "\\n");`,
        "let n = 0;",
        "setInterval(() => {",
        "  n += 1;",
        '  const folder = join(process.cwd(), "node_modules", "dep-" + n);',
        "  mkdirSync(folder, { recursive: true });",
        '  writeFileSync(join(folder, "package.json"), "{}");',
        "}, 100);",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(bin, "npm.cmd"), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
    return {
      pids,
      ports: { dataDir: data, manifestsDir: manifests, nodePath: join(bin, "node.exe"), run: runCommand, estimateIntervalMs: 100 },
    };
  }

  const readPids = async (path: string) =>
    (await readFile(path, "utf8").catch(() => ""))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map(Number);

  it("ends npm's process tree, removes its .install-* folder and the lock within 5 s; the agent needs a download again", async () => {
    const { ports, pids } = await slowNpm();
    const { run, overviewAgent, handler } = handlerFor({ install: (agent, onProgress, control) => installAgent(agent, ports, onProgress, control) });
    const download = run({ type: "ui.conversation.install", payload: { agent: "codex" } });
    await waitFor(async () => (await readPids(pids)).length >= 2, "npm and its child");
    spawned.push(...(await readPids(pids)));
    await waitFor(async () => (await readInstallState(data, "codex"))?.phase === "downloading", "the download under way", 15_000);

    const started = Date.now();
    expect(await run({ type: "ui.conversation.install-cancel", payload: { agent: "codex" } })).toMatchObject({ ok: true });
    expect(Date.now() - started).toBeLessThanOrEqual(5_000);

    for (const pid of await readPids(pids)) expect(isAlive(pid), `pid ${pid}`).toBe(false);
    const left = await readdir(join(data, "agents", "codex"));
    expect(left.filter((name) => name.startsWith(".install-"))).toEqual([]);
    expect(left).not.toContain("install.lock");
    expect(await readInstallState(data, "codex")).toMatchObject({ phase: "cancelled", endedAt: expect.any(String) });
    expect(await download).toMatchObject({ ok: false, error: { code: "install-failed" } });
    await handler.sendOverview();
    expect(overviewAgent("codex")).toMatchObject({ availability: "needs-install", install: { phase: "cancelled" } });
    expect(overviewAgent("codex")).not.toHaveProperty("installing");
  }, 30_000);

  it("cancel with nothing running is ok and changes nothing", async () => {
    const { run } = handlerFor();
    await writeInstallState(data, "deepseek", {
      phase: "failed",
      percent: 12,
      etaSeconds: null,
      startedAt: "2026-10-24T08:00:00.000Z",
      endedAt: "2026-10-24T08:01:00.000Z",
      browserId: BROWSER_A,
      pid: process.pid,
      error: "npm ci failed",
    });
    const before = await readFile(installStatePath(data, "deepseek"), "utf8");
    expect(await run({ type: "ui.conversation.install-cancel", payload: { agent: "deepseek" } })).toMatchObject({ ok: true });
    expect(await run({ type: "ui.conversation.install-cancel", payload: { agent: "codex" } })).toMatchObject({ ok: true });
    expect(await readFile(installStatePath(data, "deepseek"), "utf8")).toBe(before);
    expect(await readdir(join(data, "agents"))).toEqual(["deepseek"]);
  });
});

describe("024 T760 the tree's kill (R-377)", () => {
  /** A `taskkill` that cannot be started - the broker's PATH is broken, or System32 refuses it. */
  const unstartable = (seen: { file?: string; args?: readonly string[] } = {}) => (file: string, args: readonly string[]) => {
    seen.file = file;
    seen.args = args;
    const killer = new EventEmitter();
    queueMicrotask(() => killer.emit("error", Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" })));
    return killer;
  };

  it("runs taskkill by its System32 path and, when it cannot start, ends the process itself; a kill that fails says so", async () => {
    const seen: { file?: string; args?: readonly string[] } = {};
    const killed: number[] = [];
    expect(await killTreeAsync(4_000_123, { spawn: unstartable(seen), kill: (pid) => void killed.push(pid) })).toBe(true);
    expect(seen.file).toBe(win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"));
    expect(seen.args).toEqual(["/pid", "4000123", "/T", "/F"]);
    expect(killed).toEqual([4_000_123]);

    const refused = () => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    };
    expect(await killTreeAsync(4_000_123, { spawn: unstartable(), kill: refused })).toBe(false);
    // Already gone is what the kill was for.
    const gone = () => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    };
    expect(await killTreeAsync(4_000_123, { spawn: unstartable(), kill: gone })).toBe(true);
  });

  it("a cancel whose kill failed does not answer aborted", async () => {
    let pid: number | undefined;
    const controller = new AbortController();
    const running = runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      signal: controller.signal,
      timeoutMs: 60_000,
      killTree: async (target) => {
        pid = target;
        return false;
      },
    });
    await sleep(300);
    controller.abort();
    const result = await running;
    if (pid !== undefined) spawned.push(pid);
    expect(pid).toEqual(expect.any(Number));
    expect(result).not.toHaveProperty("aborted");
    expect(result).toMatchObject({ code: null, killFailed: true });
  }, 15_000);
});

describe("024 T762 interrupted (R-378)", () => {
  it("a state left running by a dead broker becomes interrupted at start, stays so until the next attempt, and cleanStaging still runs", async () => {
    const gone = await deadPid();
    const agentDir = join(data, "agents", "deepseek");
    await writeInstallState(data, "deepseek", {
      phase: "downloading",
      percent: 40,
      etaSeconds: 300,
      startedAt: "2026-10-24T08:00:00.000Z",
      browserId: BROWSER_A,
      pid: gone,
    });
    await writeFile(installLockPath(data, "deepseek"), JSON.stringify({ pid: gone, browserId: BROWSER_A }), "utf8");
    await mkdir(join(agentDir, `.install-${gone}-abc123`, "node_modules"), { recursive: true });

    const first = await prepareAgentsAtStart(data);
    expect(first.interrupted).toEqual(["deepseek"]);
    expect(first.staged).toEqual([join(agentDir, `.install-${gone}-abc123`)]);
    const interrupted = await readInstallState(data, "deepseek");
    expect(interrupted).toMatchObject({ phase: "interrupted", percent: 40, etaSeconds: null, endedAt: expect.any(String) });

    // Another start leaves it as it is.
    expect((await prepareAgentsAtStart(data)).interrupted).toEqual([]);
    expect(await readInstallState(data, "deepseek")).toEqual(interrupted);
    const { handler, overviewAgent } = handlerFor();
    await handler.sendOverview();
    expect(overviewAgent("deepseek")).toMatchObject({ install: { phase: "interrupted" } });

    // The next attempt overwrites it (the dead broker's stale lock does not hold it off).
    const { run } = handlerFor();
    expect(await run({ type: "ui.conversation.install", payload: { agent: "deepseek" } })).toMatchObject({ ok: true });
    expect(await readInstallState(data, "deepseek")).toMatchObject({ phase: "done", pid: process.pid });
  });
});
