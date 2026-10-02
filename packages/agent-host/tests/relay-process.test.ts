import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bridgeFilePath,
  dialRelay,
  encodeFrame,
  FrameDecoder,
  readBridgeRecord,
  type RelayDial,
} from "../src/index.js";
import { readBridgeOwner } from "../src/relay-ownership.js";

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
    options: { ack?: boolean; ackBoundMs?: number; browserRunId?: string } = {},
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
    // It also names the record's path (006 FR-082): the worker cannot see the host data directory
    // and this is the only way the not-connected page ever learns where the file is.
    await waitFor(() => toChrome.length > 0, "the relay-started frame");
    expect(toChrome[0]).toEqual({
      type: "relay-started",
      relayPid: child.pid,
      recordPath: bridgeFilePath({ LOCALAPPDATA: dataDir }),
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
  });

  it("exits when another relay takes the record over, leaving one owner", async () => {
    const first = startRelay();
    const server = attach("session-one");
    await server.dial.attached;
    await waitForRecordPid(first.pid, "the first relay's record");

    // Started while the first is still alive - the split bridge B13 measured, where `bridge.json`
    // named one relay and the worker's native port belonged to the other.
    const exited = new Promise<number | null>((resolve) => first.once("exit", (code) => resolve(code)));
    const second = startRelay();
    await waitForRecordPid(second.pid, "the second relay's record");

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
   * Two browsers (2026-10-02). Chrome and Edge each run a relay; each used to take the record on its
   * own ack, so the two evicted each other every ~7 s and neither browser worked. The second
   * browser's relay now stands by - writes nothing, tells its worker, leaves - while the first keeps
   * serving; and once the first browser closes, the second browser's next relay takes over.
   */
  it("stands by while another browser's relay serves, and takes over once it is gone", async () => {
    const env = { LOCALAPPDATA: dataDir };
    const first = startRelay({ browserRunId: "run-chrome" });
    const server = attach("session-one");
    await server.dial.attached;
    await waitForRecordPid(first.pid, "the first browser's record");
    await vi.waitFor(() => expect(readBridgeOwner(env)).resolves.toEqual({ relayPid: first.pid, browserRunId: "run-chrome" }));

    const second = startRelay({ browserRunId: "run-edge" });
    const secondExited = new Promise<number | null>((resolve) => second.once("exit", (code) => resolve(code)));
    await expect(within(secondExited, 8_000, "the standing-by relay to leave")).resolves.toBe(0);
    expect(toChromeByPid.get(second.pid)?.filter((frame) => isFrame(frame, "relay-standby"))).toEqual([
      { type: "relay-standby", servingRelayPid: first.pid },
    ]);

    // Past the first relay's one-second record poll: it would have noticed a takeover by now.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await expect(readBridgeRecord(env)).resolves.toMatchObject({ relayPid: first.pid });
    await expect(readBridgeOwner(env)).resolves.toEqual({ relayPid: first.pid, browserRunId: "run-chrome" });
    expect(first.exitCode).toBeNull();
    expect(server.detached()).toBe(false);

    // The first browser closes: its relay retracts the record and the sidecar with it ...
    const firstExited = new Promise<number | null>((resolve) => first.once("exit", (code) => resolve(code)));
    first.stdin.end();
    await expect(within(firstExited, 8_000, "the first browser's relay to exit")).resolves.toBe(0);
    await expect(readBridgeOwner(env)).resolves.toBeUndefined();

    // ... and the second browser's next relay - its worker's ordinary reconnect - takes over.
    const third = startRelay({ browserRunId: "run-edge" });
    await waitForRecordPid(third.pid, "the second browser's relay to take over");
    // The sidecar follows the record by one write.
    await vi.waitFor(() => expect(readBridgeOwner(env)).resolves.toEqual({ relayPid: third.pid, browserRunId: "run-edge" }));
    await waitFor(() => {
      server.dial.send({ callId: "c-failover", sessionId: "session-one", tool: "tabs_context", args: {} });
      return (toChromeByPid.get(third.pid) ?? []).some(
        (frame) => (frame as { callId?: unknown }).callId === "c-failover",
      );
    }, "the server's call to reach the relay that took over");
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
    const first = startRelay();
    const server = attach("session-one");
    await server.dial.attached;
    await waitForRecordPid(first.pid, "the first relay's record");

    server.dial.send({ callId: "c-drain", sessionId: "session-one", tool: "tabs_context", args: {} });
    await waitFor(() => calls().length === 1, "the call to reach the first relay");

    const second = startRelay();
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

  async function waitForRecordPid(pid: number | undefined, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const record = await readBridgeRecord({ LOCALAPPDATA: dataDir });
      if (record?.relayPid === pid) return;
      await new Promise((tick) => setTimeout(tick, 20));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  function calls(): unknown[] {
    return toChrome.filter((frame) => typeof (frame as { callId?: unknown }).callId === "string");
  }

  function writeToRelay(frame: unknown): void {
    relay?.stdin.write(Buffer.from(encodeFrame(frame)));
  }
});

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
