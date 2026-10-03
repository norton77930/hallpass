import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_LINK_PROTOCOL,
  agentBrowserIdSchema,
  agentBrowserRecordSchema,
  type AgentBrowserRecord,
} from "@hallpass/contracts";
import { defaultBrowserNames } from "@hallpass/domain";
import { isProcessAlive, writeHostFileAtomically, type BridgeRecordReading } from "./bridge-link.js";
import { browsersDirectory, isWindowsDeviceName, type HostEnvironment } from "./host-paths.js";
import { isPortListening, type RelayAck } from "./relay-ownership.js";

/**
 * One record per browser, one writer per record (018 R-266, R-267, R-276).
 *
 * Every browser keeps its own relay - Chrome spawns one per browser anyway - and each relay writes
 * only `browsers/<browserId>.json`. That keeps the 004 lesson (one writer per file) with N browsers:
 * a relay never takes anything from another browser's relay, so the 2026-10-02 flap, where two
 * browsers evicted each other from the one `bridge.json`, has nowhere to happen. What is left of
 * supersession is the same browser's own replacement (004/T169), keyed on the run so that two live
 * browsers that share an id - a copied profile - are told apart rather than replacing each other in
 * a loop. Everything that decides is a pure function here; `native-host.ts` only reads, asks, writes.
 */

/** The fields of a record that come from the worker (or, for an old extension, from the relay). */
export type BrowserIdentity = Pick<
  AgentBrowserRecord,
  "browserId" | "browserRunId" | "kind" | "name" | "legacy" | "features"
>;

/**
 * Who this browser is, from its worker's `relay-ack` (R-268, R-279).
 *
 * An extension older than 018 sends no identity: the browser is then named after its run
 * (`run-<browserRunId>`, stable across that browser's worker restarts) or, from an extension older
 * than the run id, after this relay (`pid-<pid>`, new on every restart), and marked legacy - which
 * is never offered the in-browser choice, so its features are empty whatever it said.
 */
export function identityFromAck(ack: RelayAck, selfPid: number): BrowserIdentity {
  const run = ack.browserRunId === undefined ? {} : { browserRunId: ack.browserRunId };
  if (ack.browserId !== undefined) {
    return {
      browserId: ack.browserId,
      ...run,
      kind: ack.browserKind ?? "unknown",
      ...(ack.browserName === undefined ? {} : { name: ack.browserName }),
      legacy: false,
      features: ack.features ?? [],
    };
  }
  const fromRun = ack.browserRunId === undefined ? undefined : `run-${ack.browserRunId}`;
  // A run id the file name cannot carry (a separator, or too long once prefixed) is not used as one.
  const browserId = fromRun !== undefined && agentBrowserIdSchema.safeParse(fromRun).success ? fromRun : `pid-${selfPid}`;
  return { browserId, ...run, kind: "unknown", legacy: true, features: [] };
}

/**
 * The record's path. The id is checked here as well as where it was read: it becomes a file name,
 * and an id that could hold a separator could name a file anywhere.
 */
export function browserRecordPath(browserId: string, env?: HostEnvironment): string {
  // A device name (`AUX`) passes the character rule but names a device, not a file (T507 m4).
  if (!agentBrowserIdSchema.safeParse(browserId).success || isWindowsDeviceName(browserId)) {
    throw new Error("browser id is not a file name");
  }
  return join(browsersDirectory(env), `${browserId}.json`);
}

/** As `BridgeRecordReading`, with the pid of a record from another build read leniently. */
export type BrowserRecordReading =
  | { status: "ok"; record: AgentBrowserRecord }
  | { status: "absent" }
  | { status: "protocol-mismatch"; relayPid: number | undefined }
  | { status: "unparseable" };

export async function inspectBrowserRecord(path: string): Promise<BrowserRecordReading> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT" ? { status: "absent" } : { status: "unparseable" };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "unparseable" };
  }
  const fields = value && typeof value === "object" ? (value as { protocol?: unknown; relayPid?: unknown }) : {};
  if (fields.protocol !== AGENT_LINK_PROTOCOL) {
    const pid = fields.relayPid;
    return {
      status: "protocol-mismatch",
      relayPid: typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined,
    };
  }
  const parsed = agentBrowserRecordSchema.safeParse(value);
  return parsed.success ? { status: "ok", record: parsed.data } : { status: "unparseable" };
}

/** Temp-then-rename into `browsers/`, exactly as `bridge.json` is written (004/T099f). */
export async function writeBrowserRecord(record: AgentBrowserRecord, env?: HostEnvironment): Promise<void> {
  await writeHostFileAtomically(browserRecordPath(record.browserId, env), record);
}

/** Retracts the record only when it names this relay - as `removeBridgeRecord` does `bridge.json`. */
export async function removeOwnBrowserRecord(browserId: string, selfPid: number, env?: HostEnvironment): Promise<void> {
  const path = browserRecordPath(browserId, env);
  const reading = await inspectBrowserRecord(path);
  if (reading.status !== "ok" || reading.record.relayPid !== selfPid) return;
  await rm(path, { force: true });
}

/**
 * Every record in the directory, by file name. `*.json` exactly, with a name that is a browser id:
 * a temp file (`X.json.<pid>.<rand>.tmp`) is a write in progress, never a record (R-279).
 */
export async function listBrowserRecords(
  env?: HostEnvironment,
): Promise<Array<{ browserId: string; reading: BrowserRecordReading }>> {
  const directory = browsersDirectory(env);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const ids = names
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((id) => agentBrowserIdSchema.safeParse(id).success && !isWindowsDeviceName(id))
    .sort();
  return Promise.all(
    ids.map(async (browserId) => ({ browserId, reading: await inspectBrowserRecord(join(directory, `${browserId}.json`)) })),
  );
}

/**
 * Whether another browser's record names a relay that is there (T515 m4): its pid is a running
 * process AND its port answers. A pid alone is not enough - a relay killed without retracting whose
 * pid was reused would be a ghost browser, counted in `browser-peers` and making the directory
 * refuse `browser-not-chosen` with one real browser (D-018-3). The pid is asked first, so a dead
 * relay costs no socket; the probe is bounded (`isPortListening`).
 */
export async function isRecordRelayLive(
  record: AgentBrowserRecord,
  isAlive: (pid: number) => boolean = isProcessAlive,
  probe: (port: number) => Promise<boolean> = isPortListening,
): Promise<boolean> {
  return isAlive(record.relayPid) && (await probe(record.port));
}

/** The other browsers' records that name a live relay - what a server would list as connected. */
export async function liveOtherRecords(
  listed: ReadonlyArray<{ browserId: string; reading: BrowserRecordReading }>,
  ownBrowserId: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
  probe: (port: number) => Promise<boolean> = isPortListening,
): Promise<AgentBrowserRecord[]> {
  const candidates: AgentBrowserRecord[] = [];
  for (const { browserId, reading } of listed) {
    if (browserId === ownBrowserId || reading.status !== "ok") continue;
    if (reading.record.browserId !== browserId) continue;
    candidates.push(reading.record);
  }
  // Probed together, so N browsers cost one bound, not N.
  const live = await Promise.all(candidates.map((record) => isRecordRelayLive(record, isAlive, probe)));
  return candidates.filter((_record, index) => live[index]);
}

/**
 * Deletes other browsers' records whose relay is dead, and says which (R-279).
 *
 * Dead means what `isRecordRelayLive` says: a dead pid, or a live pid whose port does not answer -
 * a reused pid (T515 m4). A live relay's own poll republishes its record if this ever got it wrong.
 *
 * Read, then read again right before the delete: the second read is what keeps a record a new relay
 * of that browser has just written from going with the old one. The window between that read and
 * the delete is still there, and it is safe only because every owning relay republishes its own
 * record when it reads absent - the same repair `bridge.json` has (004/T099f).
 */
export async function sweepDeadBrowserRecords(options: {
  ownBrowserId: string;
  env?: HostEnvironment;
  isAlive?: (pid: number) => boolean;
  probe?: (port: number) => Promise<boolean>;
}): Promise<string[]> {
  const isAlive = options.isAlive ?? isProcessAlive;
  const probe = options.probe ?? isPortListening;
  const swept: string[] = [];
  for (const { browserId, reading } of await listBrowserRecords(options.env)) {
    if (browserId === options.ownBrowserId || reading.status !== "ok") continue;
    if (await isRecordRelayLive(reading.record, isAlive, probe)) continue;
    const path = browserRecordPath(browserId, options.env);
    const again = await inspectBrowserRecord(path);
    if (again.status !== "ok" || again.record.relayPid !== reading.record.relayPid) continue;
    await rm(path, { force: true });
    swept.push(browserId);
  }
  return swept;
}

/** What a relay knows when it decides about its own record, the pid and port already asked. */
export type OwnRecordFacts = {
  selfPid: number;
  /** The run this relay's worker named; `undefined` when it named none. */
  mineRunId: string | undefined;
  reading: BrowserRecordReading;
  /** Whether the pid the record names is a running process. */
  pidAlive: boolean;
  /** Whether the record's port answered; asked only for a live relay of another run. */
  portLive: boolean;
};

/**
 * The same run, or a run one side cannot name - in both cases the record's relay is this browser's
 * own previous one, as 004/T169 has always treated it. Only two named, different runs are two
 * browsers.
 */
export function sameRunOrUnknown(left: string | undefined, right: string | undefined): boolean {
  return left === undefined || right === undefined || left === right;
}

function isCollision(facts: OwnRecordFacts, record: AgentBrowserRecord): boolean {
  return !sameRunOrUnknown(record.browserRunId, facts.mineRunId) && facts.portLive;
}

/**
 * On `relay-ack`: write the record, or refuse an identity another live browser holds (R-276).
 *
 * A live relay of the same run (or an unknown one) is replaced - the fresh host of a worker restart.
 * A live pid behind a port that does not answer is a reused pid, not a browser.
 */
export function decideOwnRecordOnAck(facts: OwnRecordFacts): "write" | "conflict" {
  if (facts.reading.status !== "ok") return "write";
  const { record } = facts.reading;
  if (record.relayPid === facts.selfPid || !facts.pidAlive) return "write";
  return isCollision(facts, record) ? "conflict" : "write";
}

/**
 * On the 1 s poll, for a relay that owns its record (R-276, R-279):
 * - `keep`: it names this relay;
 * - `republish`: it is gone, or names a dead relay (the T099f repair, per browser);
 * - `wait`: it cannot be read as anything - a file nobody here can attribute is left alone;
 * - `superseded`: this browser's next relay (same run, or unknown) or another build of it took it;
 * - `conflict`: a live relay of another run took it - the late half of a collision, when two acks
 *   raced past each other's check. Whoever's write landed keeps the id; this one stops writing.
 */
export function decideOwnRecordTurn(
  facts: OwnRecordFacts,
): "keep" | "republish" | "wait" | "superseded" | "conflict" {
  const { reading } = facts;
  switch (reading.status) {
    case "absent":
      return "republish";
    case "unparseable":
      return "wait";
    case "protocol-mismatch":
      return reading.relayPid !== undefined && reading.relayPid !== facts.selfPid && facts.pidAlive
        ? "superseded"
        : "republish";
    case "ok": {
      const { record } = reading;
      if (record.relayPid === facts.selfPid) return "keep";
      if (!facts.pidAlive) return "republish";
      if (sameRunOrUnknown(record.browserRunId, facts.mineRunId)) return "superseded";
      return facts.portLive ? "conflict" : "republish";
    }
  }
}

/** Reads the liveness facts for a reading: the pid first, and the port only when it would decide. */
export async function ownRecordFacts(options: {
  selfPid: number;
  mineRunId: string | undefined;
  reading: BrowserRecordReading;
  isAlive?: (pid: number) => boolean;
  probe?: (port: number) => Promise<boolean>;
}): Promise<OwnRecordFacts> {
  const { reading } = options;
  const pid = reading.status === "ok" ? reading.record.relayPid : reading.status === "protocol-mismatch" ? reading.relayPid : undefined;
  const pidAlive = pid !== undefined && pid !== options.selfPid && (options.isAlive ?? isProcessAlive)(pid);
  const needsPort =
    reading.status === "ok" && pidAlive && !sameRunOrUnknown(reading.record.browserRunId, options.mineRunId);
  const portLive = needsPort ? await (options.probe ?? isPortListening)(reading.record.port) : false;
  return { selfPid: options.selfPid, mineRunId: options.mineRunId, reading, pidAlive, portLive };
}

/**
 * The legacy `bridge.json`, for servers older than 018, on the 1 s poll (R-277b): absent or naming
 * a dead relay, it is claimed; naming this relay, it is kept (and its sidecar repaired); naming a
 * live relay, or not readable as a record, it is left alone. No answer here is ever "leave the
 * process": losing the legacy record costs only the old servers' route, never this browser's own.
 */
export function decideLegacyClaim(
  reading: BridgeRecordReading,
  selfPid: number,
  isAlive: (pid: number) => boolean = isProcessAlive,
): "claim" | "own" | "leave" {
  if (reading.status === "absent") return "claim";
  if (reading.status !== "ok") return "leave";
  if (reading.record.relayPid === selfPid) return "own";
  return isAlive(reading.record.relayPid) ? "leave" : "claim";
}

/**
 * The `browser-peers` frame's facts (R-269): how many other browsers are connected, and the name
 * this one goes by when the owner has not named it - numbered against the others with the same
 * pure function a server uses for `list_browsers`, so the panel and the agent read the same word.
 */
export function browserPeers(
  own: AgentBrowserRecord,
  others: readonly AgentBrowserRecord[],
): { others: number; defaultName: string } {
  const names = defaultBrowserNames(
    [own, ...others].map(({ browserId, kind, startedAt }) => ({ browserId, kind, startedAt })),
  );
  return { others: others.length, defaultName: names.get(own.browserId) ?? "Browser" };
}
