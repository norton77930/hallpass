import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_LINK_PROTOCOL,
  agentBridgeRecordSchema,
  type AgentBridgeRecord,
} from "@hallpass/contracts";
import {
  DETACH_RETRY_MS,
  DIAL_RETRY_MS,
  dialRelay,
  inspectBridgeRecord,
  listenAndPublish,
  readBridgeRecord,
  removeBridgeRecord,
  writeBridgeRecord,
  type LinkConnection,
  type LinkConnector,
  type PublishedRelay,
} from "../src/bridge-link.js";
import { bridgeFilePath, hostDataDirectory } from "../src/host-paths.js";

/**
 * 003 M2 review A5 — `bridge.json` names one live process, and only that process may retract it.
 *
 * The file is the single rendezvous point between two processes that cannot spawn each other, so a
 * process that deleted a record it did not write would take the *other* link down on its way out.
 * 004/R-111 changes who writes it - the relay does now, and the pid in it is `relayPid` - but not
 * this rule: a stale record is a cheap failure (nobody answers the port, the dialler retries) and
 * deleting a live one is not.
 */
describe("bridge record ownership", () => {
  let dataDir = "";
  let env: { LOCALAPPDATA: string };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hallpass-bridge-link-"));
    env = { LOCALAPPDATA: dataDir };
    await mkdir(hostDataDirectory(env), { recursive: true });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("removes the record this process wrote", async () => {
    await writeBridgeRecord(
      {
        port: 4321,
        token: "b".repeat(64),
        relayPid: process.pid,
        startedAt: new Date().toISOString(),
        protocol: AGENT_LINK_PROTOCOL,
      },
      env,
    );

    await removeBridgeRecord(env);

    await expect(readBridgeRecord(env)).resolves.toBeUndefined();
  });

  it("leaves a record another process wrote", async () => {
    const foreign = {
      port: 4321,
      token: "c".repeat(64),
      relayPid: process.pid + 1,
      startedAt: "2026-09-08T00:00:00.000Z",
      protocol: AGENT_LINK_PROTOCOL,
    };
    await writeBridgeRecord(foreign, env);

    await removeBridgeRecord(env);

    await expect(readBridgeRecord(env)).resolves.toEqual(foreign);
  });

  it("leaves a file it cannot read as a record alone", async () => {
    await writeFile(bridgeFilePath(env), "not json\n", "utf8");

    await removeBridgeRecord(env);

    await expect(readFile(bridgeFilePath(env), "utf8")).resolves.toBe("not json\n");
  });

  /**
   * 004/T099f - "no record" and "a file I cannot read" are one answer to a dialling server and two
   * to the relay that owns the record: only the first is an invitation to republish, and the second
   * may be a torn read of a live relay's write.
   */
  it("tells an absent record apart from one it cannot read", async () => {
    await expect(inspectBridgeRecord(env)).resolves.toEqual({ status: "absent" });

    await writeFile(bridgeFilePath(env), '{"port":4321,"tok', "utf8");
    await expect(inspectBridgeRecord(env)).resolves.toEqual({ status: "unparseable" });

    const record = {
      port: 4321,
      token: "e".repeat(64),
      relayPid: process.pid,
      startedAt: "2026-09-09T00:00:00.000Z",
      protocol: AGENT_LINK_PROTOCOL,
    };
    await writeBridgeRecord(record, env);
    await expect(inspectBridgeRecord(env)).resolves.toEqual({ status: "ok", record });
  });

  it("publishes through a rename and leaves nothing beside the record", async () => {
    await writeBridgeRecord(
      {
        port: 4321,
        token: "f".repeat(64),
        relayPid: process.pid,
        startedAt: "2026-09-09T00:00:00.000Z",
        protocol: AGENT_LINK_PROTOCOL,
      },
      env,
    );

    // A temp file left behind would be read by nobody, but it would accumulate one per publish in
    // the directory Chrome's host manifest lives in.
    await expect(readdir(hostDataDirectory(env))).resolves.toEqual(["bridge.json"]);
  });

  it("reads no record from 003's shape, which named the server's pid", async () => {
    // The two records live at the same path and the 004 one means the opposite thing: `pid` was the
    // *server* to dial, `relayPid` is the relay to dial. A leftover 003 file must read as "no relay
    // is listening", never as an address.
    await writeFile(
      bridgeFilePath(env),
      `${JSON.stringify({ port: 4321, token: "d".repeat(64), pid: process.pid, startedAt: "2026-09-08T00:00:00.000Z" })}\n`,
      "utf8",
    );

    await expect(readBridgeRecord(env)).resolves.toBeUndefined();
  });
});

/**
 * 004/T091 relay side — the relay opens the port and is the one writer of the record (R-111).
 *
 * One writer is the whole fix for the owner's E1: 003 had every mcp-server write this file, so a
 * second agent session silently took the first one's link away.
 */
describe("listenAndPublish", () => {
  let dataDir = "";
  let env: { LOCALAPPDATA: string };
  let relay: PublishedRelay | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hallpass-bridge-listen-"));
    env = { LOCALAPPDATA: dataDir };
    await mkdir(hostDataDirectory(env), { recursive: true });
  });

  afterEach(async () => {
    await relay?.close();
    relay = undefined;
    await rm(dataDir, { recursive: true, force: true });
  });

  it("publishes the record every server dials", async () => {
    relay = await listenAndPublish({ onFrame: () => undefined, onClose: () => undefined }, { env });

    const record = await readBridgeRecord(env);
    expect(agentBridgeRecordSchema.safeParse(record).success).toBe(true);
    expect(record).toMatchObject({ port: relay.port, token: relay.token, relayPid: process.pid });
    expect(Number.isNaN(Date.parse(record?.startedAt ?? ""))).toBe(false);
    expect(relay.port).toBeGreaterThan(0);
  });

  it("retracts its own record when it shuts down", async () => {
    relay = await listenAndPublish({ onFrame: () => undefined, onClose: () => undefined }, { env });

    await relay.close();
    relay = undefined;

    await expect(readBridgeRecord(env)).resolves.toBeUndefined();
  });

  it("leaves a record another relay published", async () => {
    relay = await listenAndPublish({ onFrame: () => undefined, onClose: () => undefined }, { env });
    const foreign = {
      port: 4321,
      token: "e".repeat(64),
      relayPid: process.pid + 1,
      startedAt: "2026-09-08T00:00:00.000Z",
      protocol: AGENT_LINK_PROTOCOL,
    };
    await writeBridgeRecord(foreign, env);

    await relay.close();
    relay = undefined;

    await expect(readBridgeRecord(env)).resolves.toEqual(foreign);
  });
});

/**
 * 004/T091 server side — every mcp-server dials the relay and keeps dialling (R-111, FR-057).
 *
 * The clock and the connector are injected because the cadence is 5 s and there are six cases: a
 * test that actually waited would be half a minute of nothing. What is under test is the decision
 * sequence, not `setTimeout`.
 */
describe("dialRelay", () => {
  let dataDir = "";
  let env: { LOCALAPPDATA: string };

  const HELLO = { sessionId: "s-1", agentId: "claude-code", displayName: "Claude Code" };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hallpass-bridge-dial-"));
    env = { LOCALAPPDATA: dataDir };
    await mkdir(hostDataDirectory(env), { recursive: true });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  function record(overrides: Partial<AgentBridgeRecord> = {}): AgentBridgeRecord {
    return {
      port: 51_515,
      token: "f".repeat(64),
      relayPid: 4242,
      startedAt: "2026-09-09T00:00:00.000Z",
      protocol: AGENT_LINK_PROTOCOL,
      ...overrides,
    };
  }

  /** One dialled connection, plus the handlers the dialler gave it so a test can close it. */
  type FakeLink = LinkConnection & {
    sent: unknown[];
    handlers: { onFrame: (value: unknown) => void; onClose: () => void };
  };

  function harness(options: { onDial?: (attempt: number) => "reject" | "connect" } = {}): {
    connect: LinkConnector;
    links: FakeLink[];
    waits: number[];
    wait: (ms: number) => Promise<void>;
    steps: Array<() => Promise<void> | void>;
  } {
    const links: FakeLink[] = [];
    const waits: number[] = [];
    const steps: Array<() => Promise<void> | void> = [];
    return {
      links,
      waits,
      steps,
      async wait(ms: number): Promise<void> {
        waits.push(ms);
        await steps.shift()?.();
      },
      async connect(_dialled, handlers) {
        if (options.onDial?.(links.length + 1) === "reject") {
          links.push(undefined as unknown as FakeLink);
          throw new Error("ECONNREFUSED");
        }
        const link: FakeLink = {
          sent: [],
          handlers,
          send(value: unknown): void {
            link.sent.push(value);
          },
          close(): Promise<void> {
            handlers.onClose();
            return Promise.resolve();
          },
        };
        links.push(link);
        return link;
      },
    };
  }

  it("waits 5 s and looks again while there is no record to dial", async () => {
    const { connect, links, waits, wait, steps } = harness();
    // The relay starts after the server did - the ordinary case, because Chrome spawns it.
    steps.push(() => undefined);
    steps.push(async () => {
      await writeBridgeRecord(record(), env);
    });

    const dial = dialRelay({ hello: HELLO, onFrame: () => undefined, connect, wait, env, isAlive: () => true });
    await Promise.resolve();
    const link = await waitFor(() => links[0]);
    link.handlers.onFrame({ type: "hello-ack", relayPid: 4242 });
    await dial.attached;
    await dial.stop();

    expect(waits).toEqual([DIAL_RETRY_MS, DIAL_RETRY_MS]);
    expect(links).toHaveLength(1);
  });

  /**
   * 018 R-278 (2): with a target, every attempt dials what the target names right now - the
   * resolved browser's own entry - and never "whatever bridge.json says". No target, no dial.
   */
  it("dials the record its target names on each attempt, never bridge.json", async () => {
    const { connect, links, wait, steps } = harness();
    await writeBridgeRecord(record({ port: 41_111, token: "b".repeat(64) }), env);
    const targets: Array<AgentBridgeRecord | undefined> = [undefined, record({ port: 42_222, token: "c".repeat(64) })];
    const dialled: number[] = [];
    steps.push(() => undefined);

    const dial = dialRelay({
      hello: HELLO,
      onFrame: () => undefined,
      connect: (target, handlers) => {
        dialled.push(target.port);
        return connect(target, handlers);
      },
      wait,
      env,
      isAlive: () => true,
      target: async () => targets.shift(),
    });
    const link = await waitFor(() => links[0]);
    await dial.stop();

    expect(dialled).toEqual([42_222]);
    expect(link.sent).toEqual([
      { type: "hello", ...HELLO, token: "c".repeat(64), protocol: AGENT_LINK_PROTOCOL },
    ]);
  });

  /**
   * 018 R-272: a link stopped while its connect is still in flight greets nobody. The session has
   * moved off that browser; a late greeting would register it there again.
   */
  it("sends no greeting on a connection that completes after stop", async () => {
    const { connect, links, wait } = harness();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dial = dialRelay({
      hello: HELLO,
      onFrame: () => undefined,
      connect: async (target, handlers) => {
        await held;
        return connect(target, handlers);
      },
      wait,
      env,
      isAlive: () => true,
      target: async () => record(),
    });
    await new Promise((resume) => setTimeout(resume, 20));
    const stopped = dial.stop();
    release();
    await stopped;
    const link = await waitFor(() => links[0]);
    await new Promise((resume) => setTimeout(resume, 20));

    expect(link.sent).toEqual([]);
  });

  it("treats a record that does not parse as no relay at all", async () => {
    const { connect, links, waits, wait, steps } = harness();
    await writeFile(bridgeFilePath(env), "half-writ", "utf8");
    steps.push(async () => {
      // Nothing was dialled off the unreadable file: a half-written record has no port in it.
      expect(links).toHaveLength(0);
      await writeBridgeRecord(record(), env);
    });

    const dial = dialRelay({ hello: HELLO, onFrame: () => undefined, connect, wait, env, isAlive: () => true });
    const link = await waitFor(() => links[0]);
    link.handlers.onFrame({ type: "hello-ack", relayPid: 4242 });
    await dial.attached;
    await dial.stop();

    expect(waits).toEqual([DIAL_RETRY_MS]);
    expect(links).toHaveLength(1);
  });

  /**
   * 004/T099j - the record and the greeting carry the protocol they were written with.
   *
   * Chrome spawns the relay and keeps it for the life of the browser, so a host upgrade leaves the
   * old relay running: an old relay's record and a new server met as an endless dial loop with no
   * log naming the cause. A stamp turns that into one line the owner can act on, and the server
   * stops dialling a port it cannot speak to.
   */
  it("names a record from another protocol instead of dialling it", async () => {
    await writeFile(
      bridgeFilePath(env),
      `${JSON.stringify({ port: 4321, token: "g".repeat(64), relayPid: process.pid, startedAt: "2026-09-09T00:00:00.000Z", protocol: 999 })}
`,
      "utf8",
    );
    const logs: string[] = [];
    let dialled = 0;

    const dial = dialRelay({
      hello: { sessionId: "s-1", agentId: "agent-1", displayName: "Agent" },
      onFrame: () => undefined,
      connect: async () => {
        dialled += 1;
        throw new Error("must not dial");
      },
      wait: async () => undefined,
      env,
      log: (code, detail) => logs.push(detail === undefined ? code : `${code} ${detail}`),
    });
    await new Promise((tick) => setTimeout(tick, 20));
    await dial.stop();

    expect(dialled).toBe(0);
    expect(logs.some((line) => line.startsWith("agent.dial.protocol-mismatch"))).toBe(true);
    expect(logs.some((line) => line.startsWith("agent.dial.no-record"))).toBe(false);
  });

  it("treats a record whose relay is not running as no relay at all", async () => {
    const { connect, links, waits, wait, steps } = harness();
    await writeBridgeRecord(record({ relayPid: 4242 }), env);
    let alive = false;
    steps.push(() => {
      // The port in a dead relay's record is not the relay's any more - it may be anybody's - so
      // nothing may have been dialled while its pid was gone.
      expect(links).toHaveLength(0);
      alive = true;
    });

    const dial = dialRelay({
      hello: HELLO,
      onFrame: () => undefined,
      connect,
      wait,
      env,
      isAlive: () => alive,
    });
    const link = await waitFor(() => links[0]);
    link.handlers.onFrame({ type: "hello-ack", relayPid: 4242 });
    await dial.attached;
    await dial.stop();

    expect(waits).toEqual([DIAL_RETRY_MS]);
    expect(links).toHaveLength(1);
  });

  it("keeps dialling when the recorded port answers nothing", async () => {
    const { connect, links, waits, wait, steps } = harness({
      onDial: (attempt) => (attempt === 1 ? "reject" : "connect"),
    });
    await writeBridgeRecord(record(), env);
    steps.push(() => undefined);

    const dial = dialRelay({ hello: HELLO, onFrame: () => undefined, connect, wait, env, isAlive: () => true });
    const link = await waitFor(() => links[1]);
    link.handlers.onFrame({ type: "hello-ack", relayPid: 4242 });
    await dial.attached;
    await dial.stop();

    expect(waits).toEqual([DIAL_RETRY_MS]);
  });

  it("presents the record's token and is attached once the relay acknowledges", async () => {
    const { connect, links, wait } = harness();
    await writeBridgeRecord(record(), env);
    const attachments: number[] = [];

    const dial = dialRelay({
      hello: HELLO,
      onFrame: () => undefined,
      onAttached: (relayPid) => attachments.push(relayPid),
      connect,
      wait,
      env,
      isAlive: () => true,
    });
    const link = await waitFor(() => links[0]);

    expect(link.sent).toEqual([{ type: "hello", ...HELLO, token: "f".repeat(64), protocol: AGENT_LINK_PROTOCOL }]);
    link.handlers.onFrame({ type: "hello-ack", relayPid: 4242 });

    await expect(dial.attached).resolves.toBe(4242);
    expect(attachments).toEqual([4242]);
    await dial.stop();
  });

  it("hands every frame that is not the acknowledgement to its caller", async () => {
    const { connect, links, wait } = harness();
    await writeBridgeRecord(record(), env);
    const frames: unknown[] = [];

    const dial = dialRelay({ hello: HELLO, onFrame: (value) => frames.push(value), connect, wait, env, isAlive: () => true });
    const link = await waitFor(() => links[0]);
    link.handlers.onFrame({ type: "hello-ack", relayPid: 4242 });
    await dial.attached;
    link.handlers.onFrame({ callId: "c-1", outcome: "ok", result: [] });

    expect(frames).toEqual([{ callId: "c-1", outcome: "ok", result: [] }]);
    await dial.stop();
  });

  it("goes back to dialling after the link drops instead of giving up", async () => {
    const { connect, links, waits, wait, steps } = harness();
    await writeBridgeRecord(record(), env);
    steps.push(() => undefined);
    const detachments: number[] = [];

    const dial = dialRelay({
      hello: HELLO,
      onFrame: () => undefined,
      onDetached: () => detachments.push(1),
      connect,
      wait,
      env,
      isAlive: () => true,
    });
    const first = await waitFor(() => links[0]);
    first.handlers.onFrame({ type: "hello-ack", relayPid: 4242 });
    await dial.attached;

    // Chrome restarted the relay: this socket dies and a new one has to be found.
    first.handlers.onClose();
    const second = await waitFor(() => links[1]);

    expect(second.sent).toEqual([{ type: "hello", ...HELLO, token: "f".repeat(64), protocol: AGENT_LINK_PROTOCOL }]);
    // 004/T099k: the first look after a drop is a short one, not a whole cadence.
    expect(waits).toEqual([DETACH_RETRY_MS]);
    expect(detachments).toEqual([1]);
    await dial.stop();
  });

  /**
   * 004/T099k — the recovery bound has to have margin inside it, not land on it.
   *
   * Chrome kills the relay, respawns the worker and publishes a new record about a second later.
   * On a flat 5 s cadence the first look after the drop reads the *dead* relay's record, so the
   * attach waits out a second cadence and lands at ~10 s - FR-057's bound exactly, with a call
   * issued in that first second timing out just before the link it was waiting for arrives.
   * A short first retry that doubles back up to the cadence puts the attach seconds inside the
   * bound, and still leaves a server with no browser at all polling once every 5 s.
   */
  it("shortens the first retries after a drop and ramps back to the cadence (T099k)", async () => {
    const { connect, links, waits, wait, steps } = harness();
    await writeBridgeRecord(record(), env);
    let alive = true;
    // Every look after the drop reads the dead relay's record, so the loop keeps retrying.
    for (let step = 0; step < 4; step += 1) {
      steps.push(() => undefined);
    }

    const dial = dialRelay({
      hello: HELLO,
      onFrame: () => undefined,
      connect,
      wait,
      env,
      isAlive: () => alive,
    });
    const first = await waitFor(() => links[0]);
    first.handlers.onFrame({ type: "hello-ack", relayPid: 4242 });
    await dial.attached;

    alive = false;
    first.handlers.onClose();
    await waitFor(() => (waits.length >= 4 ? waits.length : undefined));
    await dial.stop();

    expect(waits.slice(0, 4)).toEqual([DETACH_RETRY_MS, 1_000, 2_000, 4_000]);
  });

  it("keeps the fast retry inside the cadence a test asked for (T099k)", async () => {
    const { connect, links, waits, wait, steps } = harness();
    await writeBridgeRecord(record(), env);
    let alive = true;
    steps.push(() => undefined);

    const dial = dialRelay({
      hello: HELLO,
      onFrame: () => undefined,
      connect,
      wait,
      env,
      isAlive: () => alive,
      retryMs: 100,
    });
    const first = await waitFor(() => links[0]);
    first.handlers.onFrame({ type: "hello-ack", relayPid: 4242 });
    await dial.attached;

    alive = false;
    first.handlers.onClose();
    await waitFor(() => (waits.length >= 1 ? waits.length : undefined));
    await dial.stop();

    expect(waits[0]).toBe(100);
  });
});

/** Lets a test run the dialler's microtasks until the thing it is waiting for exists. */
async function waitFor<T>(pick: () => T | undefined, label = "the dialler to act"): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = pick();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}
