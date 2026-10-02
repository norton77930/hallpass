import { readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { agentBridgeOwnerSchema, type AgentBridgeOwner } from "@hallpass/contracts";
import {
  inspectBridgeRecord,
  isProcessAlive,
  writeHostFileAtomically,
  type BridgeRecordReading,
} from "./bridge-link.js";
import { bridgeOwnerFilePath, type HostEnvironment } from "./host-paths.js";

/**
 * Who keeps the bridge when two browsers each run a relay (two browsers, 2026-10-02).
 *
 * Chrome and Edge (both registered since 010) each spawn their own relay, and a relay used to take
 * the record over on every `relay-ack`. The relay it displaced saw another pid in the record and
 * left, its browser's worker reconnected a few seconds later, and its new relay took the record
 * back - measured as `relay.superseded` alternating between the two browsers every ~7 s, with every
 * MCP call dialling a relay that was about to go and timing out unpaired. Neither browser worked.
 *
 * The stop-gap: the first browser keeps the bridge and the second stands by. "Which browser" is the
 * worker's browser run id (013/R-184) carried on the ack, and the record's owner is named in a
 * sidecar file, because the record itself is parsed strictly by servers already running.
 */

export type BridgeOwner = AgentBridgeOwner;

export type AckDecisionInput = {
  selfPid: number;
  record: BridgeRecordReading;
  /** The sidecar as read, `undefined` when it is absent or does not parse. */
  owner: BridgeOwner | undefined;
  /** The browser run the acknowledging worker named; `undefined` from a worker before the field. */
  mineRunId: string | undefined;
  /** Whether the pid the record names is still a running process (`isProcessAlive`). */
  recordPidAlive: boolean;
  /** Whether the record's port answered a connect on loopback. */
  recordLive: boolean;
};

export type AckDecision = "take-over" | "stand-by";

/**
 * Take the record over, or stand by - and stand by only when every fact says another browser is
 * serving right now.
 *
 * Each condition is one way the old behaviour is still right:
 * - the record is absent, unreadable, from another protocol, or this relay's own: nothing to defer to;
 * - the sidecar names some other pid than the record: it is stale, so the owner is unknown;
 * - either run id is missing: an older worker or relay on one side, so identity is unknown;
 * - the run ids are equal: this browser's own previous relay, which a fresh host replaces (004/T169);
 * - the record's port does not answer: a relay that crashed without retracting, or a pid reused -
 *   so a stale record can never block forever;
 * - the record's pid is not a running process, even if the port answers: a relay killed without
 *   retracting whose port some other local listener took since. Servers refuse to dial a dead pid
 *   (`dialRelay`), so standing by then would leave nobody serving. Both facts are required.
 */
export function decideOnAck(input: AckDecisionInput): AckDecision {
  const { record, owner, mineRunId } = input;
  if (record.status !== "ok") return "take-over";
  if (record.record.relayPid === input.selfPid) return "take-over";
  if (owner === undefined || owner.relayPid !== record.record.relayPid) return "take-over";
  if (owner.browserRunId === undefined || mineRunId === undefined) return "take-over";
  if (owner.browserRunId === mineRunId) return "take-over";
  return input.recordPidAlive && input.recordLive ? "stand-by" : "take-over";
}

/** How long the liveness probe waits for the serving relay's port before calling it dead. */
export const RELAY_LIVENESS_BOUND_MS = 500;

/**
 * Whether something accepts a connection on `port` on loopback within the bound.
 *
 * The socket is closed the moment it connects and carries nothing: the serving relay sees a peer
 * that never greets and drops it without a word, which is what its multiplexer does with any.
 */
export function isPortListening(port: number, boundMs = RELAY_LIVENESS_BOUND_MS): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    let settled = false;
    const settle = (live: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      socket.destroy();
      resolve(live);
    };
    const guard = setTimeout(() => settle(false), boundMs);
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

/** The sidecar, or `undefined` when it is absent or not a shape this build reads. */
export async function readBridgeOwner(env?: HostEnvironment): Promise<BridgeOwner | undefined> {
  try {
    const parsed = agentBridgeOwnerSchema.safeParse(JSON.parse(await readFile(bridgeOwnerFilePath(env), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Written by the relay that owns the record, right after the record, with the same atomic write. */
export async function writeBridgeOwner(owner: BridgeOwner, env?: HostEnvironment): Promise<void> {
  await writeHostFileAtomically(bridgeOwnerFilePath(env), owner, env);
}

/** Retracts the sidecar only when it names this process, as `removeBridgeRecord` does the record. */
export async function removeBridgeOwner(env?: HostEnvironment): Promise<void> {
  const owner = await readBridgeOwner(env);
  if (owner?.relayPid !== process.pid) return;
  await rm(bridgeOwnerFilePath(env), { force: true });
}

/**
 * Reads the record and the sidecar and decides; the port is probed only when it is the last
 * question left, so the ordinary case - one browser - costs two file reads and no socket.
 */
export async function decideRelayAck(options: {
  mineRunId: string | undefined;
  selfPid?: number;
  env?: HostEnvironment;
  probe?: (port: number) => Promise<boolean>;
  isAlive?: (pid: number) => boolean;
}): Promise<{ decision: AckDecision; servingRelayPid?: number }> {
  const selfPid = options.selfPid ?? process.pid;
  const [record, owner] = await Promise.all([inspectBridgeRecord(options.env), readBridgeOwner(options.env)]);
  const facts = { selfPid, record, owner, mineRunId: options.mineRunId };
  if (decideOnAck({ ...facts, recordPidAlive: true, recordLive: true }) === "take-over" || record.status !== "ok") {
    return { decision: "take-over" };
  }
  // The pid first, as `dialRelay` reads it: a dead relay is not probed at all.
  const recordPidAlive = (options.isAlive ?? isProcessAlive)(record.record.relayPid);
  const recordLive = recordPidAlive ? await (options.probe ?? isPortListening)(record.record.port) : false;
  const decision = decideOnAck({ ...facts, recordPidAlive, recordLive });
  return decision === "stand-by" ? { decision, servingRelayPid: record.record.relayPid } : { decision };
}

/**
 * The worker's answer to `relay-started`, addressed to this relay (004/T169), with the browser run
 * it named. Lenient on purpose, as it always was: only `type` and `relayPid` decide whether it is an
 * ack at all, and a `browserRunId` that is not a usable string is read as "not said".
 */
export function readRelayAck(frame: unknown, selfPid: number): { browserRunId: string | undefined } | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const { type, relayPid, browserRunId } = frame as { type?: unknown; relayPid?: unknown; browserRunId?: unknown };
  if (type !== "relay-ack" || relayPid !== selfPid) return undefined;
  const usable = typeof browserRunId === "string" && browserRunId.length > 0 && browserRunId.length <= 64;
  return { browserRunId: usable ? browserRunId : undefined };
}
