import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_AGENTS,
  conversationAgentAvailabilitySchema,
  conversationOverviewFrameSchema,
  type AgentTestResult,
  type ConversationAgent,
  type ConversationAgentAvailability,
} from "@hallpass/contracts";
import {
  LAUNCH_EXEC_BOUND_MS,
  READINESS_EXEC_BOUND_MS,
  checkAgentReadiness,
  defaultAgentPorts,
  type AgentPorts,
  type ExecResult,
} from "../src/broker/agents.js";
import { SHARED_STATE_WATCH_IDLE_MS, createCommandHandler, type ConsentStore } from "../src/broker/commands.js";
import type { InstallResult } from "../src/broker/install.js";
import { writeInstallState, writeLastTest } from "../src/broker/shared-agent-state.js";
import { memoryConversationIndex, memoryFolderList } from "../src/broker/conversation-index.js";
import { ConversationPool } from "../src/broker/conversation.js";
import type { FolderActions } from "../src/broker/folders.js";
import { runCommand } from "../src/broker/run-command.js";
import type { UserEnvironmentPorts } from "../src/broker/user-environment.js";
import { FAKE_AGENT, makeTempDir, removeDir, sleep, waitFor } from "./conversation-harness.js";

/**
 * 024 T754 (R-374, D-024-19, FR-397, SC-177): `ui.conversation.check-agents` re-runs each agent's
 * local check - program found, the version it prints, the pinned package, Hermes' setup steps - in
 * parallel, each external command bounded at 5 s, so one program that does not answer `--version`
 * costs only its own row. The result is kept until Check again, a finished install or the next
 * settings-page connect (which sends `check-agents`). No model is called: the programs are asked
 * `--version` and nothing else.
 *
 * The "programs" are `.cmd` shims in a temporary folder; `where.exe` is answered by the test. The
 * hung one is the fake agent's `--version` (FAKE_ACP_VERSION_HANG, with its prompt counter); the
 * answering ones are a small script that prints a version for `--version` and, started any other
 * way (as an agent would be), records it in a counter file - the fake agent itself takes longer than
 * the 5 s bound just to load on a busy machine.
 */

const KEY_NAME = "HALLPASS_TEST_024_HERMES_KEY";

let dir: string;
let data: string;
let promptCount: string;
let startCount: string;
beforeEach(async () => {
  dir = await makeTempDir("hallpass-check-");
  data = join(dir, "data");
  promptCount = join(dir, "prompts.txt");
  startCount = join(dir, "starts.txt");
});
afterEach(async () => {
  await removeDir(dir);
});

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

async function writeShim(path: string, env: Record<string, string>, command: string): Promise<string> {
  await mkdir(win32.dirname(path), { recursive: true });
  const sets = Object.entries(env).map(([name, value]) => `set "${name}=${value}"`);
  await writeFile(path, ["@echo off", ...sets, command, ""].join("\r\n"), "utf8");
  return path;
}

/** A `.cmd` program that never answers `--version`: the fake agent's, counting any prompt it gets. */
const hungShim = (path: string) =>
  writeShim(path, { FAKE_ACP_VERSION_HANG: "1", FAKE_ACP_COUNT_PROMPTS: promptCount }, `"${process.execPath}" --experimental-strip-types "${FAKE_AGENT}" %*`);

/** A `.cmd` program that prints `version` for `--version`; started any other way, it notes it in `startCount`. */
async function shim(path: string, version: string): Promise<string> {
  const script = join(dir, "version-program.mjs");
  await writeFile(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      'if (process.argv.includes("--version")) console.log(process.env.TEST_PROGRAM_VERSION);',
      'else appendFileSync(process.env.TEST_PROGRAM_STARTS, process.argv.slice(2).join(" ") + "\\n");',
      "",
    ].join("\n"),
    "utf8",
  );
  return writeShim(path, { TEST_PROGRAM_VERSION: version, TEST_PROGRAM_STARTS: startCount }, `"${process.execPath}" "${script}" %*`);
}

type Exec = { file: string; timeoutMs: number | undefined };

/** The real file system under the temporary folder, `where.exe` from `where`, every other program run for real. */
function machine(where: Record<string, string[]>): { ports: AgentPorts; execs: Exec[] } {
  const execs: Exec[] = [];
  return {
    execs,
    ports: {
      dataDir: data,
      env: { USERPROFILE: join(dir, "home"), APPDATA: join(dir, "appdata"), ProgramFiles: join(dir, "program-files") },
      nodePath: process.execPath,
      codexShimEntry: join(dir, "no-shim.js"),
      fs: { exists, readText: (path) => readFile(path, "utf8"), writeText: async () => undefined },
      exec: async (file, args, options) => {
        execs.push({ file, timeoutMs: options?.timeoutMs });
        if (file === "where.exe") {
          const lines = where[args[0] ?? ""];
          return lines === undefined ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: `${lines.join("\r\n")}\r\n`, stderr: "" };
        }
        const { code, stdout, stderr, timedOut } = await runCommand(file, args, { timeoutMs: options?.timeoutMs ?? 15_000 });
        return { code, stdout, stderr, timedOut };
      },
    },
  };
}

/** Hermes' settings naming its key variable, and the user's settings holding that name (not the browser's environment). */
function userEnvironment(home: string, userNames: string[]): UserEnvironmentPorts {
  return {
    readText: async (path) => {
      if (path === win32.join(home, "config.yaml")) return `model:\n  provider: custom\n  key_env: ${KEY_NAME}\n`;
      throw Object.assign(new Error("not there"), { code: "ENOENT" });
    },
    run: async () => ({ code: 0, stdout: `${userNames.join("\r\n")}\r\n` }),
  };
}

async function fourAgents() {
  const claude = await hungShim(join(dir, "bin", "claude.cmd"));
  const codex = await shim(join(dir, "bin", "codex.cmd"), "codex-cli 0.163.0");
  // A venv layout: the program in `Scripts`, Hermes' optional MCP component in its site-packages.
  const hermes = await shim(join(dir, "hermes-venv", "Scripts", "hermes.cmd"), "Hermes Agent v0.22.2");
  await mkdir(join(dir, "hermes-venv", "Lib", "site-packages", "mcp"), { recursive: true });
  await writeFile(join(dir, "hermes-venv", "Lib", "site-packages", "mcp", "__init__.py"), "", "utf8");
  const home = join(dir, "hermes-home");
  const m = machine({ "claude.exe": [claude], "codex.cmd": [codex], hermes: [hermes] });
  const check = (agent: ConversationAgent) =>
    checkAgentReadiness(agent, m.ports, { env: { HERMES_HOME: home }, userEnvironment: userEnvironment(home, ["Path", KEY_NAME]) }).then(
      (status) => status.availability,
    );
  return { ...m, check };
}

describe("024 T754 the local readiness check", () => {
  it("bounds each command at 5 s: a hung --version costs only its own agent, and nothing calls a model", async () => {
    const { check, execs } = await fourAgents();
    const started = Date.now();
    const results = await Promise.all(CONVERSATION_AGENTS.map(check));
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThanOrEqual(6_000);

    const byAgent = Object.fromEntries(results.map((entry) => [entry.agent, entry])) as Record<ConversationAgent, ConversationAgentAvailability>;
    for (const entry of results) expect(conversationAgentAvailabilitySchema.safeParse(entry).success, entry.agent).toBe(true);
    expect(byAgent["claude-code"]).toMatchObject({ availability: "version-problem", detail: expect.stringMatching(/did not answer/u) });
    expect(byAgent.codex).toMatchObject({ availability: "needs-install", version: "0.163.0", browserTools: "needs-helper" });
    expect(byAgent.hermes).toMatchObject({ availability: "ready", version: "0.22.2", notes: ["git-missing"], browserTools: "available" });
    expect(byAgent.hermes.setupSteps).toEqual([
      { step: "git", found: false },
      { step: "hermes", found: true },
      { step: "mcp-component", found: true },
      { step: "key-variable", found: true },
      // In the user's settings, not in what this browser was started with: a full restart is not done.
      { step: "browser-restart", found: false },
    ]);
    expect(byAgent.deepseek).toMatchObject({ availability: "needs-install", notes: ["pre-release"], browserTools: "not-supported" });
    for (const entry of results) expect(Date.parse(entry.checkedAt ?? "")).toBeGreaterThanOrEqual(started - 1);

    // Every external command went with the readiness bound, none with the 15 s launch bound.
    expect(execs.length).toBeGreaterThan(0);
    for (const exec of execs) expect(exec.timeoutMs, exec.file).toBe(READINESS_EXEC_BOUND_MS);
    expect(READINESS_EXEC_BOUND_MS).toBe(5_000);
    // `--version` only: no program was started as an agent, and no prompt was counted.
    expect(await exists(startCount)).toBe(false);
    expect(await exists(promptCount)).toBe(false);
  }, 20_000);

  it("counts a .cmd shim as found and says why a path Hallpass refuses to run is not installed", async () => {
    const safe = await shim(join(dir, "bin", "codex.cmd"), "codex-cli 0.163.0");
    const found = await checkAgentReadiness("codex", machine({ "codex.cmd": [safe] }).ports);
    expect(found.availability).toMatchObject({ availability: "needs-install", version: "0.163.0" });
    expect(found.cliPath).toBe(safe);

    const refused = await shim(join(dir, "100%", "codex.cmd"), "codex-cli 0.163.0");
    const status = await checkAgentReadiness("codex", machine({ "codex.cmd": [refused] }).ports);
    expect(status.availability).toMatchObject({ agent: "codex", availability: "missing", detail: expect.stringMatching(/will not run/u) });
    expect(status.availability.detail).not.toContain(dir);
    expect(status.cliPath).toBeUndefined();
  }, 20_000);
});

describe("024 T755 check-agents in the broker", () => {
  function handlerWith(check: (agent: ConversationAgent) => Promise<ConversationAgentAvailability>) {
    const sent: Record<string, unknown>[] = [];
    const calls: ConversationAgent[] = [];
    const index = memoryConversationIndex();
    const folders = memoryFolderList();
    const pool = new ConversationPool({
      dataDir: data,
      browserRunId: "run-check",
      index,
      folders,
      resolveLaunch: async () => ({ ok: false, error: { code: "agent-missing", detail: "no launches in this test" } }),
      onEvent: () => undefined,
    });
    const consent: ConsentStore = { read: async () => "granted", write: async () => undefined };
    const handler = createCommandHandler({
      sessionId: "broker-check",
      send: (frame) => sent.push(frame as Record<string, unknown>) > 0,
      pool,
      index,
      folders,
      consent,
      folderActions: {} as FolderActions,
      availability: async (agent) => ({ agent, availability: "ready" }),
      checkAgent: async (agent) => {
        calls.push(agent);
        return { availability: await check(agent) };
      },
      install: async () => ({ ok: true, directory: "x" }),
    });
    let counter = 0;
    const run = async (command: unknown) => {
      const commandId = `c-${++counter}`;
      await handler.handle({ type: "conversation-command", sessionId: "broker-check", commandId, command });
      return sent.find((frame) => frame.type === "conversation-result" && frame.commandId === commandId) as { ok: boolean };
    };
    const overviews = () => sent.filter((frame) => frame.type === "conversation-overview");
    return { handler, run, calls, overviews, pool };
  }

  it("answers with a fresh overview, keeps the result until asked again, and re-checks one agent alone", async () => {
    let version = "0.163.0";
    const { handler, run, calls, overviews, pool } = handlerWith(async (agent) => ({
      agent,
      availability: "ready",
      version: agent === "codex" ? version : "1.0.0",
      checkedAt: new Date().toISOString(),
    }));
    try {
      await handler.sendOverview();
      await handler.sendOverview();
      expect(calls.sort()).toEqual([...CONVERSATION_AGENTS].sort());

      calls.length = 0;
      version = "0.164.0";
      expect(await run({ type: "ui.conversation.check-agents", payload: {} })).toMatchObject({ ok: true });
      expect(calls.sort()).toEqual([...CONVERSATION_AGENTS].sort());
      const codexVersion = () =>
        (overviews().at(-1)?.agents as ConversationAgentAvailability[] | undefined)?.find((entry) => entry.agent === "codex")?.version;
      await waitFor(() => codexVersion() === "0.164.0", "the overview after the check");
      const latest = overviews().at(-1)!;
      expect(conversationOverviewFrameSchema.safeParse(latest).success).toBe(true);
      expect((latest.agents as ConversationAgentAvailability[]).find((entry) => entry.agent === "codex")?.version).toBe("0.164.0");

      calls.length = 0;
      expect(await run({ type: "ui.conversation.check-agents", payload: { agent: "hermes" } })).toMatchObject({ ok: true });
      expect(calls).toEqual(["hermes"]);
      // Overviews in between do not check again.
      await handler.sendOverview();
      expect(calls).toEqual(["hermes"]);
    } finally {
      await pool.shutdown();
    }
  });

  it("re-checks the agent after its install finishes", async () => {
    const { run, calls, pool } = handlerWith(async (agent) => ({ agent, availability: "needs-install" }));
    try {
      await run({ type: "ui.conversation.check-agents", payload: {} });
      calls.length = 0;
      expect(await run({ type: "ui.conversation.install", payload: { agent: "codex" } })).toMatchObject({ ok: true });
      expect(calls).toContain("codex");
    } finally {
      await pool.shutdown();
    }
  });
});

describe("024 T755 / R-375 how long the shared files are watched", () => {
  const lastTest = (ranAt: string): AgentTestResult => ({ outcome: "passed", start: "ok", model: { answered: true, ms: 10 }, browserTools: "available", ranAt });

  /** A handler sharing the files in `data`, its install the test's; the clock's Date is the test's to move. */
  function sharedHandler(install: () => Promise<InstallResult> = async () => ({ ok: true, directory: "x" }), isAlive?: (pid: number) => boolean) {
    const sent: Record<string, unknown>[] = [];
    const index = memoryConversationIndex();
    const folders = memoryFolderList();
    const pool = new ConversationPool({
      dataDir: data,
      browserRunId: "run-watch",
      index,
      folders,
      resolveLaunch: async () => ({ ok: false, error: { code: "agent-missing", detail: "no launches in this test" } }),
      onEvent: () => undefined,
    });
    const consent: ConsentStore = { read: async () => "granted", write: async () => undefined };
    const handler = createCommandHandler({
      sessionId: "broker-watch",
      send: (frame) => sent.push(frame as Record<string, unknown>) > 0,
      pool,
      index,
      folders,
      consent,
      folderActions: {} as FolderActions,
      availability: async (agent) => ({ agent, availability: "ready" }),
      checkAgent: async (agent) => ({ availability: { agent, availability: "ready" } }),
      install,
      shared: { dataDir: data, browserId: "chrome-a1", pid: process.pid, ...(isAlive === undefined ? {} : { isAlive }) },
    });
    let counter = 0;
    const run = (command: unknown) => handler.handle({ type: "conversation-command", sessionId: "broker-watch", commandId: `w-${++counter}`, command });
    const overviews = () => sent.filter((frame) => frame.type === "conversation-overview");
    return { handler, run, overviews, pool };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends by itself once no check-agents came for the bound and nothing runs here; the next check-agents watches again", async () => {
    const { handler, run, overviews, pool } = sharedHandler();
    try {
      await run({ type: "ui.conversation.check-agents", payload: {} });
      await waitFor(() => overviews().length >= 1, "the check's overview");
      await sleep(200);
      // Watched: another broker's test result arrives as an overview.
      let before = overviews().length;
      await writeLastTest(data, "codex", lastTest("2026-10-24T08:00:00.000Z"));
      await waitFor(() => overviews().length > before, "the other broker's change", 3_000);

      // No check-agents for longer than the bound: the next look ends the watch instead.
      vi.setSystemTime(Date.now() + SHARED_STATE_WATCH_IDLE_MS + 1_000);
      await sleep(1_300);
      before = overviews().length;
      await writeLastTest(data, "codex", lastTest("2026-10-24T08:01:00.000Z"));
      await sleep(1_500);
      expect(overviews().length).toBe(before);

      // The page's next connect sends check-agents, which watches again.
      await run({ type: "ui.conversation.check-agents", payload: {} });
      await waitFor(() => overviews().length > before, "the second check's overview");
      await sleep(200);
      before = overviews().length;
      await writeLastTest(data, "codex", lastTest("2026-10-24T08:02:00.000Z"));
      await waitFor(() => overviews().length > before, "the change after the second check", 3_000);
    } finally {
      handler.stopWatching();
      await pool.shutdown();
    }
  }, 30_000);

  it("goes on past the bound while another browser's broker runs a download, and ends once it is done", async () => {
    const OTHER_PID = 4_000_001;
    const { handler, run, overviews, pool } = sharedHandler(undefined, (pid) => pid === OTHER_PID || pid === process.pid);
    const other = (phase: "downloading" | "done", percent: number) =>
      writeInstallState(data, "codex", {
        phase,
        percent,
        etaSeconds: phase === "done" ? null : 30,
        startedAt: "2026-10-24T08:00:00.000Z",
        browserId: "edge-b1",
        pid: OTHER_PID,
      });
    const codexInstall = (frame: Record<string, unknown>) =>
      (frame.agents as { agent: string; install?: { phase: string; percent: number | null } }[]).find((entry) => entry.agent === "codex")?.install;
    const shown = (phase: string, percent: number) =>
      overviews().some((frame) => codexInstall(frame)?.phase === phase && codexInstall(frame)?.percent === percent);
    try {
      await run({ type: "ui.conversation.check-agents", payload: {} });
      await waitFor(() => overviews().length >= 1, "the check's overview");
      await sleep(200);
      await other("downloading", 10);
      await waitFor(() => shown("downloading", 10), "the other browser's download", 3_000);

      // The page stays open past the bound with no check-agents: the other download still shows its progress here.
      vi.setSystemTime(Date.now() + SHARED_STATE_WATCH_IDLE_MS + 1_000);
      await sleep(1_300);
      await other("downloading", 60);
      await waitFor(() => shown("downloading", 60), "the other download's progress past the bound", 3_000);
      // And its end, from which the page tells the owner the download is done.
      await other("done", 100);
      await waitFor(() => shown("done", 100), "the other download's end past the bound", 3_000);

      // Nothing runs any more and no check-agents came: the watch ends by itself as before.
      await sleep(1_300);
      const before = overviews().length;
      await writeLastTest(data, "codex", lastTest("2026-10-24T08:03:00.000Z"));
      await sleep(1_500);
      expect(overviews().length).toBe(before);
    } finally {
      handler.stopWatching();
      await pool.shutdown();
    }
  }, 30_000);

  it("goes on past the bound while this broker's install runs, with one overview for each change of its own state", async () => {
    let release: ((result: InstallResult) => void) | undefined;
    const { handler, run, overviews, pool } = sharedHandler(() => new Promise<InstallResult>((done) => (release = done)));
    const preparing = () =>
      overviews().filter((frame) =>
        (frame.agents as { agent: string; install?: { phase: string } }[]).some((entry) => entry.agent === "codex" && entry.install?.phase === "preparing"),
      );
    try {
      await run({ type: "ui.conversation.check-agents", payload: {} });
      await waitFor(() => overviews().length >= 1, "the check's overview");
      const download = run({ type: "ui.conversation.install", payload: { agent: "codex" } });
      await waitFor(() => preparing().length >= 1, "the overview of the state this broker wrote");
      // The watch reads the same file a moment later: not a change the page has not been sent.
      await sleep(1_500);
      expect(preparing()).toHaveLength(1);

      vi.setSystemTime(Date.now() + SHARED_STATE_WATCH_IDLE_MS + 1_000);
      await sleep(1_300);
      const before = overviews().length;
      await writeLastTest(data, "deepseek", lastTest("2026-10-24T08:00:00.000Z"));
      await waitFor(() => overviews().length > before, "another broker's change during the install", 3_000);

      await waitFor(() => release !== undefined, "the install under way");
      release?.({ ok: true, directory: "x" });
      await download;
    } finally {
      handler.stopWatching();
      await pool.shutdown();
    }
  }, 30_000);
});

describe("024 R-374 a found program whose --version is slower than the readiness bound", () => {
  const HERMES = "C:\\Tools\\hermes\\Scripts\\hermes.exe";
  type VersionExec = {
    timeoutMs: number | undefined;
    signal: AbortSignal | undefined;
    answer: (version: string) => void;
    /** Answers code 0 with `stdout` as it is (no version line around it). */
    answerRaw: (stdout: string) => void;
  };
  type Check = NonNullable<Parameters<typeof createCommandHandler>[0]["checkAgent"]>;

  /**
   * Hermes found by `where.exe`, its `--version` slower than 5 s (T794 measured 6-11 s): a call
   * bounded below `answersAfterMs` ends at its bound (`timedOut`), a longer one waits for the test
   * to answer it - so nothing sleeps for real. Every other agent is not there.
   */
  function slowHermes(answersAfterMs = 6_000) {
    const versions: VersionExec[] = [];
    const ports: AgentPorts = {
      dataDir: "C:\\Data\\hallpass",
      env: {},
      nodePath: process.execPath,
      codexShimEntry: "C:\\no-shim.js",
      fs: { exists: async (path) => path === HERMES, readText: async () => "", writeText: async () => undefined },
      exec: async (file, args, options) => {
        if (file === "where.exe") return args[0] === "hermes" ? { code: 0, stdout: `${HERMES}\r\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
        if (file !== HERMES || args[0] !== "--version") return { code: 1, stdout: "", stderr: "" };
        if ((options?.timeoutMs ?? LAUNCH_EXEC_BOUND_MS) < answersAfterMs) return { code: null, stdout: "", stderr: "", timedOut: true };
        return new Promise<ExecResult>((done) => {
          versions.push({
            timeoutMs: options?.timeoutMs,
            signal: options?.signal,
            answer: (version) => done({ code: 0, stdout: `Hermes Agent v${version} (2026.9.24)\r\n`, stderr: "" }),
            answerRaw: (stdout) => done({ code: 0, stdout, stderr: "" }),
          });
        });
      },
    };
    const userEnvironment: UserEnvironmentPorts = { readText: async () => "", run: async () => ({ code: 0, stdout: "" }) };
    const check: Check = (agent, attempt) =>
      checkAgentReadiness(agent, ports, { env: {}, userEnvironment, ...(attempt === undefined ? {} : { boundMs: attempt.boundMs, signal: attempt.signal }) });
    return { versions, check };
  }

  function retryHandler(check: Check) {
    const sent: Record<string, unknown>[] = [];
    const index = memoryConversationIndex();
    const folders = memoryFolderList();
    const pool = new ConversationPool({
      dataDir: data,
      browserRunId: "run-retry",
      index,
      folders,
      resolveLaunch: async () => ({ ok: false, error: { code: "agent-missing", detail: "no launches in this test" } }),
      onEvent: () => undefined,
    });
    const handler = createCommandHandler({
      sessionId: "broker-retry",
      send: (frame) => sent.push(frame as Record<string, unknown>) > 0,
      pool,
      index,
      folders,
      consent: { read: async () => "granted", write: async () => undefined },
      folderActions: {} as FolderActions,
      availability: async (agent) => ({ agent, availability: "ready" }),
      checkAgent: check,
      install: async () => ({ ok: true, directory: "x" }),
    });
    let counter = 0;
    const run = (command: unknown) => handler.handle({ type: "conversation-command", sessionId: "broker-retry", commandId: `r-${++counter}`, command });
    const hermes = () =>
      (sent.filter((frame) => frame.type === "conversation-overview").at(-1)?.agents as ConversationAgentAvailability[] | undefined)?.find(
        (entry) => entry.agent === "hermes",
      );
    return { handler, run, hermes, pool };
  }

  const TIMED_OUT_5S = "Hermes was found, but did not answer `--version` within 5 s.";

  it("the timed-out detail is chosen for a program run through cmd.exe as well (a .cmd shim)", async () => {
    const codex = "C:\\Users\\owner\\AppData\\Roaming\\npm\\codex.cmd";
    const ports: AgentPorts = {
      dataDir: "C:\\Data\\hallpass",
      env: {},
      nodePath: process.execPath,
      codexShimEntry: "C:\\no-shim.js",
      fs: { exists: async (path) => path === codex, readText: async () => "", writeText: async () => undefined },
      exec: async (file, args) =>
        file === "where.exe"
          ? { code: 0, stdout: `${codex}\r\n`, stderr: "" }
          : file === codex && args[0] === "--version"
            ? { code: null, stdout: "", stderr: "", timedOut: true }
            : { code: 1, stdout: "", stderr: "" },
    };
    const status = await checkAgentReadiness("codex", ports);
    expect(status.availability).toMatchObject({ availability: "version-problem", detail: "Codex was found, but did not answer `--version` within 5 s." });
    expect(status.versionTimedOut).toBe(true);
  });

  it("shows Not installed with the timed-out reason first, then Ready once the one retry at the launch bound answers", async () => {
    const { versions, check } = slowHermes();
    const { handler, run, hermes, pool } = retryHandler(check);
    try {
      // The check answers, and its overview goes, while the retry still runs: it holds nothing else.
      await run({ type: "ui.conversation.check-agents", payload: {} });
      await waitFor(() => hermes() !== undefined, "the check's overview");
      expect(hermes()).toMatchObject({ availability: "version-problem", detail: TIMED_OUT_5S });
      await waitFor(() => versions.length === 1, "the retry under way");
      expect(versions[0]?.timeoutMs).toBe(LAUNCH_EXEC_BOUND_MS);

      versions[0]?.answer("0.22.2");
      await waitFor(() => hermes()?.availability === "ready", "the retry's overview");
      expect(hermes()).toMatchObject({ availability: "ready", version: "0.22.2" });
      expect(conversationAgentAvailabilitySchema.safeParse(hermes()).success).toBe(true);
      // Once: nothing started a second retry.
      await sleep(50);
      expect(versions).toHaveLength(1);
    } finally {
      handler.stopChecks();
      await pool.shutdown();
    }
  });

  it("the overview names the timed-out answer (versionTimedOut, in the contract), and drops it once the retry answers", async () => {
    const { versions, check } = slowHermes();
    const { handler, run, hermes, pool } = retryHandler(check);
    try {
      await run({ type: "ui.conversation.check-agents", payload: {} });
      await waitFor(() => hermes() !== undefined, "the check's overview");
      expect(hermes()).toMatchObject({ availability: "version-problem", detail: TIMED_OUT_5S, versionTimedOut: true });
      expect(conversationAgentAvailabilitySchema.safeParse(hermes()).success).toBe(true);
      await waitFor(() => versions.length === 1, "the retry under way");
      versions[0]?.answer("0.22.2");
      await waitFor(() => hermes()?.availability === "ready", "the retry's overview");
      expect(hermes()?.versionTimedOut).toBeUndefined();
    } finally {
      handler.stopChecks();
      await pool.shutdown();
    }
  });

  it("a retry whose --version answers code 0 with no version in it keeps the first, timed-out answer", async () => {
    const { versions, check } = slowHermes();
    const { handler, run, hermes, pool } = retryHandler(check);
    try {
      await run({ type: "ui.conversation.check-agents", payload: {} });
      await waitFor(() => versions.length === 1, "the retry under way");
      versions[0]?.answerRaw("usage: hermes [options]\r\n");
      await sleep(100);
      await handler.sendOverview();
      expect(hermes()).toMatchObject({ availability: "version-problem", detail: TIMED_OUT_5S, versionTimedOut: true });
      expect(hermes()?.version).toBeUndefined();
    } finally {
      handler.stopChecks();
      await pool.shutdown();
    }
  });

  it("the check's abort reaches the HKCU\\Environment query of Hermes' key step", async () => {
    const home = "C:\\Users\\owner\\.hermes";
    const signals: (AbortSignal | undefined)[] = [];
    const environment: UserEnvironmentPorts = {
      readText: async (path) => {
        if (path === win32.join(home, "config.yaml")) return `model:\n  provider: custom\n  key_env: ${KEY_NAME}\n`;
        throw Object.assign(new Error("not there"), { code: "ENOENT" });
      },
      run: async (_file, _args, options) => {
        signals.push(options?.signal);
        return { code: 0, stdout: "" };
      },
    };
    const controller = new AbortController();
    const ports: AgentPorts = {
      dataDir: "C:\\Data\\hallpass",
      env: {},
      nodePath: process.execPath,
      codexShimEntry: "C:\\no-shim.js",
      fs: { exists: async () => false, readText: async () => "", writeText: async () => undefined },
      exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    };
    await checkAgentReadiness("hermes", ports, { env: { HERMES_HOME: home }, userEnvironment: environment, signal: controller.signal });
    expect(signals).toEqual([controller.signal]);
  });

  it("defaultAgentPorts.exec hands its signal to the command: aborted, a sleeping child ends at once", async () => {
    const pidFile = join(dir, "child.pid");
    const script = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`;
    const ports = defaultAgentPorts(join(dir, "no-shim.js"), {});
    const controller = new AbortController();
    const started = Date.now();
    // A bound well inside the test's: without the signal the run would end only there, timed out.
    const exec = ports.exec(process.execPath, ["-e", script], { timeoutMs: 20_000, signal: controller.signal });
    await waitFor(() => exists(pidFile), "the child under way");
    const pid = Number(await readFile(pidFile, "utf8"));
    controller.abort();
    const result = await exec;
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.timedOut).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);

  it("a retry that also times out leaves Not installed with the timed-out reason", async () => {
    const { check } = slowHermes(60_000);
    const { handler, run, hermes, pool } = retryHandler(check);
    try {
      await run({ type: "ui.conversation.check-agents", payload: {} });
      await waitFor(() => hermes() !== undefined, "the check's overview");
      await sleep(100);
      await handler.sendOverview();
      expect(hermes()).toMatchObject({ availability: "version-problem", detail: TIMED_OUT_5S });
    } finally {
      handler.stopChecks();
      await pool.shutdown();
    }
  });

  it("a retry superseded by a newer check is stopped and never overwrites it", async () => {
    const { versions, check } = slowHermes();
    let newer = false;
    const { handler, run, hermes, pool } = retryHandler(async (agent, attempt) => {
      // Check again finds a newer Hermes that answers at once.
      if (newer && agent === "hermes") {
        return { availability: { agent, availability: "version-problem", version: "0.23.0", detail: "Hallpass works with Hermes 0.22.2; this computer has Hermes 0.23.0." } };
      }
      return check(agent, attempt);
    });
    try {
      await run({ type: "ui.conversation.check-agents", payload: {} });
      await waitFor(() => versions.length === 1, "the first retry under way");

      newer = true;
      await run({ type: "ui.conversation.check-agents", payload: { agent: "hermes" } });
      await waitFor(() => hermes()?.version === "0.23.0", "the newer check's overview");
      expect(versions[0]?.signal?.aborted).toBe(true);

      // The old retry answers late: the newer result stands.
      versions[0]?.answer("0.22.2");
      await sleep(100);
      await handler.sendOverview();
      expect(hermes()).toMatchObject({ availability: "version-problem", version: "0.23.0" });
    } finally {
      handler.stopChecks();
      await pool.shutdown();
    }
  });

  it("stopChecks (the broker's shutdown) ends a running retry, and its late answer is not applied", async () => {
    const { versions, check } = slowHermes();
    const { handler, run, hermes, pool } = retryHandler(check);
    try {
      await run({ type: "ui.conversation.check-agents", payload: {} });
      await waitFor(() => versions.length === 1, "the retry under way");
      handler.stopChecks();
      expect(versions[0]?.signal?.aborted).toBe(true);
      versions[0]?.answer("0.22.2");
      await sleep(100);
      await handler.sendOverview();
      expect(hermes()).toMatchObject({ availability: "version-problem", detail: TIMED_OUT_5S });
    } finally {
      await pool.shutdown();
    }
  });
});
