import { describe, expect, it, vi } from "vitest";
import {
  AGENT_RECONNECT_BASE_MS,
  AGENT_RECONNECT_MAX_MS,
  createAgentBridge,
  type AgentPortLike,
} from "../src/service-worker/agent-bridge.js";

/**
 * 003/T013 — the worker's end of the bridge.
 *
 * The bridge is the boundary between a process outside the browser and everything the owner's
 * decisions protect, so what it must be shown to do is: speak only the closed frame schemas, answer
 * exactly once, and grant nothing on its own. Every decision it reaches for - pairing, the tab
 * list - is injected, because none of them is the transport's to make.
 */

type FakePort = AgentPortLike & {
  sent: unknown[];
  emit(message: unknown): void;
  drop(): void;
};

function fakePort(): FakePort {
  const messageListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  return {
    sent: [],
    postMessage(message: unknown) {
      this.sent.push(message);
    },
    disconnect() {
      for (const listener of disconnectListeners) listener();
    },
    onMessage: { addListener: (cb: (message: unknown) => void) => void messageListeners.push(cb) },
    onDisconnect: { addListener: (cb: () => void) => void disconnectListeners.push(cb) },
    emit(message: unknown) {
      for (const listener of messageListeners) listener(message);
    },
    drop() {
      for (const listener of disconnectListeners) listener();
    },
  };
}

function bridgeWith(overrides: Partial<Parameters<typeof createAgentBridge>[0]> = {}) {
  const port = fakePort();
  const scheduleRetry = vi.fn();
  const statuses: string[] = [];
  const bridge = createAgentBridge({
    connectNative: () => port,
    decidePairing: async () => true,
    callTool: async (request) => ({ callId: request.callId, outcome: "ok", result: [] }),
    scheduleRetry,
    onStatusChange: (status) => statuses.push(status),
    ...overrides,
  });
  return { bridge, port, scheduleRetry, statuses };
}

describe("T013 agent bridge", () => {
  it("connects on start and reports the link as connected once the relay answers", () => {
    const { bridge, port, statuses } = bridgeWith();
    bridge.connect();

    // An open Port is not an answer (T099h): Chrome hands one back even for a host it cannot spawn.
    expect(bridge.status()).toBe("disconnected");
    port.emit({ type: "relay-started", relayPid: 4242 });

    expect(bridge.status()).toBe("connected");
    expect(statuses).toEqual(["connected"]);
  });

  it("answers a pairing request with the owner's decision", async () => {
    const decidePairing = vi.fn(async () => true);
    const { bridge, port } = bridgeWith({ decidePairing });
    bridge.connect();

    port.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h1" });
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));

    expect(decidePairing).toHaveBeenCalledWith({
      agentId: "agent-1",
      displayName: "Claude Code",
      origin: "stdio:local",
      // The host's session id travels with the request (003 D-M3-3); the bridge forwards it
      // untouched, because a transport that minted one would be deciding what a session is.
      sessionId: "session-h1",
    });
    // T094a: the answer echoes the session that asked. The relay routes a worker frame by its
    // `callId` or its `sessionId` and drops anything that names neither, so an answer without this
    // field never reaches the server that is waiting on it.
    expect(port.sent[0]).toEqual({
      type: "pair-result",
      agentId: "agent-1",
      sessionId: "session-h1",
      accepted: true,
    });
  });

  it("echoes the asking session even when the decision throws (T094a)", async () => {
    const decidePairing = vi.fn(async () => {
      throw new Error("storage-gone");
    });
    const { bridge, port } = bridgeWith({ decidePairing });
    bridge.connect();

    port.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h2" });
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));

    // The refusal has to be routable for the same reason the acceptance does: a server left waiting
    // on an answer that was dropped is indistinguishable from a bridge that is not there.
    expect(port.sent[0]).toEqual({
      type: "pair-result",
      agentId: "agent-1",
      sessionId: "session-h2",
      accepted: false,
    });
  });

  it("answers a tool call from the injected handler, exactly once", async () => {
    const callTool = vi.fn(async () => ({ callId: "call-1", outcome: "ok" as const, result: [{ tabId: 4, url: "https://a.test/" }] }));
    const { bridge, port } = bridgeWith({ callTool });
    bridge.connect();

    port.emit({ callId: "call-1", sessionId: "session-h1", tool: "tabs_context", args: {} });
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));

    expect(callTool).toHaveBeenCalledWith({ callId: "call-1", sessionId: "session-h1", tool: "tabs_context", args: {} });
    expect(port.sent[0]).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: [{ tabId: 4, url: "https://a.test/" }],
    });
  });

  it("refuses a frame the contracts do not accept, and answers nothing", async () => {
    const callTool = vi.fn(async () => ({ callId: "x", outcome: "ok" as const }));
    const { bridge, port } = bridgeWith({ callTool });
    bridge.connect();

    port.emit({ callId: "call-1", sessionId: "session-h1", tool: "tabs_context", args: {}, extra: "smuggled" });
    port.emit({ callId: "call-2", sessionId: "session-h1", tool: "not_a_tool", args: {} });
    port.emit({ type: "pair-request", agentId: "agent-1" });
    port.emit("a string");
    await Promise.resolve();

    expect(callTool).not.toHaveBeenCalled();
    expect(port.sent).toEqual([]);
  });

  it("keeps the link on a frame the relay no longer sends", () => {
    const diagnostics: string[] = [];
    const { bridge, port, scheduleRetry, statuses } = bridgeWith({
      reportDiagnostic: (code: string) => diagnostics.push(code),
    });
    bridge.connect();
    port.emit({ type: "relay-started", relayPid: 4242 });

    // B6 removed the relay's `bridge-unavailable` path, and acting on it here dropped the port
    // reference *without* disconnecting the port: the re-open then spawned a second relay while
    // Chrome kept the first one alive, which is the split bridge T099c exists to make impossible.
    port.emit({ type: "bridge-unavailable" });

    expect(bridge.status()).toBe("connected");
    expect(statuses).toEqual(["connected"]);
    expect(scheduleRetry).not.toHaveBeenCalled();
    expect(diagnostics).toContain("agent.bridge.frame-unexpected");
  });

  it("schedules a retry when the link drops", () => {
    const { bridge, port, scheduleRetry } = bridgeWith();
    bridge.connect();

    port.drop();

    expect(bridge.status()).toBe("disconnected");
    expect(scheduleRetry).toHaveBeenCalledTimes(1);
  });

  /**
   * 004/T169. A native port can close while the host behind it is still alive, and Chrome says why
   * only inside the `onDisconnect` listener (`chrome.runtime.lastError`). The agent build strips
   * console diagnostics, so the reason has to be handed to the runtime, which keeps it somewhere the
   * attach gate can read; a drop that carries no reason is reported as such, not invented.
   */
  it("hands the runtime Chrome's reason for a drop, read inside the disconnect listener (T169)", () => {
    const reasons: Array<string | undefined> = [];
    const { bridge, port } = bridgeWith({
      disconnectReason: () => "Native host has exited.",
      onDisconnected: (reason) => reasons.push(reason),
    });
    bridge.connect();

    port.drop();

    expect(reasons).toEqual(["Native host has exited."]);
  });

  /**
   * 004/T169. A relay may not publish its record until its owner has answered `relay-started`; a
   * host spawned for a worker instance that will never read a frame then never takes the bridge over.
   */
  it("acknowledges relay-started, before it reports connected, so the relay knows it has a live owner (T169)", () => {
    let sentWhenConnected: unknown[] | undefined;
    const { bridge, port } = bridgeWith({
      onStatusChange: (status) => {
        if (status === "connected") sentWhenConnected = [...port.sent];
      },
    });
    bridge.connect();

    port.emit({ type: "relay-started", relayPid: 4321 });

    expect(port.sent).toContainEqual({ type: "relay-ack", relayPid: 4321 });
    // The ack is on the wire by the time the runtime hears `connected` and starts acting on it.
    expect(sentWhenConnected).toContainEqual({ type: "relay-ack", relayPid: 4321 });
  });

  it("reports an unavailable bridge when the native host cannot be reached at all", () => {
    const { bridge, scheduleRetry } = bridgeWith({ connectNative: () => undefined });
    bridge.connect();

    expect(bridge.status()).toBe("unavailable");
    expect(scheduleRetry).toHaveBeenCalledTimes(1);
  });

  it("tells an open session it is no longer paired the moment the owner unpairs", () => {
    const { bridge, port } = bridgeWith();
    bridge.connect();

    bridge.notifyUnpaired("agent-1", "session-h1");

    // The unpair travels the same shape and needs the same address: it is the one frame the worker
    // originates without having been asked, and the runtime names the session it is meant for.
    expect(port.sent).toEqual([
      { type: "pair-result", agentId: "agent-1", sessionId: "session-h1", accepted: false },
    ]);
  });
});

/**
 * 004/T096a — the fast reconnect (FR-057, evidence G2).
 *
 * The alarm cannot answer FR-057 at all: Chrome's floor for a repeating alarm is one minute, and the
 * bound is ten seconds. The reference's shape is a short re-open cadence with the alarm kept only as
 * the backstop for a worker that has been suspended, so what is checked here is the awake worker's
 * half: the delay it waits before re-opening, that it really re-opens, and that a host which is not
 * there backs off instead of dialling every five seconds for ever.
 *
 * The clock is injected for the same reason every other decision is: a test that waited five seconds
 * would prove the same thing five thousand times slower, and one that waited a minute could not be
 * written at all.
 */
function fakeTimer() {
  const pending = new Map<number, { delayMs: number; run: () => void }>();
  let nextHandle = 0;
  return {
    pending,
    /** Runs the timer set last, as the browser would when its delay elapses. */
    fire(): void {
      const [handle, timer] = [...pending].at(-1) ?? [];
      if (handle === undefined || !timer) throw new Error("no-timer-pending");
      pending.delete(handle);
      timer.run();
    },
    delays(): number[] {
      return [...pending.values()].map((timer) => timer.delayMs);
    },
    timer: {
      set(callback: () => void, delayMs: number): unknown {
        const handle = ++nextHandle;
        pending.set(handle, { delayMs, run: callback });
        return handle;
      },
      clear(handle: unknown): void {
        pending.delete(handle as number);
      },
    },
  };
}

describe("T096a fast reconnect", () => {
  it("re-opens the native port inside the FR-057 bound after a drop, with no alarm firing", () => {
    const clock = fakeTimer();
    const ports: FakePort[] = [];
    const { bridge, scheduleRetry } = bridgeWith({
      connectNative: () => {
        const port = fakePort();
        ports.push(port);
        return port;
      },
      timer: clock.timer,
    });
    bridge.connect();
    expect(ports).toHaveLength(1);

    ports[0]!.drop();

    // The alarm is still armed - a worker Chrome suspends now must still wake - but it is not what
    // restores the link, so the delay the awake worker waits has to fit inside FR-057's ten seconds.
    expect(scheduleRetry).toHaveBeenCalledTimes(1);
    expect(clock.delays()).toEqual([AGENT_RECONNECT_BASE_MS]);
    expect(AGENT_RECONNECT_BASE_MS).toBeLessThanOrEqual(10_000);

    clock.fire();

    expect(ports).toHaveLength(2);
    ports[1]!.emit({ type: "relay-started", relayPid: 4242 });
    expect(bridge.status()).toBe("connected");
  });

  it("backs off to a ceiling while the host stays away, and starts over once it answers", () => {
    const clock = fakeTimer();
    let reachable = false;
    const ports: FakePort[] = [];
    const { bridge } = bridgeWith({
      connectNative: () => {
        if (!reachable) return undefined;
        const port = fakePort();
        ports.push(port);
        return port;
      },
      timer: clock.timer,
    });

    // A host that is not installed answers nothing, run after run. Dialling it every five seconds
    // for ever is what the backoff exists to stop.
    bridge.connect();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      delays.push(clock.delays()[0]!);
      clock.fire();
    }
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, AGENT_RECONNECT_MAX_MS, AGENT_RECONNECT_MAX_MS]);

    // The host came back. The next loss is a fresh one and gets the reference's cadence again.
    reachable = true;
    clock.fire();
    ports.at(-1)!.emit({ type: "relay-started", relayPid: 4242 });
    expect(bridge.status()).toBe("connected");
    expect(clock.delays()).toEqual([]);

    ports.at(-1)!.drop();
    expect(clock.delays()).toEqual([AGENT_RECONNECT_BASE_MS]);
  });

  it("drops a pending re-open when the owner's Connect gets there first", () => {
    const clock = fakeTimer();
    const ports: FakePort[] = [];
    const { bridge } = bridgeWith({
      connectNative: () => {
        const port = fakePort();
        ports.push(port);
        return port;
      },
      timer: clock.timer,
    });
    bridge.connect();
    ports[0]!.drop();
    expect(clock.delays()).toEqual([AGENT_RECONNECT_BASE_MS]);

    bridge.connect();

    // The link is up. A timer left armed would tear down the port it just opened for no reason.
    expect(ports).toHaveLength(2);
    expect(clock.delays()).toEqual([]);
  });
});

/**
 * 004/T099g — a port Chrome has replaced is not a link any more.
 *
 * The disconnect listener has always been guarded on `port !== opened`, because two ports' drops
 * arriving in either order would otherwise tear down the live one. The message listener had no such
 * guard, so a frame from a superseded relay - which is exactly what a supersession leaves behind for
 * a moment - was still answered, and its answer went out on whichever port is current now.
 */
describe("T099g stale ports", () => {
  it("ignores frames from a port that has been replaced", async () => {
    const clock = fakeTimer();
    const ports: FakePort[] = [];
    const callTool = vi.fn(async (request: { callId: string }) => ({
      callId: request.callId,
      outcome: "ok" as const,
      result: [],
    }));
    const onRelayStarted = vi.fn();
    const { bridge } = bridgeWith({
      connectNative: () => {
        const port = fakePort();
        ports.push(port);
        return port;
      },
      callTool,
      onRelayStarted,
      timer: clock.timer,
    });
    bridge.connect();
    ports[0]!.drop();
    clock.fire();
    expect(ports).toHaveLength(2);

    ports[0]!.emit({ callId: "c-stale", sessionId: "session-h1", tool: "tabs_context", args: {} });
    ports[0]!.emit({ type: "relay-started", relayPid: 111 });
    await Promise.resolve();
    await Promise.resolve();

    // Nothing from the old port is acted on: answering it would run a tool for a relay nobody is
    // reading, and the answer would leave on the *current* port, addressed to a call it never made.
    expect(callTool).not.toHaveBeenCalled();
    expect(onRelayStarted).not.toHaveBeenCalled();
    expect(ports[0]!.sent).toEqual([]);
    expect(ports[1]!.sent).toEqual([]);

    // The link that is actually open is untouched by the guard.
    ports[1]!.emit({ callId: "c-live", sessionId: "session-h1", tool: "tabs_context", args: {} });
    await vi.waitFor(() => expect(ports[1]!.sent).toHaveLength(1));
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});

/**
 * 004/T099h — an open Port is not an answer.
 *
 * `chrome.runtime.connectNative` returns a Port even for a host it cannot spawn and reports the
 * failure asynchronously through `onDisconnect`. Treating the return as success reset the backoff on
 * every failed spawn, so the ceiling never engaged and Chrome respawned the launcher every five
 * seconds for as long as the browser was open - while the panel flashed "connected" at the same
 * cadence. The relay's `relay-started` is the first evidence the host is really there.
 */
describe("T099h the host has answered only when it says so", () => {
  it("keeps backing off to the ceiling while every opened port dies unanswered", () => {
    const clock = fakeTimer();
    const ports: FakePort[] = [];
    const { bridge, statuses } = bridgeWith({
      connectNative: () => {
        const port = fakePort();
        ports.push(port);
        return port;
      },
      timer: clock.timer,
    });

    bridge.connect();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      // Chrome's asynchronous "could not spawn it after all".
      ports.at(-1)!.drop();
      delays.push(clock.delays()[0]!);
      clock.fire();
    }

    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, AGENT_RECONNECT_MAX_MS, AGENT_RECONNECT_MAX_MS]);
    // And the owner is never told the link is up: a "connected" every five seconds is what made the
    // panel unreadable, and each one clears the retry alarm and mints a placeholder session.
    expect(statuses).toEqual([]);
    expect(bridge.status()).toBe("disconnected");
  });

  it("hands the runtime the record path the relay named, when it named one (006 FR-082)", () => {
    const onRelayStarted = vi.fn();
    const { port, bridge } = bridgeWith({ onRelayStarted });
    bridge.connect();

    port.emit({ type: "relay-started", relayPid: 4242, recordPath: "C:\\data\\hallpass\\bridge.json" });

    expect(onRelayStarted).toHaveBeenCalledWith(4242, "C:\\data\\hallpass\\bridge.json");
  });

  it("reports connected and starts the cadence over on the relay's first frame", () => {
    const clock = fakeTimer();
    const ports: FakePort[] = [];
    const onRelayStarted = vi.fn();
    const { bridge, statuses } = bridgeWith({
      connectNative: () => {
        const port = fakePort();
        ports.push(port);
        return port;
      },
      onRelayStarted,
      timer: clock.timer,
    });

    bridge.connect();
    ports[0]!.drop();
    clock.fire();
    ports[1]!.drop();
    expect(clock.delays()).toEqual([10_000]);
    clock.fire();

    ports[2]!.emit({ type: "relay-started", relayPid: 4242 });

    expect(statuses).toEqual(["connected"]);
    expect(bridge.status()).toBe("connected");
    expect(onRelayStarted).toHaveBeenCalledWith(4242, undefined);

    // The next loss is a fresh one: it gets the reference's cadence, not the delay the outage grew to.
    ports[2]!.drop();
    expect(clock.delays()).toEqual([AGENT_RECONNECT_BASE_MS]);
  });
});
