import { AGENT_BROWSER_LIST_MAX, type AgentBrowserKind, type AgentBrowserSummary } from "@hallpass/contracts";
import { defaultBrowserNames } from "@hallpass/domain";
import { inspectBridgeRecord, isProcessAlive } from "./bridge-link.js";
import { listBrowserRecords, liveOtherRecords } from "./browser-record.js";
import type { HostEnvironment } from "./host-paths.js";

/**
 * The browsers a server can see as connected, read from disk (018 R-266, R-269, R-277a, R-279).
 *
 * The server is the one process that sees every browser (R-270), and it sees them only through the
 * files their relays write: one `browsers/<browserId>.json` per browser, plus the legacy
 * `bridge.json` a relay older than 0.11.0 still keeps for the whole life of its browser. A record
 * counts when its relay's pid is alive, its port answers a bare connect (T515 m4: a live pid alone
 * may be a reused one) and it speaks this protocol. The probe greets nobody, so listing claims
 * nothing - the 004 lesson is that only a relay may say it is serving.
 */

/** The id a legacy `bridge.json` relay is listed under: it has no browser identity of its own. */
export const LEGACY_BRIDGE_BROWSER_ID = "legacy-bridge";

/**
 * What a legacy relay is called. Not numbered with the others: the relay names its own browser
 * over the per-browser records only (`browserPeers`), so counting this one in would give the agent
 * a different word for the same browser than the owner sees on the panel.
 */
const LEGACY_BRIDGE_NAME = "Browser (older Hallpass)";

export type ConnectedBrowser = AgentBrowserSummary & {
  /** The record's `startedAt`: `list_browsers`' "connected since" (FR-269). */
  connectedSince: string;
  port: number;
  token: string;
  relayPid: number;
  legacy: boolean;
  features: readonly string[];
  /** Where it was read: a per-browser record, or the legacy `bridge.json` (R-277a). */
  source: "record" | "legacy-bridge";
};

export async function listConnectedBrowsers(options: {
  env?: HostEnvironment;
  isAlive?: (pid: number) => boolean;
  /** Whether a record's port answers; a live pid behind a silent port is a reused pid (T515 m4). */
  probe?: (port: number) => Promise<boolean>;
} = {}): Promise<ConnectedBrowser[]> {
  const isAlive = options.isAlive ?? isProcessAlive;
  // The relay's own rule for "connected" (`liveOtherRecords`), with no browser of its own to skip.
  const records = await liveOtherRecords(await listBrowserRecords(options.env), "", isAlive, options.probe);
  // The same inputs `browserPeers` numbers with, so the agent and the panel read the same word.
  const defaults = defaultBrowserNames(records.map(({ browserId, kind, startedAt }) => ({ browserId, kind, startedAt })));
  const listed: ConnectedBrowser[] = records
    .map((record) => ({
      browserId: record.browserId,
      name: record.name ?? defaults.get(record.browserId) ?? "Browser",
      kind: record.kind,
      connectedSince: record.startedAt,
      port: record.port,
      token: record.token,
      relayPid: record.relayPid,
      legacy: record.legacy,
      features: record.features,
      source: "record" as const,
    }))
    .sort(byConnection);

  /**
   * R-277a: a live `bridge.json` relay whose port no per-browser record carries is a browser whose
   * relay predates 0.11.0 - Chrome keeps that relay until the worker restarts - and it stays visible
   * until then. One a 0.11.0 relay claimed (R-277b) is the same port as its own record, listed once.
   */
  const bridge = await inspectBridgeRecord(options.env);
  if (
    bridge.status === "ok" &&
    isAlive(bridge.record.relayPid) &&
    !listed.some((browser) => browser.port === bridge.record.port)
  ) {
    listed.push({
      browserId: LEGACY_BRIDGE_BROWSER_ID,
      name: LEGACY_BRIDGE_NAME,
      kind: "unknown" satisfies AgentBrowserKind,
      connectedSince: bridge.record.startedAt,
      port: bridge.record.port,
      token: bridge.record.token,
      relayPid: bridge.record.relayPid,
      legacy: true,
      features: [],
      source: "legacy-bridge",
    });
  }
  // The contract's bound on any list an agent is given; sixteen browsers at once is not a desktop.
  return listed.slice(0, AGENT_BROWSER_LIST_MAX);
}

/** The part of each browser an agent may be told in a refusal or a selection (contracts "BrowserSummary"). */
export function browserSummaries(browsers: readonly ConnectedBrowser[]): AgentBrowserSummary[] {
  return browsers.map(({ browserId, name, kind }) => ({ browserId, name, kind }));
}

function byConnection(left: ConnectedBrowser, right: ConnectedBrowser): number {
  if (left.connectedSince !== right.connectedSince) {
    const leftAt = Date.parse(left.connectedSince);
    const rightAt = Date.parse(right.connectedSince);
    if (!Number.isNaN(leftAt) && !Number.isNaN(rightAt) && leftAt !== rightAt) return leftAt - rightAt;
    return left.connectedSince < right.connectedSince ? -1 : 1;
  }
  return left.browserId < right.browserId ? -1 : left.browserId > right.browserId ? 1 : 0;
}
