import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_LINK_PROTOCOL, BROWSER_CHOICE_FEATURE, type AgentBrowserRecord } from "@hallpass/contracts";
import {
  browserPeers,
  browserRecordPath,
  decideLegacyClaim,
  decideOwnRecordOnAck,
  decideOwnRecordTurn,
  identityFromAck,
  inspectBrowserRecord,
  listBrowserRecords,
  liveOtherRecords,
  removeOwnBrowserRecord,
  sweepDeadBrowserRecords,
  writeBrowserRecord,
  type OwnRecordFacts,
} from "../src/browser-record.js";
import { readRelayAck } from "../src/relay-ownership.js";

/**
 * 018 R-266, R-276, R-277, R-279 - the relay's per-browser record, decided by pure functions so the
 * cases the process tests cannot stage (a pid that is alive with a dead port, an unknown run) are
 * each pinned once.
 */

const SELF = 2_000;
const OTHER = 1_000;
const ID = "c0ffee00-0000-4000-8000-00000000000a";

function record(overrides: Partial<AgentBrowserRecord> = {}): AgentBrowserRecord {
  return {
    browserId: ID,
    browserRunId: "run-a",
    kind: "chrome",
    legacy: false,
    features: [],
    relayPid: OTHER,
    port: 51_234,
    token: "t".repeat(64),
    startedAt: "2026-10-03T08:00:00.000Z",
    protocol: AGENT_LINK_PROTOCOL,
    ...overrides,
  };
}

function facts(overrides: Partial<OwnRecordFacts> = {}): OwnRecordFacts {
  return {
    selfPid: SELF,
    mineRunId: "run-a",
    reading: { status: "ok", record: record() },
    pidAlive: true,
    portLive: true,
    ...overrides,
  };
}

describe("018 identity from relay-ack (R-268)", () => {
  it("takes a minted identity as it came", () => {
    const ack = readRelayAck(
      {
        type: "relay-ack",
        relayPid: SELF,
        browserRunId: "run-a",
        browserId: ID,
        browserKind: "edge",
        browserName: "Work",
        features: [BROWSER_CHOICE_FEATURE],
      },
      SELF,
    );
    expect(ack && identityFromAck(ack, SELF)).toEqual({
      browserId: ID,
      browserRunId: "run-a",
      kind: "edge",
      name: "Work",
      legacy: false,
      features: [BROWSER_CHOICE_FEATURE],
    });
  });

  it("names an identity-less worker by its run, or by the relay's pid without one, as legacy", () => {
    const withRun = readRelayAck({ type: "relay-ack", relayPid: SELF, browserRunId: "0123abcd" }, SELF);
    expect(withRun && identityFromAck(withRun, SELF)).toEqual({
      browserId: "run-0123abcd",
      browserRunId: "0123abcd",
      kind: "unknown",
      legacy: true,
      features: [],
    });
    const bare = readRelayAck({ type: "relay-ack", relayPid: SELF }, SELF);
    expect(bare && identityFromAck(bare, SELF)).toEqual({ browserId: `pid-${SELF}`, kind: "unknown", legacy: true, features: [] });
  });

  it("reads an id that could name a file elsewhere, or a bad kind or name, as not said", () => {
    const ack = readRelayAck(
      { type: "relay-ack", relayPid: SELF, browserId: "..\\..\\evil-0000", browserKind: "netscape", browserName: "a\nb" },
      SELF,
    );
    expect(ack && identityFromAck(ack, SELF)).toEqual({ browserId: `pid-${SELF}`, kind: "unknown", legacy: true, features: [] });
    // A run id the file name cannot carry falls back to the pid as well.
    const oddRun = readRelayAck({ type: "relay-ack", relayPid: SELF, browserRunId: "run/with/slashes" }, SELF);
    expect(oddRun && identityFromAck(oddRun, SELF).browserId).toBe(`pid-${SELF}`);
  });
});

describe("018 own record on relay-ack (R-276)", () => {
  it("writes when nothing usable is there or the relay named is gone", () => {
    expect(decideOwnRecordOnAck(facts({ reading: { status: "absent" } }))).toBe("write");
    expect(decideOwnRecordOnAck(facts({ reading: { status: "unparseable" } }))).toBe("write");
    expect(decideOwnRecordOnAck(facts({ pidAlive: false, mineRunId: "run-b" }))).toBe("write");
  });

  it("replaces its own browser's previous relay of the same run, or when either run is unknown", () => {
    expect(decideOwnRecordOnAck(facts())).toBe("write");
    expect(decideOwnRecordOnAck(facts({ mineRunId: undefined }))).toBe("write");
    expect(decideOwnRecordOnAck(facts({ reading: { status: "ok", record: record({ browserRunId: undefined }) } }))).toBe("write");
  });

  it("is a collision when a live relay of another run holds the id", () => {
    expect(decideOwnRecordOnAck(facts({ mineRunId: "run-b" }))).toBe("conflict");
    // A live pid behind a dead port is a reused pid, not a browser.
    expect(decideOwnRecordOnAck(facts({ mineRunId: "run-b", portLive: false }))).toBe("write");
  });
});

describe("018 own record on the 1 s poll (R-276, R-279)", () => {
  it("keeps its own, republishes an absent or dead one, waits on one it cannot read", () => {
    expect(decideOwnRecordTurn(facts({ reading: { status: "ok", record: record({ relayPid: SELF }) } }))).toBe("keep");
    expect(decideOwnRecordTurn(facts({ reading: { status: "absent" } }))).toBe("republish");
    expect(decideOwnRecordTurn(facts({ pidAlive: false }))).toBe("republish");
    expect(decideOwnRecordTurn(facts({ reading: { status: "unparseable" } }))).toBe("wait");
  });

  it("leaves for a live relay of the same run, or of an unknown run (004/T169)", () => {
    expect(decideOwnRecordTurn(facts())).toBe("superseded");
    expect(decideOwnRecordTurn(facts({ mineRunId: undefined }))).toBe("superseded");
  });

  it("is a collision, not a supersession, for a live relay of another run", () => {
    expect(decideOwnRecordTurn(facts({ mineRunId: "run-b" }))).toBe("conflict");
    expect(decideOwnRecordTurn(facts({ mineRunId: "run-b", portLive: false }))).toBe("republish");
  });

  it("leaves for another build of its own browser, and repairs over a dead one", () => {
    expect(decideOwnRecordTurn(facts({ reading: { status: "protocol-mismatch", relayPid: OTHER } }))).toBe("superseded");
    expect(decideOwnRecordTurn(facts({ reading: { status: "protocol-mismatch", relayPid: OTHER }, pidAlive: false }))).toBe(
      "republish",
    );
    expect(decideOwnRecordTurn(facts({ reading: { status: "protocol-mismatch", relayPid: undefined }, pidAlive: false }))).toBe(
      "republish",
    );
  });
});

describe("018 legacy bridge.json claim (R-277b)", () => {
  const ok = (relayPid: number) =>
    ({ status: "ok", record: { port: 1, token: "t".repeat(64), relayPid, startedAt: "x", protocol: AGENT_LINK_PROTOCOL } }) as const;

  it("claims an absent or dead record, keeps its own, leaves a live one or one it cannot read", () => {
    const alive = (pid: number) => pid === OTHER;
    expect(decideLegacyClaim({ status: "absent" }, SELF, alive)).toBe("claim");
    expect(decideLegacyClaim(ok(SELF), SELF, alive)).toBe("own");
    expect(decideLegacyClaim(ok(OTHER), SELF, alive)).toBe("leave");
    expect(decideLegacyClaim(ok(3_000), SELF, alive)).toBe("claim");
    expect(decideLegacyClaim({ status: "unparseable" }, SELF, alive)).toBe("leave");
  });
});

describe("018 browser-peers (R-269)", () => {
  it("counts the other live browsers and numbers this one's default name by connection order", () => {
    const mine = record({ browserId: "mine-0001", relayPid: SELF, startedAt: "2026-10-03T09:00:00.000Z" });
    const earlier = record({ browserId: "other-0001", startedAt: "2026-10-03T08:00:00.000Z" });
    const edge = record({ browserId: "other-0002", kind: "edge", startedAt: "2026-10-03T07:00:00.000Z" });
    expect(browserPeers(mine, [])).toEqual({ others: 0, defaultName: "Chrome" });
    expect(browserPeers(mine, [earlier, edge])).toEqual({ others: 2, defaultName: "Chrome 2" });
  });
});

describe("018 record files", () => {
  let dataDir = "";
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hallpass-browsers-"));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("writes into browsers/, reads back, removes only its own, and lists *.json exactly", async () => {
    const env = { LOCALAPPDATA: dataDir };
    const own = record({ relayPid: process.pid });
    await writeBrowserRecord(own, env);
    await expect(inspectBrowserRecord(browserRecordPath(ID, env))).resolves.toEqual({ status: "ok", record: own });
    await writeFile(`${browserRecordPath(ID, env)}.123.abcd.tmp`, "{}");
    const listed = await listBrowserRecords(env);
    expect(listed.map((entry) => entry.browserId)).toEqual([ID]);

    await removeOwnBrowserRecord(ID, process.pid + 1, env);
    await expect(inspectBrowserRecord(browserRecordPath(ID, env))).resolves.toMatchObject({ status: "ok" });
    await removeOwnBrowserRecord(ID, process.pid, env);
    await expect(inspectBrowserRecord(browserRecordPath(ID, env))).resolves.toEqual({ status: "absent" });
  });

  // T507 m4: a record named after a Windows device (`AUX.json`) would be the device, not a file.
  it("refuses a browser id that is a Windows device name as a record file name, and does not list one", async () => {
    const env = { LOCALAPPDATA: dataDir };
    for (const browserId of ["CON", "prn", "Aux", "nul", "COM1", "com9", "LPT1", "lpt9"]) {
      expect(() => browserRecordPath(browserId, env), browserId).toThrow(/file name/);
    }
    expect(() => browserRecordPath("CONSOLE", env)).not.toThrow();
    expect(() => browserRecordPath("lpt10", env)).not.toThrow();
  });

  it("sweeps only other browsers' records whose relay is dead", async () => {
    const env = { LOCALAPPDATA: dataDir };
    await writeBrowserRecord(record({ browserId: "dead-0001", relayPid: 999_001 }), env);
    await writeBrowserRecord(record({ browserId: "live-0001", relayPid: OTHER }), env);
    await writeBrowserRecord(record({ browserId: "mine-0001", relayPid: 999_002 }), env);
    const swept = await sweepDeadBrowserRecords({
      ownBrowserId: "mine-0001",
      env,
      isAlive: (pid) => pid === OTHER,
      probe: async () => true,
    });
    expect(swept).toEqual(["dead-0001"]);
    expect((await readdir(join(dataDir, "hallpass", "browsers"))).sort()).toEqual(["live-0001.json", "mine-0001.json"]);
  });

  // T515 m4: a relay killed without retracting whose pid was reused is not a connected browser.
  it("does not count, and sweeps, another browser's record whose pid is alive but whose port does not answer", async () => {
    const env = { LOCALAPPDATA: dataDir };
    const silentPort = 51_666;
    const answers = async (port: number): Promise<boolean> => port !== silentPort;
    await writeBrowserRecord(record({ browserId: "ghost-0001", relayPid: OTHER, port: silentPort }), env);
    await writeBrowserRecord(record({ browserId: "live-0001", relayPid: OTHER }), env);
    await writeBrowserRecord(record({ browserId: "mine-0001", relayPid: SELF, port: silentPort }), env);
    const alive = (pid: number): boolean => pid === OTHER || pid === SELF;

    const others = await liveOtherRecords(await listBrowserRecords(env), "mine-0001", alive, answers);
    expect(others.map((other) => other.browserId)).toEqual(["live-0001"]);

    const swept = await sweepDeadBrowserRecords({ ownBrowserId: "mine-0001", env, isAlive: alive, probe: answers });
    expect(swept).toEqual(["ghost-0001"]);
    expect((await readdir(join(dataDir, "hallpass", "browsers"))).sort()).toEqual(["live-0001.json", "mine-0001.json"]);
  });
});
