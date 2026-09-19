import {
  agentControlFrameSchema,
  agentLinkFrameSchema,
  agentNativeRequestSchema,
  type AgentNativeRequest,
  type AgentNativeResponse,
} from "@hallpass/contracts";

/**
 * The worker's end of the local agent bridge (003/T013, R-102).
 *
 * Chrome hands `chrome.runtime.connectNative` a Port whose messages are already-parsed JSON - the
 * length prefix is the host's problem, not the extension's - so this module's job is narrower than
 * the host's: refuse anything that is not one of the closed frames, hand what is left to a decider,
 * and answer exactly once.
 *
 * Every decision is injected. The bridge grants nothing: it does not know whether an agent is
 * paired, which tabs a session owns, or what a tool does. That is deliberate - the transport is the
 * one place an attacker reaches first, and a transport that could decide anything would be the
 * place to attack.
 */

/** The native host the manifest registers. Chrome refuses any other name for this extension. */
export const AGENT_NATIVE_HOST_NAME = "com.hallpass.host";

/**
 * How long an awake worker waits before re-opening a link that went away (FR-057, evidence G2).
 *
 * The retry alarm cannot answer FR-057 on its own: Chrome's floor for an alarm is one minute and the
 * bound is ten seconds. The reference reconnects on a five-second cadence and keeps its alarm only
 * for the stretch in which the worker is suspended, which is the split this module implements - the
 * fast path here, the alarm in `agent-runtime.ts` as the backstop.
 */
export const AGENT_RECONNECT_BASE_MS = 5_000;

/**
 * The ceiling the delay doubles up to while nothing answers.
 *
 * A host that is not installed answers no dial, ever, and a fixed five-second retry would then spin
 * for as long as the browser is open. One minute is the ceiling because that is the alarm's own
 * granularity: past that point the backstop is doing the same work anyway, so there is nothing left
 * for a faster timer to win.
 */
export const AGENT_RECONNECT_MAX_MS = 60_000;

/**
 * The Port shape this module uses, which is the part of `chrome.runtime.Port` it actually needs.
 * Naming it here is what lets the bridge be tested without a browser.
 */
export type AgentPortLike = {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(callback: (message: unknown) => void): void };
  onDisconnect: { addListener(callback: () => void): void };
};

/**
 * What the panel shows about the link. `unavailable` means Chrome could not reach the host at all -
 * not installed, not registered, not allowed - while `disconnected` means a link was there and went
 * away; the owner reads them differently, so they are not collapsed into one word.
 */
export type AgentBridgeStatus = "connected" | "unavailable" | "disconnected";

/**
 * The clock the fast reconnect runs on, injected so a test never waits five seconds to see it.
 *
 * It is `setTimeout` in the browser, and it is deliberately not the retry alarm: an alarm survives
 * the worker being evicted, which is what makes it the backstop, and cannot fire inside the bound.
 */
export type AgentReconnectTimer = {
  set: (callback: () => void, delayMs: number) => unknown;
  clear: (handle: unknown) => void;
};

export type AgentPairingRequest = {
  agentId: string;
  displayName: string;
  origin: string;
  /** The agent session this connection belongs to; the host minted it, not the worker (D-M3-3). */
  sessionId: string;
};

export type AgentBridgeDeps = {
  /** Opens the native port. Returns undefined when Chrome cannot reach the host at all. */
  connectNative: () => AgentPortLike | undefined;
  /** The owner's answer, immediate for an already-paired agent and a prompt for a new one. */
  decidePairing: (request: AgentPairingRequest) => Promise<boolean>;
  /** Answers one tool call. Everything it may refuse is refused inside it, never here. */
  callTool: (request: AgentNativeRequest) => Promise<AgentNativeResponse>;
  /**
   * Asks for another connection attempt later; the caller decides how (an alarm, FR-033).
   *
   * This is the backstop only. It stays armed for the worker Chrome suspends between events, and
   * the bridge no longer relies on it to restore a link inside FR-057's bound.
   */
  scheduleRetry: () => void;
  /** Overridden by tests. The default is the browser's own timer. */
  timer?: AgentReconnectTimer;
  /**
   * Why the port just closed, read *inside* the disconnect listener - the only place Chrome makes
   * `chrome.runtime.lastError` say so (004/T169). Absent means "Chrome gave no reason", which is
   * itself a fact (a port closed by our own `disconnect()`, or by the host ending cleanly).
   */
  disconnectReason?: () => string | undefined;
  /**
   * The port closed, with Chrome's reason when it gave one (004/T169). The agent build strips
   * console diagnostics, so this is how the reason reaches somewhere a gate can read it. Measured
   * in the attach family: a port closing while the host behind it was still alive, seventeen
   * seconds into a quiet wait, with nothing on the worker's side to say why.
   */
  onDisconnected?: (reason: string | undefined) => void;
  /**
   * The host's Stop (003 D-M3-1). With a `callId` it ends whatever is still being held for that one
   * call - the host's backstop fired and the agent has already been answered; without one it is the
   * owner stopping everything.
   */
  onStop?: (frame: { sessionId?: string; callId?: string }) => void;
  /**
   * A session announced itself: the relay forwarded a server's greeting (004/T099i).
   *
   * Every attach sends one, so this - not `pair-request` - is what tells the worker a session is
   * live. An id the worker already knows is a reconnect, which keeps the group, the tabs and the
   * binding the session already owns. The token the server presented to the relay is not part of
   * it; it never leaves the host.
   */
  onSessionAnnounced?: (session: { sessionId: string; agentId: string; displayName: string }) => void;
  /**
   * One server's socket closed and the relay named the session it belonged to (004 US2).
   *
   * A link event that named no session would end whichever session the worker happened to think
   * was current, which with several live is the wrong agent's work.
   */
  onSessionEnded?: (sessionId: string) => void;
  /**
   * A relay announced itself on a freshly opened native port. It starts the reconciliation: the
   * sessions whose servers dial back in and greet again survive, the rest are released. The path
   * is where that relay writes its record, when it said (006 FR-082, an optional field).
   */
  onRelayStarted?: (relayPid: number, recordPath: string | undefined) => void;
  onStatusChange?: (status: AgentBridgeStatus) => void;
  reportDiagnostic?: (code: string) => void;
};

export type AgentBridge = {
  /** Opens the port if it is not already open. Safe to call repeatedly. */
  connect(): void;
  status(): AgentBridgeStatus;
  /**
   * Tells one open session the owner has unpaired its agent, so its next call is refused (FR-032).
   *
   * The session is named rather than implied: with several sessions on one relay the frame is the
   * only thing that says which server the decline belongs to, and an unnamed one is dropped by the
   * multiplexer before it reaches anybody (T094a).
   */
  notifyUnpaired(agentId: string, sessionId: string): void;
  disconnect(): void;
};

const defaultTimer: AgentReconnectTimer = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Chrome's reason for the port closing, as it stands inside an `onDisconnect` listener. */
function chromeDisconnectReason(): string | undefined {
  if (typeof chrome === "undefined") return undefined;
  const message = chrome.runtime?.lastError?.message;
  return typeof message === "string" && message.length > 0 ? message.slice(0, 200) : undefined;
}

export function createAgentBridge(deps: AgentBridgeDeps): AgentBridge {
  let port: AgentPortLike | undefined;
  let status: AgentBridgeStatus = "disconnected";
  const timer = deps.timer ?? defaultTimer;
  /** The armed fast re-open, if one is waiting. At most one is ever outstanding. */
  let reopen: unknown;
  /** How many times in a row the link has been lost or refused; it decides the next delay. */
  let attempts = 0;

  function cancelReopen(): void {
    if (reopen === undefined) return;
    timer.clear(reopen);
    reopen = undefined;
  }

  /**
   * Arms the next re-open on the reference's cadence, and asks for the alarm backstop as well.
   *
   * Both, every time: the timer is what meets the bound while the worker is awake, and the alarm is
   * what happens if Chrome evicts the worker before the timer fires - which it is entitled to do at
   * any moment, and does exactly when nothing is calling.
   */
  function scheduleReopen(): void {
    deps.scheduleRetry();
    if (reopen !== undefined) return;
    const delay = Math.min(AGENT_RECONNECT_BASE_MS * 2 ** attempts, AGENT_RECONNECT_MAX_MS);
    attempts += 1;
    reopen = timer.set(() => {
      reopen = undefined;
      bridge.connect();
    }, delay);
  }

  function setStatus(next: AgentBridgeStatus): void {
    if (status === next) {
      return;
    }
    status = next;
    deps.onStatusChange?.(next);
  }

  function send(frame: unknown): void {
    if (!port) {
      return;
    }
    try {
      port.postMessage(frame);
    } catch {
      // A Port Chrome has already torn down throws here. The disconnect listener is what puts the
      // bridge back into a retrying state; losing this one frame is the truth either way.
      deps.reportDiagnostic?.("agent.bridge.send-failed");
    }
  }

  function onFrame(message: unknown): void {
    const request = agentNativeRequestSchema.safeParse(message);
    if (request.success) {
      void deps
        .callTool(request.data)
        .then((response) => send(response))
        .catch(() => {
          // A handler that threw still owes the agent one answer; an unanswered call would hold the
          // agent for the host's full 30 s bound for no reason.
          send({ callId: request.data.callId, outcome: "failed", reason: "handler-error" });
        });
      return;
    }
    const link = agentLinkFrameSchema.safeParse(message);
    if (link.success) {
      // The relay's own two frames about the shape of the link (004 R-111). They are not control
      // frames of the 003 union - a `hello` means something else there - so they are parsed
      // separately rather than folded in, and only the two the worker acts on are handled.
      switch (link.data.type) {
        case "hello":
          // The relay's forwarded announcement (004/T099i). It arrives before the pairing request
          // of the same attach, so the session is registered by the time the owner is asked.
          deps.reportDiagnostic?.("agent.bridge.session-announced");
          deps.onSessionAnnounced?.({
            sessionId: link.data.sessionId,
            agentId: link.data.agentId,
            displayName: link.data.displayName,
          });
          return;
        case "session-ended":
          deps.reportDiagnostic?.("agent.bridge.session-ended");
          deps.onSessionEnded?.(link.data.sessionId);
          return;
        case "relay-started":
          deps.reportDiagnostic?.("agent.bridge.relay-started");
          /**
           * The first evidence the host actually answered (T099h).
           *
           * `connectNative` returns a Port even for a host it cannot spawn and reports the failure
           * asynchronously, so the return told us nothing: the backoff was reset on every failed
           * spawn, the ceiling never engaged, and Chrome respawned the launcher every five seconds
           * for the life of the browser. The status moves here for the same reason - a "connected"
           * on a port that is about to die is a lie the panel shows and the runtime acts on.
           *
           * Ahead of `onRelayStarted` so the runtime's own reaction to the status - the placeholder
           * session - is in place before the reconciliation this frame starts.
           */
          attempts = 0;
          // Before anything else: the relay publishes its record only on this answer (004/T169,
          // protocol 2), and a `relay-started` this worker never answered is a host with no owner.
          send({ type: "relay-ack", relayPid: link.data.relayPid });
          setStatus("connected");
          deps.onRelayStarted?.(link.data.relayPid, link.data.recordPath);
          return;
        default:
          // `hello-ack` belongs to the relay's loopback half; a relay sending one up the native
          // port is not speaking this protocol.
          deps.reportDiagnostic?.("agent.bridge.frame-unexpected");
          return;
      }
    }
    const control = agentControlFrameSchema.safeParse(message);
    if (!control.success) {
      // Not a frame this repository declares. It is dropped rather than answered: answering would
      // tell a prober which shapes are close to correct.
      deps.reportDiagnostic?.("agent.bridge.frame-rejected");
      return;
    }
    switch (control.data.type) {
      case "pair-request": {
        const pairing = control.data;
        void deps
          .decidePairing({
            agentId: pairing.agentId,
            displayName: pairing.displayName,
            origin: pairing.origin,
            sessionId: pairing.sessionId,
          })
          // The session is echoed from the request, on both arms. It is what the relay addresses
          // the answer by, so an answer that omitted it - which is what 003's shape did - is
          // dropped as unaddressed and the server waits out its whole pairing bound for nothing.
          .then((accepted) =>
            send({ type: "pair-result", agentId: pairing.agentId, sessionId: pairing.sessionId, accepted }),
          )
          .catch(() =>
            send({
              type: "pair-result",
              agentId: pairing.agentId,
              sessionId: pairing.sessionId,
              accepted: false,
            }),
          );
        return;
      }
      case "stop":
        deps.reportDiagnostic?.("agent.bridge.stop");
        deps.onStop?.({
          ...(control.data.sessionId === undefined ? {} : { sessionId: control.data.sessionId }),
          ...(control.data.callId === undefined ? {} : { callId: control.data.callId }),
        });
        return;
      default:
        // `pair-result`, `unpair` and `hello` travel the other way or belong to the host's half of
        // the link; a host sending one is not speaking this protocol. `bridge-unavailable` lands
        // here too since B6 removed the relay's side of it: acting on it dropped the port reference
        // without disconnecting the port, which left Chrome holding a relay nobody could reach
        // while the re-open spawned a second one (004/T099c).
        deps.reportDiagnostic?.("agent.bridge.frame-unexpected");
    }
  }

  const bridge: AgentBridge = {
    connect(): void {
      if (port) {
        return;
      }
      // Whatever brought us here - the alarm, the owner's Connect, or the armed re-open itself -
      // is the attempt now, so a timer still counting down would only tear at a link that is up.
      cancelReopen();
      let opened: AgentPortLike | undefined;
      try {
        opened = deps.connectNative();
      } catch {
        opened = undefined;
      }
      if (!opened) {
        // Chrome could not spawn the host: it is not installed, not registered, or not allowed to
        // talk to this extension. All three are "no bridge right now" and all three are retried.
        deps.reportDiagnostic?.("agent.bridge.connect-failed");
        setStatus("unavailable");
        scheduleReopen();
        return;
      }
      port = opened;
      opened.onMessage.addListener((message) => {
        // The same guard the disconnect listener has always had (T099g). Chrome keeps delivering a
        // replaced port's messages, and a supersession leaves exactly that behind for a moment: the
        // old relay's last frames. Acting on one would run a tool for a link nobody is reading and
        // post the answer out on the *current* port, addressed to a call it never made.
        if (port !== opened) {
          deps.reportDiagnostic?.("agent.bridge.frame-stale");
          return;
        }
        onFrame(message);
      });
      opened.onDisconnect.addListener(() => {
        // Read first, whatever else happens: `lastError` is only set for the duration of this
        // listener, and an early return below must not lose it.
        const reason = (deps.disconnectReason ?? chromeDisconnectReason)();
        if (port !== opened) {
          return;
        }
        port = undefined;
        deps.reportDiagnostic?.("agent.bridge.disconnected");
        deps.onDisconnected?.(reason);
        setStatus("disconnected");
        scheduleReopen();
      });
      // Nothing is claimed here. An open Port only means Chrome accepted the name; whether a host
      // exists behind it is answered by its `relay-started`, which is where the status and the
      // backoff are settled (T099h).
    },
    status(): AgentBridgeStatus {
      return status;
    },
    notifyUnpaired(agentId: string, sessionId: string): void {
      send({ type: "pair-result", agentId, sessionId, accepted: false });
    },
    disconnect(): void {
      const open = port;
      port = undefined;
      cancelReopen();
      open?.disconnect();
    },
  };
  return bridge;
}

/** Opens the real native port. Separated so every test above runs without a browser. */
export function connectAgentNativeHost(): AgentPortLike | undefined {
  if (typeof chrome === "undefined" || !chrome.runtime?.connectNative) {
    return undefined;
  }
  return chrome.runtime.connectNative(AGENT_NATIVE_HOST_NAME) as unknown as AgentPortLike;
}
