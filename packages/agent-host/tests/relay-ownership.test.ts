import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_LINK_PROTOCOL } from "@hallpass/contracts";
import { writeBridgeRecord } from "../src/bridge-link.js";
import { bridgeOwnerFilePath } from "../src/host-paths.js";
import {
  decideOnAck,
  decideRelayAck,
  isPortListening,
  readBridgeOwner,
  readRelayAck,
  removeBridgeOwner,
  repairBridgeOwner,
  writeBridgeOwner,
  type AckDecisionInput,
} from "../src/relay-ownership.js";

/**
 * Two browsers (2026-10-02, 018 R-277b): which relay keeps the legacy `bridge.json` on its ack.
 *
 * Every relay serves through its own `browsers/<id>.json` (018); the decision here is only whether
 * it also claims the legacy record older servers dial. It leaves the record to a live relay of
 * *another* browser run, and claims it in every other case: the same browser's fresh host still
 * replaces its old one (004/T169), and anything this process cannot attribute is not a reason to
 * leave it.
 */

const SELF = 2_000;
const SERVING = 1_000;

const servingRecord = {
  status: "ok",
  record: { port: 51_234, token: "t".repeat(64), relayPid: SERVING, startedAt: "2026-10-02T09:00:00.000Z", protocol: AGENT_LINK_PROTOCOL },
} as const;

function input(overrides: Partial<AckDecisionInput> = {}): AckDecisionInput {
  return {
    selfPid: SELF,
    record: servingRecord,
    owner: { relayPid: SERVING, browserRunId: "run-chrome" },
    mineRunId: "run-edge",
    recordPidAlive: true,
    recordLive: true,
    ...overrides,
  };
}

describe("two browsers: claim or leave the legacy bridge.json on relay-ack", () => {
  it("leaves the legacy record when a live relay of another browser run owns the record", () => {
    expect(decideOnAck(input())).toBe("leave-legacy");
  });

  it("claims the legacy record from its own browser's previous relay (004/T169)", () => {
    expect(decideOnAck(input({ mineRunId: "run-chrome" }))).toBe("claim-legacy");
  });

  it("claims the legacy record when either side's browser run is unknown", () => {
    // A worker from before the field: identity unknown, so today's behaviour.
    expect(decideOnAck(input({ mineRunId: undefined }))).toBe("claim-legacy");
    // A serving relay that published without one.
    expect(decideOnAck(input({ owner: { relayPid: SERVING } }))).toBe("claim-legacy");
    // No sidecar at all: a relay from before it, or one that could not write it.
    expect(decideOnAck(input({ owner: undefined }))).toBe("claim-legacy");
  });

  it("claims the legacy record when the serving relay's port does not answer", () => {
    // A crashed relay leaves its record behind; a stale record must never block forever.
    expect(decideOnAck(input({ recordLive: false }))).toBe("claim-legacy");
  });

  it("claims the legacy record when the port answers but the recorded relay's process is gone", () => {
    // A relay killed without retracting, its port later reused by some other local listener: the
    // servers already refuse to dial a dead pid (`dialRelay`), so leaving it would strand older servers.
    expect(decideOnAck(input({ recordPidAlive: false }))).toBe("claim-legacy");
  });

  it("claims the legacy record when the sidecar names a different relay than the record", () => {
    expect(decideOnAck(input({ owner: { relayPid: 3_000, browserRunId: "run-chrome" } }))).toBe("claim-legacy");
  });

  it("claims the legacy record when the record is absent, unparseable, from another protocol, or its own", () => {
    expect(decideOnAck(input({ record: { status: "absent" } }))).toBe("claim-legacy");
    expect(decideOnAck(input({ record: { status: "unparseable" } }))).toBe("claim-legacy");
    expect(decideOnAck(input({ record: { status: "protocol-mismatch", protocol: 1 } }))).toBe("claim-legacy");
    expect(
      decideOnAck(
        input({ record: { status: "ok", record: { ...servingRecord.record, relayPid: SELF } }, owner: { relayPid: SELF, browserRunId: "run-chrome" } }),
      ),
    ).toBe("claim-legacy");
  });
});

describe("two browsers: the facts the decision reads", () => {
  let dataDir = "";
  let env: { LOCALAPPDATA: string };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hallpass-owner-"));
    env = { LOCALAPPDATA: dataDir };
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  async function publishServing(port: number): Promise<void> {
    await writeBridgeRecord({ ...servingRecord.record, port }, env);
    await writeBridgeOwner({ relayPid: SERVING, browserRunId: "run-chrome" }, env);
  }

  it("probes the port only when it is the last question, and leaves the legacy record when it answers", async () => {
    await publishServing(51_234);
    const probe = vi.fn(async () => true);
    const isAlive = (): boolean => true;

    await expect(decideRelayAck({ mineRunId: "run-edge", selfPid: SELF, env, probe, isAlive })).resolves.toEqual({
      decision: "leave-legacy",
      servingRelayPid: SERVING,
    });
    expect(probe).toHaveBeenCalledWith(51_234);

    // Same browser: decided from the files alone, no socket opened.
    probe.mockClear();
    await expect(decideRelayAck({ mineRunId: "run-chrome", selfPid: SELF, env, probe, isAlive })).resolves.toEqual({
      decision: "claim-legacy",
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("claims a legacy record whose port is dead", async () => {
    await publishServing(51_234);
    await expect(
      decideRelayAck({ mineRunId: "run-edge", selfPid: SELF, env, probe: async () => false, isAlive: () => true }),
    ).resolves.toEqual({ decision: "claim-legacy" });
  });

  it("claims a legacy record whose relay is dead, without probing a port someone else may hold", async () => {
    await publishServing(51_234);
    const probe = vi.fn(async () => true);
    const isAlive = vi.fn(() => false);

    await expect(decideRelayAck({ mineRunId: "run-edge", selfPid: SELF, env, probe, isAlive })).resolves.toEqual({
      decision: "claim-legacy",
    });
    expect(isAlive).toHaveBeenCalledWith(SERVING);
    expect(probe).not.toHaveBeenCalled();
  });

  it("reads a port as live only while something listens on it", async () => {
    const listener = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    const port = typeof address === "object" && address ? address.port : 0;

    await expect(isPortListening(port)).resolves.toBe(true);
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await expect(isPortListening(port)).resolves.toBe(false);
  });

  it("retracts the sidecar only when it names this process", async () => {
    await writeBridgeOwner({ relayPid: SERVING, browserRunId: "run-chrome" }, env);
    await removeBridgeOwner(env);
    await expect(readBridgeOwner(env)).resolves.toEqual({ relayPid: SERVING, browserRunId: "run-chrome" });

    await writeBridgeOwner({ relayPid: process.pid }, env);
    await removeBridgeOwner(env);
    await expect(readBridgeOwner(env)).resolves.toBeUndefined();
  });

  /**
   * `removeBridgeOwner` reads then deletes, so an old relay on its way out can delete the sidecar the
   * relay that just took over wrote - the record then names the new owner with no sidecar, and the
   * next browser takes over instead of standing by. The owning relay's poll repairs it, as T099f
   * does the record.
   */
  it("repairs a sidecar that is missing, names another relay or another run, and leaves its own alone", async () => {
    const mine = { relayPid: SELF, browserRunId: "run-chrome" };

    await expect(repairBridgeOwner({ selfPid: SELF, browserRunId: "run-chrome", env })).resolves.toBe(true);
    await expect(readBridgeOwner(env)).resolves.toEqual(mine);

    await writeBridgeOwner({ relayPid: SERVING, browserRunId: "run-edge" }, env);
    await expect(repairBridgeOwner({ selfPid: SELF, browserRunId: "run-chrome", env })).resolves.toBe(true);
    await expect(readBridgeOwner(env)).resolves.toEqual(mine);

    await writeBridgeOwner({ relayPid: SELF, browserRunId: "run-edge" }, env);
    await expect(repairBridgeOwner({ selfPid: SELF, browserRunId: "run-chrome", env })).resolves.toBe(true);
    await expect(readBridgeOwner(env)).resolves.toEqual(mine);

    // Already right: nothing written.
    await expect(repairBridgeOwner({ selfPid: SELF, browserRunId: "run-chrome", env })).resolves.toBe(false);

    // A relay that was never told its run writes what its publish writes: the pid alone.
    await rm(bridgeOwnerFilePath(env), { force: true });
    await expect(repairBridgeOwner({ selfPid: SELF, browserRunId: undefined, env })).resolves.toBe(true);
    await expect(readBridgeOwner(env)).resolves.toEqual({ relayPid: SELF });
    await expect(repairBridgeOwner({ selfPid: SELF, browserRunId: undefined, env })).resolves.toBe(false);
  });

  it("writes nothing when the relay started leaving while the sidecar was being read", async () => {
    // `close()` retracts the sidecar on purpose; a repair whose read was already out must not put it back.
    await expect(
      repairBridgeOwner({ selfPid: SELF, browserRunId: "run-chrome", env, shouldWrite: () => false }),
    ).resolves.toBe(false);
    await expect(readBridgeOwner(env)).resolves.toBeUndefined();
  });

  it("reads the ack leniently, with or without the browser run (version skew)", () => {
    // A worker from before the field: still an ack, identity unknown.
    expect(readRelayAck({ type: "relay-ack", relayPid: SELF }, SELF)).toEqual({ browserRunId: undefined });
    expect(readRelayAck({ type: "relay-ack", relayPid: SELF, browserRunId: "run-edge" }, SELF)).toEqual({
      browserRunId: "run-edge",
    });
    // A field this build does not know, or a run id it cannot use, never costs the ack itself.
    expect(readRelayAck({ type: "relay-ack", relayPid: SELF, browserRunId: 7, later: true }, SELF)).toEqual({
      browserRunId: undefined,
    });
    expect(readRelayAck({ type: "relay-ack", relayPid: SERVING }, SELF)).toBeUndefined();
    expect(readRelayAck({ type: "relay-started", relayPid: SELF }, SELF)).toBeUndefined();
  });
});
