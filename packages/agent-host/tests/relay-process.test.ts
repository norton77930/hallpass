import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_LINK_PROTOCOL,
  agentBrowserRecordSchema,
  BROWSER_CHOICE_FEATURE,
  type AgentBrowserRecord,
} from "@hallpass/contracts";
import {
  bridgeFilePath,
  createFrameChannel,
  dialRelay,
  encodeFrame,
  FrameDecoder,
  readBridgeRecord,
  type FrameChannel,
  type RelayDial,
} from "../src/index.js";
import { bridgeOwnerFilePath, browsersDirectory } from "../src/host-paths.js";
import { readBridgeOwner, writeBridgeOwner } from "../src/relay-ownership.js";

/**
 * 004/T093 — the relay is the listener, and several servers share it.
 *
 * This drives the built `dist/native-host.js` exactly as Chrome does: its stdio is the native port,
 * and everything else dials the port it publishes. That is the only way to see the property S1
 * exists for - two agent sessions on one browser, each getting its own answers - because it lives in
 * the seam between the process boundary and the multiplexer, and the multiplexer's own unit tests
 * (relay-mux.test.ts) cannot see a socket.
 *
 * The frames here are deliberately minimal: the relay interprets nothing it forwards, so a call is
 * whatever carries a `callId` and an answer is whatever names the same one back.
 */

const RELAY_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "native-host.js");

/** The dial cadence a test can afford; the product's own is 5 s (`DIAL_RETRY_MS`). */
const RETRY_MS = 100;

describe("T093 the relay listens and multiplexes", () => {
  let dataDir = "";
  let relay: ChildProcessWithoutNullStreams | undefined;
  /** Every relay this test started, so a test that starts two still leaves none behind. */
  const relays: ChildProcessWithoutNullStreams[] = [];
  const dials: RelayDial[] = [];
  /** Links dialled straight at one browser's record, as an 018 server does (R-266). */
  const direct: FrameChannel[] = [];
  /** Every frame the relay wrote towards Chrome. */
  let toChrome: unknown[] = [];
  /** The same frames, kept per relay, for the tests that start two and ask which one spoke. */
  const toChromeByPid = new Map<number | undefined, unknown[]>();

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hallpass-relay-"));
    toChrome = [];
    toChromeByPid.clear();
  });

  afterEach(async () => {
    await Promise.all(dials.map((dial) => dial.stop()));
    dials.length = 0;
    await Promise.all(direct.map((channel) => channel.close()));
    direct.length = 0;
    for (const child of relays) {
      child.kill();
    }
    relays.length = 0;
    relay = undefined;
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      dataDir = "";
    }
  });

  /**
   * The test is Chrome's side of the native port. Like the worker it stands in for, it answers
   * `relay-started` with `relay-ack` (004/T169, protocol 2) - unless a test is about a relay that
   * nobody ever acknowledges, which is what `ack: false` is for.
   */
  function startRelay(
    options: { ack?: boolean; ackBoundMs?: number; browserRunId?: string; identity?: Identity } = {},
  ): ChildProcessWithoutNullStreams {
    const child = spawn(process.execPath, [RELAY_ENTRY], {
      env: {
        ...process.env,
        LOCALAPPDATA: dataDir,
        ...(options.ackBoundMs === undefined ? {} : { HALLPASS_RELAY_ACK_BOUND_MS: String(options.ackBoundMs) }),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const decoder = new FrameDecoder();
    const own: unknown[] = [];
    toChromeByPid.set(child.pid, own);
    child.stdout.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(new Uint8Array(chunk))) {
        toChrome.push(frame);
        own.push(frame);
        if (options.ack !== false && isFrame(frame, "relay-started")) {
          child.stdin.write(
            encodeFrame({
              type: "relay-ack",
              relayPid: (frame as { relayPid: number }).relayPid,
              ...(options.browserRunId === undefined ? {} : { browserRunId: options.browserRunId }),
              ...options.identity,
            }),
          );
        }
      }
    });
    relays.push(child);
    relay = child;
    return child;
  }

  function attach(sessionId: string): { dial: RelayDial; frames: unknown[]; detached: () => boolean } {
    const frames: unknown[] = [];
    let gone = false;
    const dial = dialRelay({
      hello: { sessionId, agentId: `agent-${sessionId}`, displayName: `Agent ${sessionId}` },
      onFrame: (value) => frames.push(value),
      onDetached: () => {
        gone = true;
      },
      env: { LOCALAPPDATA: dataDir },
      retryMs: RETRY_MS,
    });
    dials.push(dial);
    return { dial, frames, detached: () => gone };
  }

  it("announces itself to Chrome and lets two servers attach to the one port", async () => {
    const child = startRelay();

    const first = attach("session-one");
    const second = attach("session-two");
    await expect(first.dial.attached).resolves.toBe(child.pid);
    await expect(second.dial.attached).resolves.toBe(child.pid);

    // The worker's 15 s reconciliation starts from this frame, so it is the relay's first word.
    // It also names where the record goes (006 FR-082): the worker cannot see the host data
    // directory and this is the only way the not-connected page ever learns where the file is. In
    // 018 that is the per-browser directory (R-279): the browser's id arrives only on the ack, after
    // this frame, so the directory is what the relay can name truthfully here.
    await waitFor(() => toChrome.length > 0, "the relay-started frame");
    expect(toChrome[0]).toEqual({
      type: "relay-started",
      relayPid: child.pid,
      recordPath: browsersDirectory({ LOCALAPPDATA: dataDir }),
    });
  });

  it("gives each session its own answer and never the other's", async () => {
    startRelay();
    const first = attach("session-one");
    const second = attach("session-two");
    await first.dial.attached;
    await second.dial.attached;

    first.dial.send({ callId: "c1", sessionId: "session-one", tool: "tabs_context", args: {} });
    second.dial.send({ callId: "c2", sessionId: "session-two", tool: "tabs_context", args: {} });
    await waitFor(() => calls().length === 2, "both calls to reach Chrome");

    // Answered out of order, because the browser answers whenever each page allows.
    writeToRelay({ callId: "c2", outcome: "ok", result: ["two"] });
    writeToRelay({ callId: "c1", outcome: "ok", result: ["one"] });
    await waitFor(() => first.frames.length > 0 && second.frames.length > 0, "both answers to come back");

    expect(first.frames).toEqual([{ callId: "c1", outcome: "ok", result: ["one"] }]);
    expect(second.frames).toEqual([{ callId: "c2", outcome: "ok", result: ["two"] }]);
  });

  it("tells Chrome which session ended when one server's socket closes", async () => {
    startRelay();
    const first = attach("session-one");
    const second = attach("session-two");
    await first.dial.attached;
    await second.dial.attached;

    await second.dial.stop();

    await waitFor(
      () => toChrome.some((frame) => isFrame(frame, "session-ended")),
      "the session-ended frame",
    );
    expect(toChrome.filter((frame) => isFrame(frame, "session-ended"))).toEqual([
      { type: "session-ended", sessionId: "session-two" },
    ]);
    // The session that is still there was not ended alongside it.
    expect(first.detached()).toBe(false);
  });

  it("drops every server and retracts its record when Chrome closes the port", async () => {
    const child = startRelay();
    const first = attach("session-one");
    await first.dial.attached;
    await expect(readBridgeRecord({ LOCALAPPDATA: dataDir })).resolves.toMatchObject({
      relayPid: child.pid,
    });

    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    child.stdin.end();

    // Exit 0: Chrome going away is the ordinary end of a relay, not a host failure.
    await expect(within(exited, 8_000, "the superseded relay to exit")).resolves.toBe(0);
    await waitFor(() => first.detached(), "the server's link to drop");
    await expect(readBridgeRecord({ LOCALAPPDATA: dataDir })).resolves.toBeUndefined();
    // Its own browser record goes with it (018 R-266): nobody can dial a browser that closed.
    expect(await recordFileNames()).toEqual([]);
  });

  it("exits when its own browser's next relay takes the record over, leaving one owner", async () => {
    // 018 R-276: replacement is keyed on the run - the same browser, the same run, a fresh host.
    const sameBrowser = { browserRunId: "run-chrome", identity: CHROME_A };
    const first = startRelay(sameBrowser);
    const server = attach("session-one");
    await server.dial.attached;
    await waitForRecordPid(first.pid, "the first relay's record");
    await waitForBrowserRecordPid(CHROME_A.browserId, first.pid, "the first relay's browser record");

    // Started while the first is still alive - the split bridge B13 measured, where `bridge.json`
    // named one relay and the worker's native port belonged to the other.
    const exited = new Promise<number | null>((resolve) => first.once("exit", (code) => resolve(code)));
    const second = startRelay(sameBrowser);
    await waitForRecordPid(second.pid, "the second relay's record");
    await waitForBrowserRecordPid(CHROME_A.browserId, second.pid, "the second relay's browser record");

    // A relay the record no longer names can be dialled by nobody - servers only ever dial the
    // record - so it exits rather than holding a second native port open behind the one that serves.
    await expect(within(exited, 8_000, "the superseded relay to exit")).resolves.toBe(0);
    // The relay that owns the record is untouched by the other one's exit.
    expect(second.exitCode).toBeNull();
    await expect(readBridgeRecord({ LOCALAPPDATA: dataDir })).resolves.toMatchObject({
      relayPid: second.pid,
    });

    /**
     * 004/T099g - what the loser said to Chrome on its way out.
     *
     * Its `close()` ends every server socket, and each close used to be announced as
     * `session-ended`. Chrome is *one* worker behind both relays, so those frames released the tabs
     * and the debugger of sessions whose servers were at that moment dialling the winner. The
     * server is still there; only a relay it no longer uses has gone.
     */
    expect(toChromeByPid.get(first.pid)?.filter((frame) => isFrame(frame, "session-ended"))).toEqual(
      [],
    );
    // And the session really is still live: it re-greets the winner and calls through it, which is
    // what the loser's announcement would have contradicted.
    await waitFor(() => {
      server.dial.send({ callId: "c-after", sessionId: "session-one", tool: "tabs_context", args: {} });
      return (toChromeByPid.get(second.pid) ?? []).some(
        (frame) => (frame as { callId?: unknown }).callId === "c-after",
      );
    }, "the server's call to reach the winning relay");
  });

  /**
   * 018 (R-266, R-267, R-274, R-276, R-277). Every browser keeps its own relay and writes only its own
   * record, `browsers/<browserId>.json`, and every relay serves: the 2026-10-02 stand-by stop-gap is
   * gone, so no relay writes `relay-standby` or leaves because another browser is serving. A relay
   * still leaves when its own browser's next relay - the same run - replaces it (004/T169).
   */
  describe("018 several browsers, one relay and one record each", () => {
    it("both browsers' relays write their own record and both serve", async () => {
      const env = { LOCALAPPDATA: dataDir };
      const chrome = startRelay({ browserRunId: "run-chrome", identity: CHROME_A });
      const edge = startRelay({ browserRunId: "run-edge", identity: EDGE_B });
      const chromeRecord = await waitForBrowserRecordPid(CHROME_A.browserId, chrome.pid, "Chrome's record");
      const edgeRecord = await waitForBrowserRecordPid(EDGE_B.browserId, edge.pid, "Edge's record");
      expect(chromeRecord).toMatchObject({
        browserId: CHROME_A.browserId,
        browserRunId: "run-chrome",
        kind: "chrome",
        legacy: false,
        features: [BROWSER_CHOICE_FEATURE],
        relayPid: chrome.pid,
        protocol: AGENT_LINK_PROTOCOL,
      });
      expect(chromeRecord.name).toBeUndefined();
      expect(edgeRecord).toMatchObject({
        browserId: EDGE_B.browserId,
        browserRunId: "run-edge",
        kind: "edge",
        name: "Work Edge",
        legacy: false,
        features: [],
        relayPid: edge.pid,
      });
      expect(chromeRecord.port).not.toBe(edgeRecord.port);

      // Past both relays' one-second poll: a stand-by or a cross-browser exit would have happened.
      await sleep(1_500);
      expect(chrome.exitCode).toBeNull();
      expect(edge.exitCode).toBeNull();
      expect(toChrome.filter((frame) => isFrame(frame, "relay-standby"))).toEqual([]);
      // The legacy record has exactly one owner, and its sidecar agrees with it once the owner's
      // poll has repaired whatever the two simultaneous acks left there (R-277).
      const legacy = await readBridgeRecord(env);
      expect([chrome.pid, edge.pid]).toContain(legacy?.relayPid);
      await vi.waitFor(() => expect(readBridgeOwner(env)).resolves.toMatchObject({ relayPid: legacy?.relayPid }), {
        timeout: 3_000,
        interval: 50,
      });
      await expect(readBridgeRecord(env)).resolves.toMatchObject({ relayPid: legacy?.relayPid });

      // A server dials one browser's own record, and its call reaches only that browser.
      const toChromeLink = await dialRecord(chromeRecord, "session-chrome");
      const toEdgeLink = await dialRecord(edgeRecord, "session-edge");
      toChromeLink.channel.send({ callId: "c-chrome", sessionId: "session-chrome", tool: "tabs_context", args: {} });
      toEdgeLink.channel.send({ callId: "c-edge", sessionId: "session-edge", tool: "tabs_context", args: {} });
      await waitFor(
        () => callIdsOf(chrome.pid).includes("c-chrome") && callIdsOf(edge.pid).includes("c-edge"),
        "each call to reach its own browser",
      );
      expect(callIdsOf(chrome.pid)).toEqual(["c-chrome"]);
      expect(callIdsOf(edge.pid)).toEqual(["c-edge"]);
    });

    it("closing one browser leaves the other serving and retracts only the closed browser's record", async () => {
      const chrome = startRelay({ browserRunId: "run-chrome", identity: CHROME_A });
      const edge = startRelay({ browserRunId: "run-edge", identity: EDGE_B });
      await waitForBrowserRecordPid(CHROME_A.browserId, chrome.pid, "Chrome's record");
      const edgeRecord = await waitForBrowserRecordPid(EDGE_B.browserId, edge.pid, "Edge's record");
      const link = await dialRecord(edgeRecord, "session-edge");

      const chromeExited = exitOf(chrome);
      chrome.stdin.end();
      await expect(within(chromeExited, 8_000, "Chrome's relay to exit")).resolves.toBe(0);
      await expect(readBrowserRecordFile(CHROME_A.browserId)).resolves.toBeUndefined();

      await sleep(1_200);
      expect(edge.exitCode).toBeNull();
      await expect(readBrowserRecordFile(EDGE_B.browserId)).resolves.toMatchObject({ relayPid: edge.pid });
      expect(link.closed()).toBe(false);
      link.channel.send({ callId: "c-after", sessionId: "session-edge", tool: "tabs_context", args: {} });
      await waitFor(() => callIdsOf(edge.pid).includes("c-after"), "the call to reach the browser still open");
    });

    it("refuses a live browser that shares another run's id, and serves once its worker names a new one (R-276)", async () => {
      const original = startRelay({ browserRunId: "run-original", identity: CHROME_A });
      await waitForBrowserRecordPid(CHROME_A.browserId, original.pid, "the original browser's record");

      // A copied profile: the same minted id, another run.
      const copy = startRelay({ browserRunId: "run-copy", identity: CHROME_A });
      await waitFor(
        () => framesOf(copy.pid).some((frame) => isFrame(frame, "browser-identity-conflict")),
        "the conflict to reach the copy's worker",
      );
      // Past both polls: neither relay replaced the other, and neither left.
      await sleep(1_500);
      await expect(readBrowserRecordFile(CHROME_A.browserId)).resolves.toMatchObject({
        relayPid: original.pid,
        browserRunId: "run-original",
      });
      expect(original.exitCode).toBeNull();
      expect(copy.exitCode).toBeNull();
      expect(framesOf(original.pid).filter((frame) => isFrame(frame, "browser-identity-conflict"))).toEqual([]);
      expect(framesOf(copy.pid).filter((frame) => isFrame(frame, "browser-identity-conflict"))).toEqual([
        { type: "browser-identity-conflict" },
      ]);
      expect(await recordFileNames()).toEqual([`${CHROME_A.browserId}.json`]);

      // The copy's worker mints a new identity and answers again on the same port.
      ackAgain(copy, { browserRunId: "run-copy", ...CHROME_A, browserId: COPY_ID, browserName: "Chrome (2)" });
      const copyRecord = await waitForBrowserRecordPid(COPY_ID, copy.pid, "the copy's record under its new id");
      expect(copyRecord).toMatchObject({ browserRunId: "run-copy", legacy: false, name: "Chrome (2)" });
      await expect(readBrowserRecordFile(CHROME_A.browserId)).resolves.toMatchObject({ relayPid: original.pid });
    });

    it("keeps one bridge.json owner for older servers, re-claimed when it leaves, and the other never exits (R-277)", async () => {
      const env = { LOCALAPPDATA: dataDir };
      const chrome = startRelay({ browserRunId: "run-chrome", identity: CHROME_A });
      // A server from before 018 dials only `bridge.json`.
      const oldServer = attach("session-old");
      await expect(oldServer.dial.attached).resolves.toBe(chrome.pid);
      await waitForRecordPid(chrome.pid, "Chrome's relay to claim bridge.json");
      await vi.waitFor(() =>
        expect(readBridgeOwner(env)).resolves.toEqual({ relayPid: chrome.pid, browserRunId: "run-chrome" }),
      );

      const edge = startRelay({ browserRunId: "run-edge", identity: EDGE_B });
      await waitForBrowserRecordPid(EDGE_B.browserId, edge.pid, "Edge's record");
      await sleep(1_500);
      await expect(readBridgeRecord(env)).resolves.toMatchObject({ relayPid: chrome.pid });
      await expect(readBridgeOwner(env)).resolves.toEqual({ relayPid: chrome.pid, browserRunId: "run-chrome" });
      expect(chrome.exitCode).toBeNull();
      expect(edge.exitCode).toBeNull();

      const chromeExited = exitOf(chrome);
      chrome.stdin.end();
      await expect(within(chromeExited, 8_000, "Chrome's relay to exit")).resolves.toBe(0);

      // The relay still running claims the legacy record on its own poll - no restart needed.
      await waitForRecordPid(edge.pid, "Edge's relay to claim bridge.json");
      await vi.waitFor(() =>
        expect(readBridgeOwner(env)).resolves.toEqual({ relayPid: edge.pid, browserRunId: "run-edge" }),
      );
      expect(edge.exitCode).toBeNull();
      // And the older server follows the record there.
      await waitFor(() => {
        oldServer.dial.send({ callId: "c-legacy", sessionId: "session-old", tool: "tabs_context", args: {} });
        return callIdsOf(edge.pid).includes("c-legacy");
      }, "the older server's call to reach the relay that claimed bridge.json");
    });

    it("republishes its own browser record, unchanged, when it is deleted underneath it", async () => {
      const chrome = startRelay({ browserRunId: "run-chrome", identity: CHROME_A });
      const before = await waitForBrowserRecordPid(CHROME_A.browserId, chrome.pid, "Chrome's record");
      await rm(browserRecordPath(CHROME_A.browserId), { force: true });
      await expect(readBrowserRecordFile(CHROME_A.browserId)).resolves.toBeUndefined();

      const after = await waitForBrowserRecordPid(CHROME_A.browserId, chrome.pid, "the relay to republish");
      expect(after).toEqual(before);
      expect(chrome.exitCode).toBeNull();
    });

    it("sweeps another browser's record whose relay is dead, and leaves temp files alone", async () => {
      const directory = browsersDirectory({ LOCALAPPDATA: dataDir });
      const deadPid = await exitedPid();
      await mkdir(directory, { recursive: true });
      const stale: AgentBrowserRecord = {
        browserId: "stale-browser",
        kind: "chrome",
        legacy: false,
        features: [],
        relayPid: deadPid,
        port: 50_000,
        token: "s".repeat(64),
        startedAt: "2026-10-03T08:00:00.000Z",
        protocol: AGENT_LINK_PROTOCOL,
      };
      await writeFile(join(directory, "stale-browser.json"), JSON.stringify(stale));
      const temp = `stale-browser.json.${deadPid}.abcd1234.tmp`;
      await writeFile(join(directory, temp), JSON.stringify(stale));

      const chrome = startRelay({ browserRunId: "run-chrome", identity: CHROME_A });
      await waitForBrowserRecordPid(CHROME_A.browserId, chrome.pid, "Chrome's record");
      await vi.waitFor(async () => expect(await recordFileNames()).toEqual([`${CHROME_A.browserId}.json`]), {
        timeout: 4_000,
        interval: 50,
      });
      expect(await readdir(directory)).toContain(temp);
    });

    it("tells each worker how many other browsers are connected and its default name (browser-peers)", async () => {
      const first = startRelay({ browserRunId: "run-1", identity: CHROME_A });
      await waitFor(() => peersOf(first.pid).length > 0, "the first browser-peers frame");
      expect(peersOf(first.pid).at(-1)).toEqual({ type: "browser-peers", others: 0, defaultName: "Chrome" });

      const second = startRelay({ browserRunId: "run-2", identity: CHROME_C });
      await waitFor(() => peersOf(first.pid).at(-1)?.others === 1, "the first relay to count the second");
      await waitFor(() => peersOf(second.pid).at(-1)?.others === 1, "the second relay to count the first");
      expect(peersOf(first.pid).at(-1)).toEqual({ type: "browser-peers", others: 1, defaultName: "Chrome" });
      expect(peersOf(second.pid).at(-1)).toEqual({ type: "browser-peers", others: 1, defaultName: "Chrome 2" });

      // Sent on change only.
      const sent = peersOf(first.pid).length;
      await sleep(1_500);
      expect(peersOf(first.pid)).toHaveLength(sent);

      const secondExited = exitOf(second);
      second.stdin.end();
      await within(secondExited, 8_000, "the second relay to exit");
      await waitFor(() => peersOf(first.pid).at(-1)?.others === 0, "the first relay to see the second gone");
    });

    it("rewrites its own record's name when the owner renames the browser (browser-name)", async () => {
      const chrome = startRelay({ browserRunId: "run-chrome", identity: CHROME_A });
      await waitForBrowserRecordPid(CHROME_A.browserId, chrome.pid, "Chrome's record");
      chrome.stdin.write(encodeFrame({ type: "browser-name", name: "Home Chrome" }));
      await vi.waitFor(
        async () =>
          expect(await readBrowserRecordFile(CHROME_A.browserId)).toMatchObject({
            name: "Home Chrome",
            relayPid: chrome.pid,
          }),
        { timeout: 3_000, interval: 50 },
      );
    });

    it("names a browser whose worker sent no identity run-<run> (or pid-<pid>) and marks it legacy", async () => {
      const withRun = startRelay({ browserRunId: "0123abcd-run" });
      const runRecord = await waitForBrowserRecordPid("run-0123abcd-run", withRun.pid, "the run-named record");
      expect(runRecord).toMatchObject({ browserRunId: "0123abcd-run", kind: "unknown", legacy: true, features: [] });
      expect(runRecord.name).toBeUndefined();

      const noRun = startRelay();
      const pidRecord = await waitForBrowserRecordPid(`pid-${noRun.pid}`, noRun.pid, "the pid-named record");
      expect(pidRecord).toMatchObject({ kind: "unknown", legacy: true });
      expect(pidRecord.browserRunId).toBeUndefined();
    });
  });


  /**
   * 004/T099f - the record lease repairs itself instead of only detecting a loss.
   *
   * `removeBridgeRecord` reads then deletes, so a relay on its way out can lose the race with the
   * winner's write and delete the *live* relay's record. Nothing else republishes it: every server
   * dials the record, so a live relay the record does not name is a relay nobody can reach, and
   * every call answers `bridge-unavailable` - the owner's E1 arriving through the mechanism built
   * to remove it. The poll that detects supersession is the one place that can also repair, so a
   * record that reads as *absent* is republished rather than ignored.
   */
  /**
   * 004/T169. Chrome spawns a host for every `connectNative`, including one from a worker instance
   * that is on its way out and will never read a frame. Such a host used to take the record the
   * moment it listened, and the relay serving a live call was drained and closed under it. Now a
   * relay publishes only once its owner has answered `relay-started`; one nobody answers never
   * touches the record and leaves on a bound - and the relay that was serving is untouched.
   */
  it("never publishes, and leaves on the bound, when nobody acknowledges it (T169)", async () => {
    const serving = startRelay();
    const server = attach("session-one");
    await server.dial.attached;
    await waitForRecordPid(serving.pid, "the serving relay's record");

    const unowned = startRelay({ ack: false, ackBoundMs: 1_500 });
    const exited = new Promise<number | null>((resolve) => unowned.once("exit", (code) => resolve(code)));
    await expect(within(exited, 8_000, "the unacknowledged relay to leave")).resolves.toBe(0);

    // The record never changed hands - and was not deleted on the way out either, which a relay that
    // had published would do - and the serving relay is still the one the server is on.
    await expect(readBridgeRecord({ LOCALAPPDATA: dataDir })).resolves.toMatchObject({ relayPid: serving.pid });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(readBridgeRecord({ LOCALAPPDATA: dataDir })).resolves.toMatchObject({ relayPid: serving.pid });
    expect(serving.exitCode).toBeNull();
    expect(server.detached()).toBe(false);
    // Nor did it write a browser record of its own (018): only the serving relay's is there.
    expect(await recordFileNames()).toEqual([`pid-${serving.pid}.json`]);
  });

  it("republishes its own record when it is deleted underneath it, and keeps serving", async () => {
    const child = startRelay();
    const server = attach("session-one");
    await server.dial.attached;
    await waitForRecordPid(child.pid, "the relay's own record");

    // Exactly what a dying relay that lost the write race does to the live one's record.
    await rm(bridgeFilePath({ LOCALAPPDATA: dataDir }), { force: true });
    await expect(readBridgeRecord({ LOCALAPPDATA: dataDir })).resolves.toBeUndefined();

    await waitForRecordPid(child.pid, "the relay to republish its own record");
    expect(child.exitCode).toBeNull();

    // And the port behind the republished record is the one that was serving all along.
    const restored = await readBridgeRecord({ LOCALAPPDATA: dataDir });
    expect(restored?.port).toBeGreaterThan(0);
    await waitFor(() => {
      server.dial.send({ callId: "c-repaired", sessionId: "session-one", tool: "tabs_context", args: {} });
      return (toChromeByPid.get(child.pid) ?? []).some(
        (frame) => (frame as { callId?: unknown }).callId === "c-repaired",
      );
    }, "the server's call to reach the relay that repaired its record");
  });

  /**
   * Two browsers (2026-10-02) - the sidecar repairs itself the way T099f repairs the record.
   *
   * `removeBridgeOwner` reads then deletes, so an old relay on its way out can delete the sidecar the
   * relay that just took over wrote. The record still names the live owner, but with no sidecar the
   * next browser's relay takes over instead of standing by.
   */
  it("rewrites its owner sidecar when it is deleted or overwritten underneath it", async () => {
    const env = { LOCALAPPDATA: dataDir };
    const child = startRelay({ browserRunId: "run-chrome" });
    await waitForRecordPid(child.pid, "the relay's own record");
    const mine = { relayPid: child.pid, browserRunId: "run-chrome" };
    await vi.waitFor(() => expect(readBridgeOwner(env)).resolves.toEqual(mine));

    // Exactly what a dying relay that lost the race does to the live one's sidecar.
    await rm(bridgeOwnerFilePath(env), { force: true });
    await vi.waitFor(() => expect(readBridgeOwner(env)).resolves.toEqual(mine), { timeout: 3_000, interval: 50 });

    await writeBridgeOwner({ relayPid: 424_242, browserRunId: "run-edge" }, env);
    await vi.waitFor(() => expect(readBridgeOwner(env)).resolves.toEqual(mine), { timeout: 3_000, interval: 50 });
    expect(child.exitCode).toBeNull();
  });

  /**
   * 004/T162 - the design decision's first part: a superseded relay finishes what it started rather
   * than discarding it.
   *
   * The record names the winner about a second after it starts (`RECORD_CHECK_MS`), and an
   * un-drained relay closes every socket the instant it notices - so a wait comfortably past that,
   * before the worker's answer is even written, is what makes this test fail for the right reason
   * without the fix: the socket is long gone by then, not merely racing the answer. With the fix
   * the relay is still waiting on the call it forwarded, and the same write reaches the server.
   */
  it("keeps a call's socket open through a relay handoff until its answer arrives", async () => {
    const sameBrowser = { browserRunId: "run-chrome", identity: CHROME_A };
    const first = startRelay(sameBrowser);
    const server = attach("session-one");
    await server.dial.attached;
    await waitForRecordPid(first.pid, "the first relay's record");

    server.dial.send({ callId: "c-drain", sessionId: "session-one", tool: "tabs_context", args: {} });
    await waitFor(() => calls().length === 1, "the call to reach the first relay");

    const second = startRelay(sameBrowser);
    await waitForRecordPid(second.pid, "the second relay's record");

    // Past the first relay's own one-second poll: an un-drained relay has already closed every
    // socket by now, so a late answer proves the drain rather than a lucky race.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    // The worker's answer, arriving on the *old* relay's own stdin - it is the process Chrome was
    // still talking to when the call was made, and the drain is what keeps its connection to the
    // server open long enough to deliver this.
    first.stdin.write(Buffer.from(encodeFrame({ callId: "c-drain", outcome: "ok", result: ["drained"] })));

    await waitFor(() => server.frames.length > 0, "the answer to reach the server before the relay gives up");
    expect(server.frames).toEqual([{ callId: "c-drain", outcome: "ok", result: ["drained"] }]);
  });

  /**
   * T515 m1 - a superseded relay that is still draining owns nothing any more. A rename arriving on
   * its native port must not rewrite the record with its own pid and port: the winner would then
   * read a live relay of its own run, call itself superseded, and both would leave.
   */
  it("leaves the winner's record untouched when a rename reaches the relay that is draining", async () => {
    const sameBrowser = { browserRunId: "run-chrome", identity: CHROME_A };
    const first = startRelay(sameBrowser);
    const server = attach("session-one");
    await server.dial.attached;
    await waitForBrowserRecordPid(CHROME_A.browserId, first.pid, "the first relay's browser record");
    server.dial.send({ callId: "c-drain", sessionId: "session-one", tool: "tabs_context", args: {} });
    await waitFor(() => callIdsOf(first.pid).includes("c-drain"), "the call to reach the first relay");

    const second = startRelay(sameBrowser);
    const won = await waitForBrowserRecordPid(CHROME_A.browserId, second.pid, "the second relay's browser record");
    // Past the first relay's poll: it has noticed and is draining the call it still holds.
    await sleep(1_500);
    first.stdin.write(encodeFrame({ type: "browser-name", name: "Renamed Too Late" }));
    await sleep(1_500);

    await expect(readBrowserRecordFile(CHROME_A.browserId)).resolves.toEqual(won);
    expect(second.exitCode).toBeNull();
    first.stdin.write(encodeFrame({ callId: "c-drain", outcome: "ok", result: ["drained"] }));
  });

  async function waitForRecordPid(pid: number | undefined, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const record = await readBridgeRecord({ LOCALAPPDATA: dataDir });
      if (record?.relayPid === pid) return;
      await new Promise((tick) => setTimeout(tick, 20));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  function browserRecordPath(browserId: string): string {
    return join(browsersDirectory({ LOCALAPPDATA: dataDir }), `${browserId}.json`);
  }

  async function readBrowserRecordFile(browserId: string): Promise<AgentBrowserRecord | undefined> {
    try {
      const parsed = agentBrowserRecordSchema.safeParse(JSON.parse(await readFile(browserRecordPath(browserId), "utf8")));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async function waitForBrowserRecordPid(
    browserId: string,
    pid: number | undefined,
    label: string,
  ): Promise<AgentBrowserRecord> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const record = await readBrowserRecordFile(browserId);
      if (record?.relayPid === pid && record !== undefined) return record;
      await new Promise((tick) => setTimeout(tick, 20));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  /** The records in the directory - `*.json` exactly, as a server lists them (R-279). */
  async function recordFileNames(): Promise<string[]> {
    try {
      return (await readdir(browsersDirectory({ LOCALAPPDATA: dataDir }))).filter((name) => name.endsWith(".json")).sort();
    } catch {
      return [];
    }
  }

  function framesOf(pid: number | undefined): unknown[] {
    return toChromeByPid.get(pid) ?? [];
  }

  function callIdsOf(pid: number | undefined): string[] {
    return framesOf(pid)
      .map((frame) => (frame as { callId?: unknown }).callId)
      .filter((id): id is string => typeof id === "string");
  }

  function peersOf(pid: number | undefined): Array<{ type: string; others: number; defaultName: string }> {
    return framesOf(pid).filter((frame) => isFrame(frame, "browser-peers")) as Array<{
      type: string;
      others: number;
      defaultName: string;
    }>;
  }

  /** A worker answering `relay-started` a second time on the same port (after a conflict, R-276). */
  function ackAgain(child: ChildProcessWithoutNullStreams, fields: Record<string, unknown>): void {
    child.stdin.write(encodeFrame({ type: "relay-ack", relayPid: child.pid, ...fields }));
  }

  /** An 018 server's dial: straight at one browser's record, greeted with that record's token. */
  async function dialRecord(
    record: AgentBrowserRecord,
    sessionId: string,
  ): Promise<{ channel: FrameChannel; frames: unknown[]; closed: () => boolean }> {
    const frames: unknown[] = [];
    let gone = false;
    const socket = connect({ port: record.port, host: "127.0.0.1" });
    await new Promise<void>((resolveConnect, rejectConnect) => {
      socket.once("connect", () => resolveConnect());
      socket.once("error", rejectConnect);
    });
    let acknowledged: () => void = () => undefined;
    const ack = new Promise<void>((resolveAck) => {
      acknowledged = resolveAck;
    });
    const channel = createFrameChannel(socket, {
      onFrame: (value) => {
        if (isFrame(value, "hello-ack")) acknowledged();
        else frames.push(value);
      },
      onClose: () => {
        gone = true;
      },
    });
    direct.push(channel);
    channel.send({
      type: "hello",
      sessionId,
      agentId: `agent-${sessionId}`,
      displayName: `Agent ${sessionId}`,
      token: record.token,
      protocol: AGENT_LINK_PROTOCOL,
    });
    await within(ack, 5_000, `the hello-ack for ${sessionId}`);
    return { channel, frames, closed: () => gone };
  }

  function calls(): unknown[] {
    return toChrome.filter((frame) => typeof (frame as { callId?: unknown }).callId === "string");
  }

  function writeToRelay(frame: unknown): void {
    relay?.stdin.write(Buffer.from(encodeFrame(frame)));
  }
});

/** The 018 identity fields a worker puts on `relay-ack` (R-268). */
type Identity = { browserId?: string; browserKind?: string; browserName?: string; features?: string[] };

const CHROME_A = {
  browserId: "c0ffee00-0000-4000-8000-00000000000a",
  browserKind: "chrome",
  features: [BROWSER_CHOICE_FEATURE],
} satisfies Identity;
const CHROME_C = { browserId: "c0ffee00-0000-4000-8000-00000000000c", browserKind: "chrome" } satisfies Identity;
const EDGE_B = {
  browserId: "c0ffee00-0000-4000-8000-00000000000b",
  browserKind: "edge",
  browserName: "Work Edge",
} satisfies Identity;
/** The id a copied profile's worker mints after `browser-identity-conflict`. */
const COPY_ID = "c0ffee00-0000-4000-8000-00000000000d";

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function exitOf(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code)));
}

/** A pid that named a process a moment ago and names none now. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolveExit) => child.once("exit", resolveExit));
  if (child.pid === undefined) throw new Error("no pid");
  return child.pid;
}

function isFrame(frame: unknown, type: string): boolean {
  return typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === type;
}

/** Fails with the waiting's own name rather than as a whole-test timeout. */
async function within<Value>(promise: Promise<Value>, ms: number, label: string): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((tick) => setTimeout(tick, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}
