import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_BROWSER_LIST_MAX, AGENT_LINK_PROTOCOL, type AgentBrowserRecord } from "@hallpass/contracts";
import { writeBridgeRecord } from "../src/bridge-link.js";
import { browserSummaries, LEGACY_BRIDGE_BROWSER_ID, listConnectedBrowsers } from "../src/browser-directory.js";
import { writeBrowserRecord } from "../src/browser-record.js";
import { browsersDirectory } from "../src/host-paths.js";

/**
 * 018 T503 - the server's list of connected browsers (R-266, R-269, R-277a, R-279): every live
 * per-browser record, plus the legacy `bridge.json` relay while it is not one of them.
 */

const LIVE_A = 1_001;
const LIVE_B = 1_002;
const LIVE_LEGACY = 1_003;
const DEAD = 1_009;
const alive = (pid: number): boolean => pid !== DEAD;
/** A port nothing listens on any more, behind a pid that is alive: a reused pid (T515 m4). */
const SILENT_PORT = 50_666;
const answers = async (port: number): Promise<boolean> => port !== SILENT_PORT;

function record(overrides: Partial<AgentBrowserRecord>): AgentBrowserRecord {
  return {
    browserId: "browser-a",
    browserRunId: "run-a",
    kind: "chrome",
    legacy: false,
    features: [],
    relayPid: LIVE_A,
    port: 50_001,
    token: "t".repeat(64),
    startedAt: "2026-10-03T08:00:00.000Z",
    protocol: AGENT_LINK_PROTOCOL,
    ...overrides,
  };
}

describe("018 T503 browser directory", () => {
  let dataDir = "";
  let env: { LOCALAPPDATA: string };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hallpass-directory-"));
    env = { LOCALAPPDATA: dataDir };
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("lists nothing when no relay has written anything", async () => {
    await expect(listConnectedBrowsers({ env, isAlive: alive, probe: answers })).resolves.toEqual([]);
  });

  it("lists live records in connection order, named as the relay names them, the owner's name winning", async () => {
    await writeBrowserRecord(record({ browserId: "browser-b", relayPid: LIVE_B, port: 50_002, startedAt: "2026-10-03T09:00:00.000Z" }), env);
    await writeBrowserRecord(record({ browserId: "browser-a" }), env);
    await writeBrowserRecord(
      record({ browserId: "browser-e", kind: "edge", name: "Work Edge", port: 50_003, startedAt: "2026-10-03T07:00:00.000Z" }),
      env,
    );

    const listed = await listConnectedBrowsers({ env, isAlive: alive, probe: answers });

    expect(browserSummaries(listed)).toEqual([
      { browserId: "browser-e", name: "Work Edge", kind: "edge" },
      { browserId: "browser-a", name: "Chrome", kind: "chrome" },
      { browserId: "browser-b", name: "Chrome 2", kind: "chrome" },
    ]);
    expect(listed[1]).toMatchObject({ connectedSince: "2026-10-03T08:00:00.000Z", port: 50_001, source: "record" });
  });

  it("leaves out a dead relay's record, a temp file, a record under another id and an older protocol", async () => {
    await writeBrowserRecord(record({ browserId: "browser-a" }), env);
    await writeBrowserRecord(record({ browserId: "browser-dead", relayPid: DEAD, port: 50_009 }), env);
    const dir = browsersDirectory(env);
    await writeFile(join(dir, "browser-tmp.json.123.abcd.tmp"), JSON.stringify(record({ browserId: "browser-tmp" })));
    await writeFile(join(dir, "browser-x.json"), JSON.stringify(record({ browserId: "browser-y", port: 50_005 })));
    await writeFile(join(dir, "browser-old.json"), JSON.stringify({ ...record({ browserId: "browser-old" }), protocol: 1 }));
    await writeFile(join(dir, "browser-junk.json"), "{ not json");

    const listed = await listConnectedBrowsers({ env, isAlive: alive, probe: answers });

    expect(listed.map((browser) => browser.browserId)).toEqual(["browser-a"]);
  });

  it("leaves out a record whose pid is alive but whose port does not answer - a reused pid (T515 m4)", async () => {
    await writeBrowserRecord(record({ browserId: "browser-a" }), env);
    await writeBrowserRecord(record({ browserId: "browser-ghost", relayPid: LIVE_B, port: SILENT_PORT }), env);

    const listed = await listConnectedBrowsers({ env, isAlive: alive, probe: answers });

    expect(listed.map((browser) => browser.browserId)).toEqual(["browser-a"]);
  });

  it("numbers names over the live records only, so a dead one does not shift them", async () => {
    await writeBrowserRecord(record({ browserId: "browser-dead", relayPid: DEAD, startedAt: "2026-10-03T06:00:00.000Z" }), env);
    await writeBrowserRecord(record({ browserId: "browser-a" }), env);

    expect(browserSummaries(await listConnectedBrowsers({ env, isAlive: alive, probe: answers }))).toEqual([
      { browserId: "browser-a", name: "Chrome", kind: "chrome" },
    ]);
  });

  it("adds a live legacy bridge.json relay whose port no record carries, as one unknown browser (R-277a)", async () => {
    await writeBrowserRecord(record({ browserId: "browser-a" }), env);
    await writeBridgeRecord(
      { port: 50_100, token: "l".repeat(64), relayPid: LIVE_LEGACY, startedAt: "2026-10-03T05:00:00.000Z", protocol: AGENT_LINK_PROTOCOL },
      env,
    );

    const listed = await listConnectedBrowsers({ env, isAlive: alive, probe: answers });

    expect(browserSummaries(listed)).toEqual([
      { browserId: "browser-a", name: "Chrome", kind: "chrome" },
      { browserId: LEGACY_BRIDGE_BROWSER_ID, name: "Browser (older Hallpass)", kind: "unknown" },
    ]);
    expect(listed[1]).toMatchObject({ port: 50_100, relayPid: LIVE_LEGACY, legacy: true, source: "legacy-bridge" });
  });

  it("does not list bridge.json twice when a per-browser relay claimed it, nor when its relay is dead", async () => {
    await writeBrowserRecord(record({ browserId: "browser-a" }), env);
    await writeBridgeRecord(
      { port: 50_001, token: "t".repeat(64), relayPid: LIVE_A, startedAt: "2026-10-03T08:00:00.000Z", protocol: AGENT_LINK_PROTOCOL },
      env,
    );
    expect((await listConnectedBrowsers({ env, isAlive: alive, probe: answers })).map((browser) => browser.browserId)).toEqual(["browser-a"]);

    await writeBridgeRecord(
      { port: 50_100, token: "l".repeat(64), relayPid: DEAD, startedAt: "2026-10-03T05:00:00.000Z", protocol: AGENT_LINK_PROTOCOL },
      env,
    );
    expect((await listConnectedBrowsers({ env, isAlive: alive, probe: answers })).map((browser) => browser.browserId)).toEqual(["browser-a"]);
  });

  it("lists the legacy relay alone when it is the only one - the pre-018 single browser", async () => {
    await mkdir(join(dataDir, "hallpass"), { recursive: true });
    await writeBridgeRecord(
      { port: 50_100, token: "l".repeat(64), relayPid: LIVE_LEGACY, startedAt: "2026-10-03T05:00:00.000Z", protocol: AGENT_LINK_PROTOCOL },
      env,
    );
    expect((await listConnectedBrowsers({ env, isAlive: alive, probe: answers })).map((browser) => browser.browserId)).toEqual([
      LEGACY_BRIDGE_BROWSER_ID,
    ]);
  });

  it("gives an agent at most the list the contract allows", async () => {
    for (let index = 0; index < AGENT_BROWSER_LIST_MAX + 2; index += 1) {
      await writeBrowserRecord(record({ browserId: `browser-${index}`, port: 51_000 + index }), env);
    }
    expect(await listConnectedBrowsers({ env, isAlive: alive, probe: answers })).toHaveLength(AGENT_BROWSER_LIST_MAX);
  });
});
