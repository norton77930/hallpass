import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  brokerSidecarPath,
  createBrokerSupervisor,
  removeOwnBrokerSidecarSync,
  type BrokerLaunch,
} from "../src/broker-launch.js";
import { makeTempDir, removeDir } from "./conversation-harness.js";

/**
 * 019/T529 review follow-ups F1 and F3 - the relay keeps its browser run's broker there.
 *
 * F1: an adopted broker (R-312) that has not greeted this relay within the grace (15 s since T572;
 * most tests here set 5 s) is not trusted to ever do so: the relay spawns a fresh one, forced past the sidecar. F3: a broker that exits under a live
 * relay is respawned once per relay run, after a pause - never in a loop. A relay on its way out
 * starts nothing. Plus: a broker that crashes removes its own sidecar on the way out, synchronously.
 */

type Timer = { ms: number; fn: () => void; cancelled: boolean };

function manualTimers() {
  const timers: Timer[] = [];
  return {
    timers,
    set(fn: () => void, ms: number) {
      const timer = { ms, fn, cancelled: false };
      timers.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
    /** Fires every pending timer of that delay (and only those), once. */
    async fire(ms: number) {
      const due = timers.filter((timer) => !timer.cancelled && timer.ms === ms);
      for (const timer of due) {
        timer.cancelled = true;
        timer.fn();
      }
      await new Promise((done) => setImmediate(done));
    },
    pending: (ms: number) => timers.filter((timer) => !timer.cancelled && timer.ms === ms).length,
  };
}

/** `defaultGrace`: the supervisor's own adopt grace instead of the 5 s these tests fire. */
function harness(first: BrokerLaunch["kind"], { defaultGrace = false }: { defaultGrace?: boolean } = {}) {
  const timers = manualTimers();
  const launches: { force: boolean }[] = [];
  const exits: (() => void)[] = [];
  const expected: (string | undefined)[] = [];
  const logs: string[] = [];
  const alive = new Set<number>();
  let session: string | undefined;
  let nextPid = 100;
  const supervisor = createBrokerSupervisor({
    launch: async ({ force, onExit }) => {
      launches.push({ force });
      const pid = nextPid++;
      alive.add(pid);
      exits.push(() => {
        alive.delete(pid);
        onExit(pid);
      });
      const kind = launches.length === 1 ? first : "spawned";
      return kind === "adopted"
        ? { kind, pid, secretSha256: `hash-${pid}` }
        : { kind, pid, secretSha256: `hash-${pid}`, sidecarWritten: true };
    },
    expectBroker: (hash) => expected.push(hash),
    brokerSessionId: () => session,
    isAlive: (pid) => alive.has(pid),
    log: (code, detail) => logs.push(detail === undefined ? code : `${code} ${detail}`),
    setTimer: (fn, ms) => timers.set(fn, ms),
    ...(defaultGrace ? {} : { adoptGraceMs: 5_000 }),
    respawnDelayMs: 2_000,
    adoptedPollMs: 1_000,
  });
  return {
    supervisor,
    timers,
    launches,
    exits,
    expected,
    logs,
    alive,
    greet: (id: string | undefined) => (session = id),
  };
}

describe("F1 an adopted broker that never greets", () => {
  it("is left alone when it greets within the grace", async () => {
    const h = harness("adopted");
    await h.supervisor.start();
    h.greet("broker-session");
    await h.timers.fire(5_000);
    expect(h.launches).toEqual([{ force: false }]);
    expect(h.expected).toEqual(["hash-100"]);
  });

  it("is replaced by a fresh, forced spawn after ~5 s of silence - once", async () => {
    const h = harness("adopted");
    await h.supervisor.start();
    expect(h.timers.pending(5_000)).toBe(1);
    await h.timers.fire(5_000);
    expect(h.launches).toEqual([{ force: false }, { force: true }]);
    expect(h.expected).toEqual(["hash-100", "hash-101"]);
    expect(h.logs).toContain("relay.broker.adopted-silent 100");
    // The forced one is spawned, so there is no second grace and no second forced spawn.
    await h.timers.fire(5_000);
    expect(h.launches).toHaveLength(2);
  });
});

describe("T572 the adopt grace outlasts a handover", () => {
  /**
   * A broker still on a superseded relay reaches the new one only after that relay's drain (up to
   * 5 s), its record poll (1 s) and the broker's own 1 s redial: a 5 s grace replaced brokers that
   * were on their way. The default is 15 s.
   */
  it("by default an adopted broker has 15 s to greet before a forced spawn", async () => {
    const h = harness("adopted", { defaultGrace: true });
    await h.supervisor.start();
    expect(h.timers.pending(15_000)).toBe(1);
    await h.timers.fire(5_000);
    expect(h.launches).toEqual([{ force: false }]);
    await h.timers.fire(15_000);
    expect(h.launches).toEqual([{ force: false }, { force: true }]);
  });
});

describe("F3 a broker that exits under a live relay", () => {
  it("a spawned broker's exit is followed by one respawn after the pause, and no more", async () => {
    const h = harness("spawned");
    await h.supervisor.start();
    h.exits[0]!();
    expect(h.launches).toHaveLength(1);
    await h.timers.fire(2_000);
    expect(h.launches).toEqual([{ force: false }, { force: false }]);
    expect(h.expected).toEqual(["hash-100", "hash-101"]);

    h.exits[1]!();
    await h.timers.fire(2_000);
    expect(h.launches).toHaveLength(2);
    expect(h.logs).toContain("relay.broker.exited 101 no-respawn");
  });

  it("an adopted broker that dies is noticed by its pid and respawned once", async () => {
    const h = harness("adopted");
    await h.supervisor.start();
    h.greet("broker-session");
    await h.timers.fire(1_000);
    expect(h.launches).toHaveLength(1);
    h.alive.delete(100);
    await h.timers.fire(1_000);
    await h.timers.fire(2_000);
    expect(h.launches).toEqual([{ force: false }, { force: false }]);
  });

  it("the exit of a broker already replaced is not counted", async () => {
    const h = harness("adopted");
    await h.supervisor.start();
    await h.timers.fire(5_000); // F1 replaced 100 with 101
    h.exits[0]!(); // 100 goes away afterwards
    await h.timers.fire(2_000);
    expect(h.launches).toHaveLength(2);
  });

  it("a relay on its way out starts nothing", async () => {
    const h = harness("adopted");
    await h.supervisor.start();
    h.supervisor.stop();
    await h.timers.fire(5_000);
    h.exits[0]!();
    await h.timers.fire(2_000);
    await h.timers.fire(1_000);
    expect(h.launches).toHaveLength(1);
  });

  it("a launch that throws is logged and leaves the relay serving", async () => {
    const logs: string[] = [];
    const supervisor = createBrokerSupervisor({
      launch: async () => {
        throw new Error("spawn EPERM");
      },
      expectBroker: () => undefined,
      brokerSessionId: () => undefined,
      log: (code) => logs.push(code),
      setTimer: () => ({ cancel: () => undefined }),
    });
    expect(await supervisor.start()).toBe(false);
    expect(logs).toContain("relay.broker.launch-failed");
  });
});

describe("a crashing broker removes its own sidecar", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await makeTempDir("hallpass-sidecar-");
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  const BROWSER = "c0ffee00-0000-4000-8000-0000000000c1";
  const write = async (pid: number) => {
    const path = brokerSidecarPath(BROWSER, { LOCALAPPDATA: dir });
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ pid, browserRunId: "r", secretSha256: "a".repeat(64), startedAt: "t" }));
    return path;
  };

  it("removes it when it names this pid, synchronously", async () => {
    const path = await write(4242);
    removeOwnBrokerSidecarSync(BROWSER, 4242, { LOCALAPPDATA: dir });
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("leaves another broker's sidecar alone", async () => {
    const path = await write(4243);
    removeOwnBrokerSidecarSync(BROWSER, 4242, { LOCALAPPDATA: dir });
    expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(4243);
  });
});
