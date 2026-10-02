import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_LINK_PROTOCOL } from "@hallpass/contracts";
import { writeBridgeRecord } from "../src/bridge-link.js";
import {
  decideOnAck,
  decideRelayAck,
  isPortListening,
  readBridgeOwner,
  readRelayAck,
  removeBridgeOwner,
  writeBridgeOwner,
  type AckDecisionInput,
} from "../src/relay-ownership.js";

/**
 * Two browsers (2026-10-02): which relay keeps the bridge when both are acknowledged.
 *
 * Chrome and Edge each spawn their own relay, and each relay used to take the record over on its
 * own `relay-ack` - so the two evicted each other every few seconds and neither browser could be
 * used. A relay now stands by when the record belongs to a live relay of *another* browser run, and
 * takes over in every other case, exactly as it did before: the same browser's fresh host still
 * replaces its old one (004/T169), and anything this process cannot attribute is not a reason to
 * stay out.
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

describe("two browsers: take over or stand by on relay-ack", () => {
  it("stands by when a live relay of another browser run owns the record", () => {
    expect(decideOnAck(input())).toBe("stand-by");
  });

  it("takes over from its own browser's previous relay (004/T169)", () => {
    expect(decideOnAck(input({ mineRunId: "run-chrome" }))).toBe("take-over");
  });

  it("takes over when either side's browser run is unknown", () => {
    // A worker from before the field: identity unknown, so today's behaviour.
    expect(decideOnAck(input({ mineRunId: undefined }))).toBe("take-over");
    // A serving relay that published without one.
    expect(decideOnAck(input({ owner: { relayPid: SERVING } }))).toBe("take-over");
    // No sidecar at all: a relay from before it, or one that could not write it.
    expect(decideOnAck(input({ owner: undefined }))).toBe("take-over");
  });

  it("takes over when the serving relay's port does not answer", () => {
    // A crashed relay leaves its record behind; a stale record must never block forever.
    expect(decideOnAck(input({ recordLive: false }))).toBe("take-over");
  });

  it("takes over when the port answers but the recorded relay's process is gone", () => {
    // A relay killed without retracting, its port later reused by some other local listener: the
    // servers already refuse to dial a dead pid (`dialRelay`), so standing by would strand both.
    expect(decideOnAck(input({ recordPidAlive: false }))).toBe("take-over");
  });

  it("takes over when the sidecar names a different relay than the record", () => {
    expect(decideOnAck(input({ owner: { relayPid: 3_000, browserRunId: "run-chrome" } }))).toBe("take-over");
  });

  it("takes over when the record is absent, unparseable, from another protocol, or its own", () => {
    expect(decideOnAck(input({ record: { status: "absent" } }))).toBe("take-over");
    expect(decideOnAck(input({ record: { status: "unparseable" } }))).toBe("take-over");
    expect(decideOnAck(input({ record: { status: "protocol-mismatch", protocol: 1 } }))).toBe("take-over");
    expect(
      decideOnAck(
        input({ record: { status: "ok", record: { ...servingRecord.record, relayPid: SELF } }, owner: { relayPid: SELF, browserRunId: "run-chrome" } }),
      ),
    ).toBe("take-over");
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

  it("probes the port only when it is the last question, and stands by when it answers", async () => {
    await publishServing(51_234);
    const probe = vi.fn(async () => true);
    const isAlive = (): boolean => true;

    await expect(decideRelayAck({ mineRunId: "run-edge", selfPid: SELF, env, probe, isAlive })).resolves.toEqual({
      decision: "stand-by",
      servingRelayPid: SERVING,
    });
    expect(probe).toHaveBeenCalledWith(51_234);

    // Same browser: decided from the files alone, no socket opened.
    probe.mockClear();
    await expect(decideRelayAck({ mineRunId: "run-chrome", selfPid: SELF, env, probe, isAlive })).resolves.toEqual({
      decision: "take-over",
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("takes over from a record whose port is dead", async () => {
    await publishServing(51_234);
    await expect(
      decideRelayAck({ mineRunId: "run-edge", selfPid: SELF, env, probe: async () => false, isAlive: () => true }),
    ).resolves.toEqual({ decision: "take-over" });
  });

  it("takes over from a record whose relay is dead, without probing a port someone else may hold", async () => {
    await publishServing(51_234);
    const probe = vi.fn(async () => true);
    const isAlive = vi.fn(() => false);

    await expect(decideRelayAck({ mineRunId: "run-edge", selfPid: SELF, env, probe, isAlive })).resolves.toEqual({
      decision: "take-over",
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
