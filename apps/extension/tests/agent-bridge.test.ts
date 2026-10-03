import { describe, expect, it, vi } from "vitest";
import { agentControlFrameSchema, agentLinkFrameSchema, BROWSER_CHOICE_FEATURE, PAIRING_DECLINED_MARKER } from "@hallpass/contracts";
import {
  AGENT_ACK_IDENTITY_BOUND_MS,
  AGENT_ACK_RUN_ID_BOUND_MS,
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
    decidePairing: async () => "accepted" as const,
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
    const decidePairing = vi.fn(async () => "accepted" as const);
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

  /**
   * 013/S4 (R-184, FR-168) — the pairing answer is also where the worker names its browser run.
   *
   * It rides this frame because this is the one the worker sends on every (re)established link, and
   * because the host awaits it before releasing a call: the run is known by the time anything reads
   * the screenshot cache. The bridge still decides nothing about it - it asks the runtime for the
   * id, exactly as it asks for the pairing decision.
   */
  it("names its browser run on the pairing answer (R-184)", async () => {
    const { bridge, port } = bridgeWith({ browserRunId: async () => "run-1234" });
    bridge.connect();

    port.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h7" });
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));

    expect(port.sent[0]).toEqual({
      type: "pair-result",
      agentId: "agent-1",
      sessionId: "session-h7",
      accepted: true,
      browserRunId: "run-1234",
    });
    // On contract, so an older relay forwards it and the host parses it rather than rejecting the
    // frame - which would lose the pairing answer entirely.
    expect(agentControlFrameSchema.safeParse(port.sent[0]).success).toBe(true);
  });

  it("still answers the pairing when its browser run cannot be read", async () => {
    const { bridge, port } = bridgeWith({
      browserRunId: async () => {
        throw new Error("storage-gone");
      },
    });
    bridge.connect();

    port.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h8" });
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));

    // The field is left off rather than guessed: the host reads its absence as "cannot tell" and
    // keeps its own fall-back. A pairing answer withheld over it would strand the agent's call.
    expect(port.sent[0]).toEqual({
      type: "pair-result",
      agentId: "agent-1",
      sessionId: "session-h8",
      accepted: true,
    });
  });

  /**
   * 003 FR-032a - the owner's decline answers one request, and the frame has to say so.
   *
   * The mark rides in `features` because that is the one field of this strict frame a 0.6.0 host
   * already accepts any member of: a new key would make that host drop the whole answer, and with it
   * the unpair FR-032 says takes effect at once. The host reads an unmarked refusal as an unpair.
   */
  it("marks the owner's decline, beside what the worker can be asked (FR-032a)", async () => {
    const { bridge, port } = bridgeWith({ decidePairing: async () => "declined" as const });
    bridge.connect();

    port.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h3" });
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));
    expect(port.sent[0]).toEqual({
      type: "pair-result",
      agentId: "agent-1",
      sessionId: "session-h3",
      accepted: false,
      features: [PAIRING_DECLINED_MARKER],
    });
    expect(agentControlFrameSchema.safeParse(port.sent[0]).success).toBe(true);

    const withUpload = bridgeWith({ decidePairing: async () => "declined" as const, onUploadConsentRequest: () => undefined });
    withUpload.bridge.connect();
    withUpload.port.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h4" });
    await vi.waitFor(() => expect(withUpload.port.sent).toHaveLength(1));
    expect(withUpload.port.sent[0]).toMatchObject({ accepted: false, features: ["upload-consent", PAIRING_DECLINED_MARKER] });
  });

  it("leaves an unpair that settled a waiting request unmarked (FR-032a)", async () => {
    const { bridge, port } = bridgeWith({ decidePairing: async () => "unpaired" as const });
    bridge.connect();

    port.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h5" });
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));

    expect(port.sent[0]).toEqual({ type: "pair-result", agentId: "agent-1", sessionId: "session-h5", accepted: false });
  });

  /**
   * Neither of these is an answer of the owner's, so neither is sent as one (FR-032a).
   *
   * An unmarked refusal would now tell the agent the owner unpaired it and to reconnect; a marked one
   * would tell it the owner declined. Silence leaves the host's own pairing bound to end the call as
   * nobody having answered, and its next call asks again - which is also what an abandoned request
   * already meant, since its link is gone and nothing sent here could reach the host anyway.
   */
  it("sends no answer when the decision fails or the request was abandoned", async () => {
    const diagnostics: string[] = [];
    const failing = bridgeWith({
      decidePairing: async () => {
        throw new Error("storage-gone");
      },
      reportDiagnostic: (code) => diagnostics.push(code),
    });
    failing.bridge.connect();
    failing.port.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h2" });
    await vi.waitFor(() => expect(diagnostics).toContain("agent.bridge.pairing-failed"));

    const abandoned = bridgeWith({
      decidePairing: async () => "abandoned" as const,
      reportDiagnostic: (code) => diagnostics.push(code),
    });
    abandoned.bridge.connect();
    abandoned.port.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h6" });
    await vi.waitFor(() => expect(diagnostics).toContain("agent.bridge.pairing-abandoned"));

    expect(failing.port.sent).toEqual([]);
    expect(abandoned.port.sent).toEqual([]);
  });

  /**
   * 015/T421 (FR-218, contracts/pairing-withdraw.md) — the answer names the exchange it answers.
   *
   * The host mints one id per pairing exchange and ignores an answer naming one it already
   * withdrew, so the worker echoes the id of the request it is answering - and, facing a 0.7.0 host
   * that sent none, sends none, which is the frame that host has always parsed.
   */
  it("echoes the request's id on its answer, and sends none when none was given (FR-218)", async () => {
    const decidePairing = vi.fn(async () => "accepted" as const);
    const { bridge, port } = bridgeWith({ decidePairing });
    bridge.connect();

    port.emit({
      type: "pair-request",
      agentId: "agent-1",
      displayName: "Claude Code",
      origin: "stdio:local",
      sessionId: "session-h1",
      requestId: "req-1",
    });
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));
    expect(port.sent[0]).toEqual({
      type: "pair-result",
      agentId: "agent-1",
      sessionId: "session-h1",
      accepted: true,
      requestId: "req-1",
    });
    expect(agentControlFrameSchema.safeParse(port.sent[0]).success).toBe(true);
    // The controller keeps it beside the waiting session, so a withdrawal can name the same one.
    expect(decidePairing).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "session-h1", requestId: "req-1" }));

    port.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h2" });
    await vi.waitFor(() => expect(port.sent).toHaveLength(2));
    expect(port.sent[1]).toEqual({ type: "pair-result", agentId: "agent-1", sessionId: "session-h2", accepted: true });
  });

  /**
   * 015 FR-219 (S4 version-skew fix) - the worker says it can take a withdrawal before the host
   * names an exchange to it.
   *
   * A 0.7.0 worker parses `pair-request` strictly, so a host that put `requestId` on it for that
   * worker got no card at all. The host therefore sends the id only to a worker that advertised
   * `pair-withdraw`, and this is the advertisement - derived from the handler, as `upload-consent`
   * is, so it cannot outlive the thing it advertises.
   */
  it("advertises pair-withdraw beside what else it can be asked, only with a handler for it (FR-219)", async () => {
    const withWithdraw = bridgeWith({ onPairWithdraw: () => undefined, onUploadConsentRequest: () => undefined });
    withWithdraw.bridge.connect();
    withWithdraw.port.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h1" });
    await vi.waitFor(() => expect(withWithdraw.port.sent).toHaveLength(1));
    expect(withWithdraw.port.sent[0]).toMatchObject({ accepted: true, features: ["upload-consent", "pair-withdraw"] });
    expect(agentControlFrameSchema.safeParse(withWithdraw.port.sent[0]).success).toBe(true);

    const without = bridgeWith();
    without.bridge.connect();
    without.port.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h2" });
    await vi.waitFor(() => expect(without.port.sent).toHaveLength(1));
    expect(without.port.sent[0]).not.toHaveProperty("features");
  });

  it("hands a host's withdrawal to the runtime and answers nothing (FR-216, FR-217)", async () => {
    const onPairWithdraw = vi.fn();
    const diagnostics: string[] = [];
    const { bridge, port } = bridgeWith({ onPairWithdraw, reportDiagnostic: (code) => diagnostics.push(code) });
    bridge.connect();

    port.emit({ type: "pair-withdraw", agentId: "agent-1", sessionId: "session-h1", requestId: "req-1" });
    port.emit({ type: "pair-withdraw", agentId: "agent-1", sessionId: "session-h2" });
    await Promise.resolve();

    expect(onPairWithdraw.mock.calls).toEqual([
      [{ agentId: "agent-1", sessionId: "session-h1", requestId: "req-1" }],
      [{ agentId: "agent-1", sessionId: "session-h2" }],
    ]);
    expect(port.sent).toEqual([]);
    expect(diagnostics).not.toContain("agent.bridge.frame-unexpected");
  });

  /**
   * 015/T421 (FR-219) — the additive-frame rule the withdrawal relies on, seen from the decoder.
   *
   * A 0.7.0 worker meets `pair-withdraw` as a type it has never heard of. That worker is not this
   * code, but the path it takes is: a frame outside the closed unions is dropped, answered with
   * nothing, and costs the link nothing - so the next frame is still served.
   */
  it("drops a frame type it does not know without error, and keeps serving the link (FR-219)", async () => {
    const diagnostics: string[] = [];
    const { bridge, port } = bridgeWith({ reportDiagnostic: (code) => diagnostics.push(code) });
    bridge.connect();
    port.emit({ type: "relay-started", relayPid: 4242 });
    port.sent.length = 0;

    expect(() => port.emit({ type: "pair-rescind", agentId: "agent-1", sessionId: "session-h1" })).not.toThrow();
    await Promise.resolve();
    expect(port.sent).toEqual([]);
    expect(diagnostics).toContain("agent.bridge.frame-rejected");
    expect(bridge.status()).toBe("connected");

    port.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h1" });
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));
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

  /**
   * Two browsers (2026-10-02). The ack names this browser run, so a relay can tell its own browser's
   * previous relay - which it replaces - from another browser's, which it must leave serving.
   */
  it("names its browser run on the ack, and still reports connected after it (two browsers)", async () => {
    let sentWhenConnected: unknown[] | undefined;
    const { bridge, port } = bridgeWith({
      browserRunId: async () => "run-chrome",
      onStatusChange: (status) => {
        if (status === "connected") sentWhenConnected = [...port.sent];
      },
    });
    bridge.connect();

    port.emit({ type: "relay-started", relayPid: 4321 });

    await vi.waitFor(() => expect(bridge.status()).toBe("connected"));
    expect(port.sent).toContainEqual({ type: "relay-ack", relayPid: 4321, browserRunId: "run-chrome" });
    expect(sentWhenConnected).toContainEqual({ type: "relay-ack", relayPid: 4321, browserRunId: "run-chrome" });
    expect(agentLinkFrameSchema.safeParse(port.sent[0]).success).toBe(true);
  });

  it("still acks, without the run, when its browser run cannot be read or takes too long", async () => {
    const failing = bridgeWith({
      browserRunId: async () => {
        throw new Error("storage-unavailable");
      },
    });
    failing.bridge.connect();
    failing.port.emit({ type: "relay-started", relayPid: 4321 });
    await vi.waitFor(() => expect(failing.port.sent).toContainEqual({ type: "relay-ack", relayPid: 4321 }));

    vi.useFakeTimers();
    try {
      const hanging = bridgeWith({ browserRunId: () => new Promise<string | undefined>(() => undefined) });
      hanging.bridge.connect();
      hanging.port.emit({ type: "relay-started", relayPid: 4322 });
      // The relay waits 10 s for an ack before it leaves; the id is never worth that.
      await vi.advanceTimersByTimeAsync(AGENT_ACK_RUN_ID_BOUND_MS);
      expect(hanging.port.sent).toContainEqual({ type: "relay-ack", relayPid: 4322 });
      expect(hanging.bridge.status()).toBe("connected");
    } finally {
      vi.useRealTimers();
    }
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

  /**
   * 011/T294 — the "still waiting" tick on the wire.
   *
   * It is a link frame, not a control frame: the relay routes it by `sessionId` like every other
   * one and the bridge adds nothing to it. The whole of the claim is that what the runtime composed
   * is what the host reads - the router's arithmetic is done on these numbers, so a bridge that
   * rewrote any of them would re-arm a backstop against a bound nobody chose.
   */
  it("sends a prompt-waiting tick through the port exactly as it was given", () => {
    const { bridge, port } = bridgeWith();
    bridge.connect();
    const frame = {
      type: "prompt-waiting" as const,
      sessionId: "session-h1",
      callId: "call-1",
      kind: "ask" as const,
      panelConnected: false,
      waitedMs: 5_000,
      boundMs: 120_000,
    };

    bridge.sendWaiting(frame);

    expect(port.sent).toEqual([frame]);
    expect(agentLinkFrameSchema.safeParse(port.sent[0]).success).toBe(true);
  });

  it("drops a tick raised while no host is there, without throwing at the caller", () => {
    const { bridge } = bridgeWith({ connectNative: () => undefined });
    bridge.connect();

    // A question can outlive the link that raised it (the runtime cancels it a moment later); the
    // tick that lands in that gap is lost, which is the truth, and is not an error for the timer.
    expect(() =>
      bridge.sendWaiting({
        type: "prompt-waiting",
        sessionId: "session-h1",
        kind: "pairing",
        panelConnected: false,
        waitedMs: 5_000,
        boundMs: 120_000,
      }),
    ).not.toThrow();
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

/**
 * 018 R-274 — stand-by is retired. A 0.10.x relay may still send `relay-standby` to this worker
 * before it leaves; the frame is dropped as one this worker does not act on, the status is not
 * moved by it, and the port closing afterwards is an ordinary lost link on the ordinary cadence.
 */
describe("018 relay-standby is ignored", () => {
  it("drops a relay-standby from a 0.10.x relay without changing the status or the backoff", () => {
    const clock = fakeTimer();
    const ports: FakePort[] = [];
    const diagnostics: string[] = [];
    const { bridge, statuses } = bridgeWith({
      connectNative: () => {
        const port = fakePort();
        ports.push(port);
        return port;
      },
      timer: clock.timer,
      reportDiagnostic: (code) => diagnostics.push(code),
    });
    bridge.connect();
    ports[0]!.emit({ type: "relay-started", relayPid: 4242 });
    ports[0]!.emit({ type: "relay-standby", servingRelayPid: 1111 });

    expect(bridge.status()).toBe("connected");
    expect(statuses).toEqual(["connected"]);
    expect(diagnostics).not.toContain("agent.bridge.relay-standby");
    expect(clock.delays()).toEqual([]);

    ports[0]!.drop();
    expect(bridge.status()).toBe("disconnected");
    expect(statuses).toEqual(["connected", "disconnected"]);
    expect(clock.delays()).toEqual([AGENT_RECONNECT_BASE_MS]);
  });
});

/**
 * 016/T435 — the host's `session-label` frame (FR-226, R-204).
 *
 * The bridge only decodes it and passes it on; whether the session is one the worker knows is the
 * runtime's question. A malformed label is dropped as any unknown frame is, and nothing about the
 * label reaches a diagnostic line - it is remote input and names a folder on the agent's machine.
 */
describe("016 session-label frame", () => {
  it("passes a session-label frame to onSessionLabel", () => {
    const onSessionLabel = vi.fn();
    const diagnostics: string[] = [];
    const { bridge, port } = bridgeWith({ onSessionLabel, reportDiagnostic: (code) => diagnostics.push(code) });
    bridge.connect();

    port.emit({ type: "session-label", sessionId: "session-1", label: "shop-frontend" });

    expect(onSessionLabel).toHaveBeenCalledWith({ sessionId: "session-1", label: "shop-frontend" });
    expect(diagnostics.join(" ")).not.toContain("shop-frontend");
    expect(port.sent).toEqual([]);
  });

  it("drops a session-label frame that does not parse", () => {
    const onSessionLabel = vi.fn();
    const diagnostics: string[] = [];
    const { bridge, port } = bridgeWith({ onSessionLabel, reportDiagnostic: (code) => diagnostics.push(code) });
    bridge.connect();

    port.emit({ type: "session-label", sessionId: "session-1", label: "x".repeat(65) });
    port.emit({ type: "session-label", sessionId: "session-1", label: "a", path: "C:\a" });

    expect(onSessionLabel).not.toHaveBeenCalled();
    expect(diagnostics).toEqual(["agent.bridge.frame-rejected", "agent.bridge.frame-rejected"]);
  });
});

/**
 * 018/T499, T500 — the ack says who this browser is (R-268, R-276, R-279).
 *
 * The identity is a `chrome.storage.local` read, and it is worth the relay's whole ack bound rather
 * than the run id's 1 s: without it a new worker would be published as a run-scoped legacy entry
 * beside the browser's proper record. A conflict (a copied profile) is answered by minting a new
 * identity and reconnecting, so the next relay hears the new one on its ack.
 */
describe("018 browser identity on the link", () => {
  type Identity = { browserId: string; kind: "chrome" | "edge"; name?: string };
  const IDENTITY: Identity = { browserId: "aaaaaaaa-1111", kind: "edge", name: "Work" };

  function identityDeps(read: () => Promise<Identity | undefined>) {
    return { read, remint: vi.fn(async () => IDENTITY) };
  }

  it("carries the identity on the ack", async () => {
    const { bridge, port } = bridgeWith({ browserRunId: async () => "run-1", browserIdentity: identityDeps(async () => IDENTITY) });
    bridge.connect();
    port.emit({ type: "relay-started", relayPid: 4321 });

    await vi.waitFor(() => expect(bridge.status()).toBe("connected"));
    const ack = port.sent[0];
    expect(ack).toEqual({
      type: "relay-ack",
      relayPid: 4321,
      browserRunId: "run-1",
      browserId: "aaaaaaaa-1111",
      browserKind: "edge",
      browserName: "Work",
    });
    expect(agentLinkFrameSchema.safeParse(ack).success).toBe(true);
  });

  it("waits past the run id's bound for a slow identity read, and acks with it inside its own bound", async () => {
    vi.useFakeTimers();
    try {
      const slow = bridgeWith({
        browserIdentity: identityDeps(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ browserId: "bbbbbbbb-2222", kind: "chrome" }), AGENT_ACK_IDENTITY_BOUND_MS - 500),
            ),
        ),
      });
      slow.bridge.connect();
      slow.port.emit({ type: "relay-started", relayPid: 4322 });
      await vi.advanceTimersByTimeAsync(AGENT_ACK_RUN_ID_BOUND_MS);
      expect(slow.port.sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(AGENT_ACK_IDENTITY_BOUND_MS - 500 - AGENT_ACK_RUN_ID_BOUND_MS);
      expect(slow.port.sent).toEqual([{ type: "relay-ack", relayPid: 4322, browserId: "bbbbbbbb-2222", browserKind: "chrome" }]);
      // Inside the relay's own 10 s, with room for the frame to arrive.
      expect(AGENT_ACK_IDENTITY_BOUND_MS).toBeGreaterThan(AGENT_ACK_RUN_ID_BOUND_MS);
      expect(AGENT_ACK_IDENTITY_BOUND_MS).toBeLessThan(10_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never acks without its identity when the store does not answer: it drops the link and backs off (R-279, T513)", async () => {
    // A worker with an identity store that acked without it was published as a run-scoped legacy
    // browser beside its proper record, so the directory listed two browsers. Not answered is "not
    // yet published": no ack, the link goes, and the retry backs off while the store stays silent.
    vi.useFakeTimers();
    try {
      const clock = fakeTimer();
      const ports: Array<FakePort & { disconnect: ReturnType<typeof vi.fn> }> = [];
      const diagnostics: string[] = [];
      const { bridge, statuses } = bridgeWith({
        connectNative: () => {
          const port = fakePort();
          const disconnect = vi.fn(port.disconnect);
          const spied = Object.assign(port, { disconnect });
          ports.push(spied);
          return spied;
        },
        timer: clock.timer,
        reportDiagnostic: (code) => diagnostics.push(code),
        browserRunId: async () => "run-1",
        browserIdentity: identityDeps(() => new Promise(() => undefined)),
      });
      bridge.connect();

      const delays: number[] = [];
      for (let cycle = 0; cycle < 3; cycle += 1) {
        const port = ports.at(-1)!;
        port.emit({ type: "relay-started", relayPid: 6000 + cycle });
        await vi.advanceTimersByTimeAsync(AGENT_ACK_IDENTITY_BOUND_MS - 1);
        expect(port.disconnect).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(port.sent).toEqual([]);
        expect(port.disconnect).toHaveBeenCalledTimes(1);
        expect(clock.delays()).toHaveLength(1);
        expect(ports).toHaveLength(cycle + 1);
        delays.push(clock.delays()[0]!);
        clock.fire();
      }

      expect(delays).toEqual([AGENT_RECONNECT_BASE_MS, AGENT_RECONNECT_BASE_MS * 2, AGENT_RECONNECT_BASE_MS * 4]);
      expect(diagnostics.filter((code) => code === "agent.bridge.identity-unread")).toHaveLength(3);
      expect(statuses).not.toContain("connected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never acks without its identity when the store's read fails", async () => {
    const diagnostics: string[] = [];
    const { bridge, port } = bridgeWith({
      reportDiagnostic: (code) => diagnostics.push(code),
      browserIdentity: identityDeps(async () => {
        throw new Error("storage-failed");
      }),
    });
    bridge.connect();
    port.emit({ type: "relay-started", relayPid: 4324 });

    await vi.waitFor(() => expect(diagnostics).toContain("agent.bridge.identity-unread"));
    expect(port.sent).toEqual([]);
    expect(bridge.status()).toBe("disconnected");
  });

  it("acks without an identity when there is no identity store to read (storage unavailable)", async () => {
    // `localBrowserIdentity` over no storage area answers `undefined` at once: nothing to wait for,
    // and nothing that could be published beside it.
    const { bridge, port } = bridgeWith({ browserIdentity: identityDeps(async () => undefined) });
    bridge.connect();
    port.emit({ type: "relay-started", relayPid: 4325 });

    await vi.waitFor(() => expect(port.sent).toEqual([{ type: "relay-ack", relayPid: 4325 }]));
    expect(bridge.status()).toBe("connected");
  });

  it("re-mints on a conflict and reconnects, so the next relay hears the new identity", async () => {
    const ports: FakePort[] = [];
    let current: Identity = IDENTITY;
    const remint = vi.fn(async () => {
      current = { browserId: "cccccccc-3333", kind: "edge", name: "Work 2" };
      return current;
    });
    const bridge = createAgentBridge({
      connectNative: () => {
        const port = fakePort();
        ports.push(port);
        return port;
      },
      decidePairing: async () => "accepted" as const,
      callTool: async (request) => ({ callId: request.callId, outcome: "ok", result: [] }),
      scheduleRetry: vi.fn(),
      browserIdentity: { read: async () => current, remint },
    });
    bridge.connect();
    ports[0]!.emit({ type: "relay-started", relayPid: 4242 });
    await vi.waitFor(() => expect(ports[0]!.sent).toHaveLength(1));

    ports[0]!.emit({ type: "browser-identity-conflict" });
    await vi.waitFor(() => expect(ports).toHaveLength(2));
    expect(remint).toHaveBeenCalledTimes(1);

    ports[1]!.emit({ type: "relay-started", relayPid: 4243 });
    await vi.waitFor(() =>
      expect(ports[1]!.sent).toEqual([
        { type: "relay-ack", relayPid: 4243, browserId: "cccccccc-3333", browserKind: "edge", browserName: "Work 2" },
      ]),
    );
  });

  it("backs off instead of re-dialling at once when the re-mint fails, and keeps backing off while the conflict persists", async () => {
    // T515 M1: storage that keeps failing must not turn the conflict into a relay respawn loop.
    const clock = fakeTimer();
    const ports: FakePort[] = [];
    const remint = vi.fn(async (): Promise<Identity> => {
      throw new Error("storage-unavailable");
    });
    const { bridge, statuses } = bridgeWith({
      connectNative: () => {
        const port = fakePort();
        ports.push(port);
        return port;
      },
      timer: clock.timer,
      browserIdentity: { read: async () => IDENTITY, remint },
    });
    bridge.connect();

    const delays: number[] = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const port = ports.at(-1)!;
      port.emit({ type: "relay-started", relayPid: 5000 + cycle });
      await vi.waitFor(() => expect(port.sent).toHaveLength(1));
      port.emit({ type: "browser-identity-conflict" });
      await vi.waitFor(() => expect(clock.delays()).toHaveLength(1));
      // No immediate re-open: the next link waits for the armed timer.
      expect(ports).toHaveLength(cycle + 1);
      delays.push(clock.delays()[0]!);
      clock.fire();
    }

    expect(remint).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([AGENT_RECONNECT_BASE_MS, AGENT_RECONNECT_BASE_MS * 2, AGENT_RECONNECT_BASE_MS * 4]);
    // The owner sees the link down between cycles, not a "connected" that is about to end.
    expect(statuses).toEqual(["connected", "disconnected", "connected", "disconnected", "connected", "disconnected"]);
  });

  it("hands the relay's peers to the runtime and sends the owner's name to the relay", () => {
    const onBrowserPeers = vi.fn();
    const { bridge, port } = bridgeWith({ onBrowserPeers });
    bridge.connect();
    port.emit({ type: "browser-peers", others: 2, defaultName: "Chrome 2" });
    expect(onBrowserPeers).toHaveBeenCalledWith({ others: 2, defaultName: "Chrome 2" });

    bridge.sendBrowserName("Lab box");
    expect(port.sent).toEqual([{ type: "browser-name", name: "Lab box" }]);
  });
});

/**
 * 018/T509 — the in-browser choice on the link (FR-274, R-273, R-279).
 *
 * The ack says this worker can show the "Use this browser?" card, derived from the handler that
 * shows it, so the relay's record never claims a card nobody raises. The three choice frames pass
 * through as parsed, and a choose greeting keeps its intent so the runtime can tell it apart.
 */
describe("018 browser choice on the link", () => {
  it("advertises browser-choice on the ack when it can raise the card, and not otherwise", async () => {
    const able = bridgeWith({ onBrowserChoiceRequest: vi.fn() });
    able.bridge.connect();
    able.port.emit({ type: "relay-started", relayPid: 4321 });
    await vi.waitFor(() => expect(able.bridge.status()).toBe("connected"));
    expect(able.port.sent[0]).toEqual({ type: "relay-ack", relayPid: 4321, features: [BROWSER_CHOICE_FEATURE] });
    expect(agentLinkFrameSchema.safeParse(able.port.sent[0]).success).toBe(true);

    const unable = bridgeWith();
    unable.bridge.connect();
    unable.port.emit({ type: "relay-started", relayPid: 4322 });
    await vi.waitFor(() => expect(unable.port.sent).toEqual([{ type: "relay-ack", relayPid: 4322 }]));
  });

  it("passes the choose intent, the request and the withdrawal on, and sends the result", () => {
    const onSessionAnnounced = vi.fn();
    const onBrowserChoiceRequest = vi.fn();
    const onBrowserChoiceWithdraw = vi.fn();
    const { bridge, port } = bridgeWith({ onSessionAnnounced, onBrowserChoiceRequest, onBrowserChoiceWithdraw });
    bridge.connect();

    port.emit({ type: "hello", sessionId: "s1~choose", agentId: "agent-1", displayName: "Claude Code", intent: "choose" });
    expect(onSessionAnnounced).toHaveBeenCalledWith({
      sessionId: "s1~choose",
      agentId: "agent-1",
      displayName: "Claude Code",
      intent: "choose",
    });
    port.emit({ type: "browser-choice-request", sessionId: "s1~choose", requestId: "req-1", agentName: "Claude Code", boundMs: 120_000 });
    expect(onBrowserChoiceRequest).toHaveBeenCalledWith({
      sessionId: "s1~choose",
      requestId: "req-1",
      agentName: "Claude Code",
      boundMs: 120_000,
    });
    port.emit({ type: "browser-choice-withdraw", sessionId: "s1~choose", requestId: "req-1" });
    expect(onBrowserChoiceWithdraw).toHaveBeenCalledWith({ sessionId: "s1~choose", requestId: "req-1" });

    bridge.sendBrowserChoiceResult("s1~choose", "req-1", "confirm");
    expect(port.sent).toEqual([{ type: "browser-choice-result", sessionId: "s1~choose", requestId: "req-1", decision: "confirm" }]);
    expect(agentLinkFrameSchema.safeParse(port.sent[0]).success).toBe(true);
  });
});
