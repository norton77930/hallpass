import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dialRelay, encodeFrame, FrameDecoder } from "../src/index.js";

/**
 * 019/T522 — the broker's lifetime is the browser run's, and its whole process tree goes with it
 * (R-312, R-313, SC-136; quickstart §2).
 *
 * This drives the built `dist/native-host.js` as Chrome does (its stdio is the native port, as in
 * relay-process.test.ts), and the relay starts the built `dist/broker.js`. The broker's agent is the
 * fake ACP agent started through `cmd.exe` with a child and a detached grandchild - the `codex.cmd`
 * shape that Node's own job lets survive a hard kill. The agent is a real conversation start
 * (T540): the test plays the worker and sends `ui.conversation.start` to the broker's session, and
 * the test-mode override (`HALLPASS_TEST_MODE=1` + `HALLPASS_BROKER_TEST_AGENT`, a JSON argv) puts
 * the fake in place of the installed adapter. The one-time consent is written beforehand.
 *
 * Windows only, like the product: the job object is the thing under test.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_ENTRY = resolve(HERE, "..", "dist", "native-host.js");
const REPO_ROOT = resolve(HERE, "..", "..", "..");
/**
 * Absolute: the agent runs in its conversation's scratch folder. Only the last argument can hold a
 * space, so `cmd.exe /c` sees a line that does not start with a quote and keeps the quotes as they are.
 */
const AGENT_ARGV = ["cmd.exe", "/c", "node", "--experimental-strip-types", join(REPO_ROOT, "tests", "harness", "fake-acp-agent.ts")];

const BROWSER_ID = "c0ffee00-0000-4000-8000-0000000000b1";
const RUN_1 = "run-019-one";
const RUN_2 = "run-019-two";

type Tree = { broker: number; cmd: number; agent: number; child: number; detached: number };

describe.runIf(process.platform === "win32")("T522 broker lifetime", () => {
  let dataDir = "";
  const relays: ChildProcessWithoutNullStreams[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hallpass-broker-"));
    // T558: the broker's consent is this browser's own file.
    await mkdir(join(hostDir(), "conversation-consent"), { recursive: true });
    await writeFile(
      join(hostDir(), "conversation-consent", `${BROWSER_ID}.json`),
      JSON.stringify({ granted: true, at: new Date().toISOString() }),
    );
  });

  afterEach(async () => {
    for (const relay of relays) relay.kill();
    relays.length = 0;
    // Every pid this test's trees ever had: brokers from the sidecar and the log, agents and their
    // children from the fake agent's log. Nothing is left running whatever the assertions said.
    for (const pid of await everyPid()) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      dataDir = "";
    }
  });

  const hostDir = () => join(dataDir, "hallpass");
  const sidecarPath = () => join(hostDir(), "brokers", `${BROWSER_ID}.json`);
  const fakeLogPath = () => join(dataDir, "fake-acp.log");

  /**
   * A relay as Chrome starts it. With `startConversation`, the test plays the worker once the broker
   * greets: one `ui.conversation.start` to the broker's session, which is what starts the agent tree.
   */
  function startRelay(
    browserRunId: string,
    { startConversation = true }: { startConversation?: boolean } = {},
  ): { child: ChildProcessWithoutNullStreams; toChrome: unknown[] } {
    return playWorker(spawn(process.execPath, [RELAY_ENTRY], relayOptions()), browserRunId, startConversation);
  }

  /**
   * T575: a stand-in for the browser's main process that starts the relay as Chrome does - through
   * `cmd.exe /d /s /c "<launcher>"`, the relay on the browser's own stdio - and then stays. Node's
   * own job ends the shell with the stand-in (the relay below it breaks away silently); with Chrome
   * the shell ends when its relay does. Either way the relay's pipe is what the test closes.
   */
  function startRelayUnderBrowser(browserRunId: string): { child: ChildProcessWithoutNullStreams; toChrome: unknown[] } {
    const script = [
      `const { spawn } = require("node:child_process");`,
      `const [node, entry] = process.argv.slice(1);`,
      `spawn("cmd.exe", ["/d", "/s", "/c", '""' + node + '" "' + entry + '""'],`,
      `  { stdio: "inherit", windowsHide: true, windowsVerbatimArguments: true });`,
      `setInterval(() => {}, 1000);`,
    ].join("\n");
    return playWorker(
      spawn(process.execPath, ["-e", script, process.execPath, RELAY_ENTRY], relayOptions()),
      browserRunId,
      true,
    );
  }

  function relayOptions() {
    return {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        LOCALAPPDATA: dataDir,
        HALLPASS_TEST_MODE: "1",
        HALLPASS_BROKER_TEST_AGENT: JSON.stringify(AGENT_ARGV),
        FAKE_ACP_SPAWN_CHILD: "1",
        FAKE_ACP_SPAWN_DETACHED: "1",
        FAKE_ACP_LOG: fakeLogPath(),
      },
      stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    };
  }

  function playWorker(
    child: ChildProcessWithoutNullStreams,
    browserRunId: string,
    startConversation: boolean,
  ): { child: ChildProcessWithoutNullStreams; toChrome: unknown[] } {
    const toChrome: unknown[] = [];
    const decoder = new FrameDecoder();
    child.stdout.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(new Uint8Array(chunk))) {
        toChrome.push(frame);
        if (isFrame(frame, "relay-started")) {
          child.stdin.write(
            encodeFrame({
              type: "relay-ack",
              relayPid: (frame as { relayPid: number }).relayPid,
              browserRunId,
              browserId: BROWSER_ID,
              browserKind: "chrome",
            }),
          );
        }
        if (startConversation && isFrame(frame, "hello") && (frame as { role?: unknown }).role === "broker") {
          child.stdin.write(
            encodeFrame({
              type: "conversation-command",
              sessionId: (frame as { sessionId: string }).sessionId,
              commandId: "lifetime-start",
              command: { type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" } } },
            }),
          );
        }
      }
    });
    child.stderr.resume();
    relays.push(child);
    return { child, toChrome };
  }

  async function readSidecar(): Promise<Record<string, unknown> | undefined> {
    try {
      return JSON.parse(await readFile(sidecarPath(), "utf8")) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  async function readLines(path: string): Promise<string[]> {
    try {
      return (await readFile(path, "utf8")).split(/\r?\n/u).filter((line) => line.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * The broker's test agent (`cmd.exe`, from the broker's log), the fake agent and its two children
   * (from the fake agent's log). One tree per test is found this way, before any second broker
   * starts, so the first start line and the children after it are that tree's.
   */
  async function treeOf(broker: number): Promise<Tree | undefined> {
    const brokerLog = await readLines(join(hostDir(), "broker.log"));
    const started = brokerLog
      .map((line) => /broker\.agent-started broker=(\d+) pid=(\d+)/u.exec(line))
      .find((match) => match !== null && Number(match[1]) === broker);
    if (!started) return undefined;
    const events = (await readLines(fakeLogPath())).map((line) => JSON.parse(line) as Record<string, unknown>);
    const start = events.findIndex((event) => event.event === "start");
    if (start < 0) return undefined;
    const children = events.slice(start + 1).filter((event) => event.event === "child");
    const child = children.find((event) => event.detached === false)?.pid as number | undefined;
    const detached = children.find((event) => event.detached === true)?.pid as number | undefined;
    if (child === undefined || detached === undefined) return undefined;
    return { broker, cmd: Number(started[2]), agent: events[start]!.pid as number, child, detached };
  }

  async function waitForTree(): Promise<Tree> {
    let tree: Tree | undefined;
    await waitFor(
      async () => {
        const sidecar = await readSidecar();
        if (typeof sidecar?.pid !== "number") return false;
        tree = await treeOf(sidecar.pid);
        return tree !== undefined;
      },
      "the broker and its agent tree",
      20_000,
    );
    // The shape under test: the agent really is cmd.exe's child, so the detached grandchild is two
    // hops from the broker - the path Node's own job lets escape.
    expect(await parentOf(tree!.agent)).toBe(tree!.cmd);
    expect(await parentOf(tree!.cmd)).toBe(tree!.broker);
    return tree!;
  }

  async function everyPid(): Promise<number[]> {
    const pids = new Set<number>();
    const sidecar = await readSidecar();
    if (typeof sidecar?.pid === "number") pids.add(sidecar.pid);
    for (const line of await readLines(join(hostDir(), "broker.log"))) {
      for (const match of line.matchAll(/(?:broker\.started|broker=|pid=)(?: )?(\d+)/gu)) pids.add(Number(match[1]));
    }
    for (const line of await readLines(fakeLogPath())) {
      const pid = (JSON.parse(line) as { pid?: unknown }).pid;
      if (typeof pid === "number") pids.add(pid);
    }
    pids.delete(process.pid);
    return [...pids];
  }

  const treePids = (tree: Tree) => [tree.broker, tree.cmd, tree.agent, tree.child, tree.detached];
  const alive = (tree: Tree) => treePids(tree).filter(isAlive);

  function brokerGreeted(toChrome: unknown[]): boolean {
    return toChrome.some((frame) => isFrame(frame, "hello") && (frame as { role?: unknown }).role === "broker");
  }

  it("(a) after the ack the relay spawns the broker and writes its sidecar", async () => {
    const relay = startRelay(RUN_1);

    await waitFor(async () => (await readSidecar()) !== undefined, "the broker sidecar");
    const sidecar = (await readSidecar())!;
    expect(Object.keys(sidecar).sort()).toEqual(["browserRunId", "pid", "secretSha256", "startedAt"]);
    expect(sidecar.browserRunId).toBe(RUN_1);
    expect(sidecar.secretSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(sidecar.pid).not.toBe(relay.child.pid);
    expect(isAlive(sidecar.pid as number)).toBe(true);

    // The broker dialled its relay and was admitted; its secret stopped at the relay.
    await waitFor(() => brokerGreeted(relay.toChrome), "the broker's greeting to reach the worker");
    const greeting = relay.toChrome.find((frame) => isFrame(frame, "hello")) as Record<string, unknown>;
    expect(greeting.brokerSecret).toBeUndefined();
    expect(greeting.token).toBeUndefined();
    // Neither log carries anything shaped like the secret (43+ base64url characters).
    await waitFor(
      async () => (await readLines(join(hostDir(), "broker.log"))).some((line) => line.includes("broker.attached")),
      "the broker's own attach line",
    );
    const logs = [
      ...(await readLines(join(hostDir(), "broker.log"))),
      ...(await readLines(join(hostDir(), "relay.log"))),
    ].join("\n");
    expect(logs).not.toMatch(/[A-Za-z0-9_-]{43}/u);
  }, 30_000);

  it("(b) a hard-killed broker takes its whole tree with it within 2 s", async () => {
    startRelay(RUN_1);
    const tree = await waitForTree();
    expect(alive(tree)).toEqual(treePids(tree));

    process.kill(tree.broker);

    await waitFor(() => alive(tree).length === 0, `0 pids of the tree (alive: ${alive(tree).join(",")})`, 2_000);
  }, 40_000);

  it("(c) a new relay of the same run adopts the broker and the agent pids stay", async () => {
    const first = startRelay(RUN_1);
    const tree = await waitForTree();
    const before = await readSidecar();

    first.child.stdin.end();
    await exitOf(first.child);
    const second = startRelay(RUN_1, { startConversation: false });

    await waitFor(() => brokerGreeted(second.toChrome), "the adopted broker to greet the new relay", 20_000);
    expect(await readSidecar()).toEqual(before);
    expect(alive(tree)).toEqual(treePids(tree));
    // Exactly one agent was ever started: adoption spawned nothing.
    const starts = (await readLines(fakeLogPath())).filter((line) => line.includes('"event":"start"'));
    expect(starts).toHaveLength(1);
  }, 60_000);

  /**
   * T575 (D-019-14): the relay here is this test process's child, so this process stands for the
   * browser's main process - alive throughout. Only the relay went: the broker waits 35 s (was 15 s).
   */
  it("(d) with the browser alive and no new relay the whole tree is gone after the 35 s window", async () => {
    const first = startRelay(RUN_1);
    const tree = await waitForTree();

    const closedAt = Date.now();
    first.child.stdin.end();
    await exitOf(first.child);
    // Past the old 15 s window and still redialling: a recycled worker has time to come back.
    await sleep(20_000);
    expect(isAlive(tree.broker)).toBe(true);

    await waitFor(() => alive(tree).length === 0, `0 pids of the tree (alive: ${alive(tree).join(",")})`, 25_000);
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(34_000);
    // The broker removed its own sidecar on the way out.
    expect(await readSidecar()).toBeUndefined();
  }, 75_000);

  /**
   * T575 (D-019-14, FR-296): a stand-in browser starts the relay the way Chrome does, through
   * `cmd.exe /d /s /c`, and passes it its own stdio. The browser going (and its pipes with it) ends
   * the tree at once, well inside the window a relay-only loss gets.
   */
  it("(g) the browser's main process going ends the whole tree at once", async () => {
    const browser = startRelayUnderBrowser(RUN_1);
    const tree = await waitForTree();
    // The broker's ancestry is the shape the browser gives it: broker <- relay <- cmd.exe <- browser.
    const relayPid = await parentOf(tree.broker);
    const shellPid = await parentOf(relayPid);
    expect(await parentOf(shellPid)).toBe(browser.child.pid);

    const goneAt = Date.now();
    process.kill(browser.child.pid!);
    browser.child.stdin.end();

    await waitFor(() => alive(tree).length === 0, `0 pids of the tree (alive: ${alive(tree).join(",")})`, 8_000);
    expect(Date.now() - goneAt).toBeLessThan(8_000);
    expect(await readSidecar()).toBeUndefined();
    for (const pid of [relayPid, shellPid]) {
      try {
        process.kill(pid);
      } catch {
        // already gone with its pipe
      }
    }
  }, 60_000);

  /**
   * T572 (architecture S2): the relay a new relay of the same run supersedes drains its servers'
   * calls for up to 5 s, but the broker is not one of them: it is told `relay-gone` and let go at
   * once, so it greets the new relay while the old one is still draining - and is not replaced.
   */
  it("(f) a superseded relay lets its broker go at once, while it still drains a server's call", async () => {
    const first = startRelay(RUN_1, { startConversation: false });
    await waitFor(() => brokerGreeted(first.toChrome), "the broker to greet the first relay", 20_000);
    const before = await readSidecar();
    // A server's call the worker never answers keeps the first relay draining for its full bound.
    const server = dialRelay({
      hello: { sessionId: "session-held", agentId: "agent-held", displayName: "Held" },
      onFrame: () => undefined,
      env: { LOCALAPPDATA: dataDir },
      retryMs: 100,
    });
    try {
      await server.attached;
      server.send({ callId: "c-held", sessionId: "session-held", tool: "tabs_context", args: {} });
      await waitFor(() => first.toChrome.some((frame) => (frame as { callId?: unknown }).callId === "c-held"), "the held call");
      let firstExited = false;
      first.child.once("exit", () => (firstExited = true));

      const second = startRelay(RUN_1, { startConversation: false });

      await waitFor(() => brokerGreeted(second.toChrome), "the broker to greet the second relay", 20_000);
      expect(firstExited).toBe(false);
      expect((await readLines(join(hostDir(), "broker.log"))).some((line) => line.includes("broker.relay-gone"))).toBe(true);
      // The same broker: adopted, not replaced by a forced spawn.
      expect(await readSidecar()).toEqual(before);
    } finally {
      await server.stop();
    }
  }, 60_000);

  it("(e) a new relay of another run starts its own broker and the old one shuts down", async () => {
    const first = startRelay(RUN_1);
    const tree = await waitForTree();

    first.child.stdin.end();
    await exitOf(first.child);
    startRelay(RUN_2, { startConversation: false });

    await waitFor(
      async () => {
        const sidecar = await readSidecar();
        return sidecar?.browserRunId === RUN_2 && sidecar.pid !== tree.broker;
      },
      "the new run's broker",
      20_000,
    );
    await waitFor(() => alive(tree).length === 0, `0 pids of the old tree (alive: ${alive(tree).join(",")})`, 20_000);
    // The old broker left the new broker's sidecar alone.
    const sidecar = await readSidecar();
    expect(sidecar?.browserRunId).toBe(RUN_2);
    expect(isAlive(sidecar!.pid as number)).toBe(true);
  }, 60_000);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

/** `pid`'s parent, asked of Windows (the fake agent does not log its parent). */
async function parentOf(pid: number): Promise<number> {
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`],
    { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
  );
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  await new Promise((done) => child.once("exit", done));
  return Number(out.trim());
}

function isFrame(frame: unknown, type: string): boolean {
  return typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === type;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function exitOf(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((done) => child.once("exit", (code) => done(code)));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}
