import { readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import {
  agentBridgeOwnerSchema,
  agentBrowserIdSchema,
  agentBrowserKindSchema,
  agentBrowserNameSchema,
  type AgentBridgeOwner,
  type AgentBrowserKind,
} from "@hallpass/contracts";
import { z } from "zod";
import {
  inspectBridgeRecord,
  isProcessAlive,
  writeHostFileAtomically,
  type BridgeRecordReading,
} from "./bridge-link.js";
import { bridgeOwnerFilePath, type HostEnvironment } from "./host-paths.js";

/**
 * Who keeps the legacy `bridge.json` when several browsers each run a relay (2026-10-02, 018 R-277b).
 *
 * Chrome and Edge (both registered since 010) each spawn their own relay, and a relay used to take
 * the record over on every `relay-ack`. The relay it displaced saw another pid in the record and
 * left, its browser's worker reconnected a few seconds later, and its new relay took the record
 * back - measured as `relay.superseded` alternating between the two browsers every ~7 s, with every
 * MCP call dialling a relay that was about to go and timing out unpaired. Neither browser worked.
 *
 * Since 018 every relay serves through its own `browsers/<browserId>.json` (`browser-record.ts`),
 * and nothing here decides whether a relay serves or stays. What is left is the record servers
 * older than 0.11.0 dial: the first browser's relay keeps it and every other one leaves it alone.
 * "Which browser" is the worker's browser run id (013/R-184) carried on the ack, and the record's
 * owner is named in a sidecar file, because the record itself is parsed strictly by servers
 * already running.
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

/** Claim the legacy `bridge.json` for this relay, or leave it to the live relay that holds it. */
export type AckDecision = "claim-legacy" | "leave-legacy";

/**
 * Claim the legacy record, or leave it - and leave it only when every fact says another browser's
 * relay holds it right now. Either way this relay serves through its own browser record.
 *
 * Each condition is one way claiming is still right:
 * - the record is absent, unreadable, from another protocol, or this relay's own: nothing to defer to;
 * - the sidecar names some other pid than the record: it is stale, so the owner is unknown;
 * - either run id is missing: an older worker or relay on one side, so identity is unknown;
 * - the run ids are equal: this browser's own previous relay, which a fresh host replaces (004/T169);
 * - the record's port does not answer: a relay that crashed without retracting, or a pid reused -
 *   so a stale record can never block forever;
 * - the record's pid is not a running process, even if the port answers: a relay killed without
 *   retracting whose port some other local listener took since. Servers refuse to dial a dead pid
 *   (`dialRelay`), so leaving it then would leave older servers nobody to dial. Both facts are required.
 */
export function decideOnAck(input: AckDecisionInput): AckDecision {
  const { record, owner, mineRunId } = input;
  if (record.status !== "ok") return "claim-legacy";
  if (record.record.relayPid === input.selfPid) return "claim-legacy";
  if (owner === undefined || owner.relayPid !== record.record.relayPid) return "claim-legacy";
  if (owner.browserRunId === undefined || mineRunId === undefined) return "claim-legacy";
  if (owner.browserRunId === mineRunId) return "claim-legacy";
  return input.recordPidAlive && input.recordLive ? "leave-legacy" : "claim-legacy";
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
  await writeHostFileAtomically(bridgeOwnerFilePath(env), owner);
}

/** Retracts the sidecar only when it names this process, as `removeBridgeRecord` does the record. */
export async function removeBridgeOwner(env?: HostEnvironment): Promise<void> {
  const owner = await readBridgeOwner(env);
  if (owner?.relayPid !== process.pid) return;
  await rm(bridgeOwnerFilePath(env), { force: true });
}

/**
 * Rewrites the sidecar when it does not name this relay and its run, and says whether it did.
 *
 * `removeBridgeOwner` reads then deletes, so an old relay on its way out can delete the sidecar the
 * relay that just took the record over wrote; the record then names a live owner with no sidecar,
 * and the next browser's relay claims it instead of leaving it. The owning relay calls this from
 * its record poll - the T099f repair, applied to the sidecar - so the loss lasts one poll at most.
 * The owner written is exactly what `republish` writes: the run id only when the worker named one.
 * `shouldWrite` is asked after the read, right before the write: a relay that started leaving while
 * the read was out has retracted its sidecar on purpose, and must not put it back.
 */
export async function repairBridgeOwner(options: {
  browserRunId: string | undefined;
  selfPid?: number;
  env?: HostEnvironment;
  shouldWrite?: () => boolean;
}): Promise<boolean> {
  const selfPid = options.selfPid ?? process.pid;
  const current = await readBridgeOwner(options.env);
  if (current?.relayPid === selfPid && current.browserRunId === options.browserRunId) return false;
  if (options.shouldWrite?.() === false) return false;
  await writeBridgeOwner(
    { relayPid: selfPid, ...(options.browserRunId === undefined ? {} : { browserRunId: options.browserRunId }) },
    options.env,
  );
  return true;
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
  if (decideOnAck({ ...facts, recordPidAlive: true, recordLive: true }) === "claim-legacy" || record.status !== "ok") {
    return { decision: "claim-legacy" };
  }
  // The pid first, as `dialRelay` reads it: a dead relay is not probed at all.
  const recordPidAlive = (options.isAlive ?? isProcessAlive)(record.record.relayPid);
  const recordLive = recordPidAlive ? await (options.probe ?? isPortListening)(record.record.port) : false;
  const decision = decideOnAck({ ...facts, recordPidAlive, recordLive });
  // `servingRelayPid`: the live relay that holds the legacy record and keeps it.
  return decision === "leave-legacy" ? { decision, servingRelayPid: record.record.relayPid } : { decision };
}

/** What a `relay-ack` said, each field present only when it was said in a usable form. */
export type RelayAck = {
  browserRunId: string | undefined;
  /** 018 R-268: the worker's minted identity, its kind, the owner's name for it and its features. */
  browserId?: string;
  browserKind?: AgentBrowserKind;
  browserName?: string;
  features?: string[];
};

/**
 * The worker's answer to `relay-started`, addressed to this relay (004/T169), with the browser run
 * and (018) the browser identity it named. Lenient on purpose, as it always was: only `type` and
 * `relayPid` decide whether it is an ack at all, and any other field that is not usable is read as
 * "not said" - each against the contract's own schema, because the id becomes a file name
 * (`browsers/<browserId>.json`) and the name travels into the panel and the agent's hint.
 */
export function readRelayAck(frame: unknown, selfPid: number): RelayAck | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const { type, relayPid, browserRunId, browserId, browserKind, browserName, features } = frame as Record<string, unknown>;
  if (type !== "relay-ack" || relayPid !== selfPid) return undefined;
  const usable = typeof browserRunId === "string" && browserRunId.length > 0 && browserRunId.length <= 64;
  const ack: RelayAck = { browserRunId: usable ? browserRunId : undefined };
  const id = agentBrowserIdSchema.safeParse(browserId);
  if (id.success && id.data.length >= MINTED_BROWSER_ID_MIN_CHARS) ack.browserId = id.data;
  const kind = agentBrowserKindSchema.safeParse(browserKind);
  if (kind.success) ack.browserKind = kind.data;
  const name = agentBrowserNameSchema.safeParse(browserName);
  if (name.success) ack.browserName = name.data;
  const list = ackFeaturesSchema.safeParse(features);
  if (list.success) ack.features = list.data;
  return ack;
}

/** As `relay-ack.browserId` in the contract: a minted id is at least eight characters (018 S1). */
const MINTED_BROWSER_ID_MIN_CHARS = 8;

/** As `relay-ack.features` in the contract. */
const ackFeaturesSchema = z.array(z.string().min(1).max(64)).max(16);
