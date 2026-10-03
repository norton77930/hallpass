import {
  agentControlFrameSchema,
  agentLinkFrameSchema,
  agentNativeRequestSchema,
  BROWSER_CHOICE_FEATURE,
  PAIRING_DECLINED_MARKER,
  type AgentBrowserKind,
  SITE_PLAN_FEATURE,
  type AgentNativeRequest,
  type AgentNativeResponse,
  type PromptWaitingFrame,
} from "@hallpass/contracts";
import type { PairingAnswer } from "./pairing-controller.js";

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
 * How long the ack waits for the browser run id before it goes without it (two browsers, 2026-10-02).
 *
 * The id is a `chrome.storage.session` read, normally a few milliseconds. The relay leaves if no ack
 * arrives within 10 s, and an ack without the id only costs the two-browser check (the relay then
 * takes over, as before), so the id is never worth more than a short wait.
 */
export const AGENT_ACK_RUN_ID_BOUND_MS = 1_000;

/**
 * How long the ack waits for this browser's identity before the worker gives up on this link (018
 * R-279, T513).
 *
 * The identity is a `chrome.storage.local` read. An ack without it would make the relay publish
 * this browser as a run-scoped legacy entry beside its proper record, so a worker with an identity
 * store never acks without one: a read that does not answer in time drops the link and the normal
 * backoff retries it. A slow read therefore costs a retry rather than a wrong record, so the bound
 * is short - and well inside the relay's 10 s ack bound.
 */
export const AGENT_ACK_IDENTITY_BOUND_MS = 3_000;

/** The identity store exists but did not answer in time, or failed (T513): not the same as "none". */
const IDENTITY_UNREAD: unique symbol = Symbol("identity-unread");

/** Who this browser is, as the ack carries it (018 data-model "Browser identity"). */
export type AgentBrowserIdentity = { browserId: string; kind: AgentBrowserKind; name?: string };

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
  /**
   * The host's id for this pairing exchange (015 FR-218), absent from a 0.7.0 host. Passed on so a
   * later `pair-withdraw` can be matched to the question it ends.
   */
  requestId?: string;
};

export type AgentBridgeDeps = {
  /** Opens the native port. Returns undefined when Chrome cannot reach the host at all. */
  connectNative: () => AgentPortLike | undefined;
  /**
   * The owner's answer, immediate for an already-paired agent and a prompt for a new one. Which of
   * the refusals it was decides how the answer is marked, or whether one is sent (003 FR-032a).
   */
  decidePairing: (request: AgentPairingRequest) => Promise<PairingAnswer>;
  /**
   * Which run of the browser is answering (013/R-184, FR-168), carried on the pairing answer.
   *
   * Injected like every other fact the bridge does not own: the id lives in
   * `chrome.storage.session` (`browser-run.ts`) because its lifetime has to be the browser's, and
   * the transport neither mints it nor interprets it. Absent - or an id that cannot be read - leaves
   * the field off the frame, which is what an extension from before this field looks like to the
   * host: it keeps clearing its retained screenshots on the link, as 013/S1 did.
   */
  browserRunId?: () => Promise<string | undefined>;
  /**
   * This browser's identity (018 R-268), carried on every `relay-ack`, and its re-mint for when the
   * relay reports another live browser holding the same id (R-276). Injected for the same reason as
   * the run id: it lives in `chrome.storage.local` (`browser-identity.ts`) and the transport neither
   * mints nor interprets it. Absent, or a read that answers `undefined` (no storage area), the ack
   * goes without it; a read that fails or does not answer within its bound gets no ack at all.
   */
  browserIdentity?: {
    read: () => Promise<AgentBrowserIdentity | undefined>;
    remint: () => Promise<AgentBrowserIdentity | undefined>;
  };
  /**
   * How many other browsers are connected and this browser's default name, from the relay's
   * directory poll (018 `browser-peers`), for the panel's "This browser" row.
   */
  onBrowserPeers?: (peers: { others: number; defaultName: string }) => void;
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
  onSessionAnnounced?: (session: { sessionId: string; agentId: string; displayName: string; intent?: "choose" }) => void;
  /**
   * 018 FR-274, R-273: a server on a choose-only link asks whether this browser is the one to use.
   * Its *presence* is what the ack advertises as `browser-choice`, so the relay's record never says
   * this worker can show a card it cannot raise (the upload-consent rule, applied to the ack).
   */
  onBrowserChoiceRequest?: (request: { sessionId: string; requestId: string; agentName: string; boundMs: number }) => void;
  /** 018: the request was settled in another browser or ran out; the card goes, silently. */
  onBrowserChoiceWithdraw?: (withdrawal: { sessionId: string; requestId: string }) => void;
  /**
   * One server's socket closed and the relay named the session it belonged to (004 US2).
   *
   * A link event that named no session would end whichever session the worker happened to think
   * was current, which with several live is the wrong agent's work.
   */
  onSessionEnded?: (sessionId: string) => void;
  /**
   * A session's host reported the folder it works in (016 FR-226, R-204).
   *
   * Passed on as parsed; whether the session is one the worker knows is the runtime's question. The
   * label is remote input naming a folder on the agent's machine, so no diagnostic carries it.
   */
  onSessionLabel?: (label: { sessionId: string; label: string }) => void;
  /**
   * The host stopped waiting for one session's pairing answer - its bound expired or the session
   * closed (015 FR-216, FR-217). The card is the runtime's, so the bridge only passes it on; it
   * answers nothing, because the host has already answered its agent.
   */
  onPairWithdraw?: (withdrawal: { agentId: string; sessionId: string; requestId?: string }) => void;
  /**
   * The composer dispatches `propose_sites` to a runner that can raise the site-plan card (017 R-248,
   * R-251). Its presence is what this worker advertises as `site-plan` on every pairing answer; a
   * host never forwards the tool to a worker that did not say so.
   */
  sitePlans?: true;
  /**
   * A relay announced itself on a freshly opened native port. It starts the reconciliation: the
   * sessions whose servers dial back in and greet again survive, the rest are released. The path
   * is where that relay writes its record, when it said (006 FR-082, an optional field).
   */
  onRelayStarted?: (relayPid: number, recordPath: string | undefined) => void;
  onStatusChange?: (status: AgentBridgeStatus) => void;
  /**
   * The host is holding a `file_upload` for a file outside the owner's directories (014/R-187 §3).
   *
   * Its *presence* is what this worker advertises on every pairing answer: the host asks only a
   * side that said it could ask, because an unknown frame type is dropped on both ends of this
   * link and a question nobody raises is a call held until its bound for nothing. So the
   * capability and the handler are one fact, declared once, here.
   */
  onUploadConsentRequest?: (request: {
    sessionId: string;
    callId: string;
    files: Array<{ path: string; directory: string }>;
  }) => void;
  /** The relay's answer about the owner's upload directories (014 FR-194), for the panel's rows. */
  onUploadRoots?: (listing: { roots: string[]; path: string; malformed?: boolean; preserved?: string }) => void;
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
  /**
   * Says that one question is still waiting (011 R-162, FR-148).
   *
   * It is the second frame the worker originates unasked, and it is passed through untouched: the
   * router re-arms a call's backstop from `boundMs - waitedMs` and the server turns the same two
   * numbers into the person's progress message, so anything this module added or rounded would be
   * arithmetic nobody chose. Composed by the runtime, which is where the question lives.
   */
  sendWaiting(frame: PromptWaitingFrame): void;
  /**
   * The owner's answer to one directory question, by the call the host asked about (014).
   *
   * `hint` rides with it only when nobody could see the card (011 FR-146, S3 review F1): the host
   * puts it on the answer the agent reads, which is the only channel left to a person who has not
   * opened the panel their question is in.
   */
  sendUploadConsentResult(callId: string, decision: UploadConsentDecision, hint?: string): void;
  /**
   * Asks the relay what the owner's upload directories are (014 FR-194).
   *
   * Sent on every established link and after every answered question, because the panel's rows are
   * meant to be a picture of the file: the owner may have edited it by hand, and another session's
   * "from now on" writes to the same list.
   */
  requestUploadRoots(): void;
  /** The owner's revoke of one directory, made again on the next link until the relay answers. */
  removeUploadRoot(root: string): void;
  /** The owner renamed this browser (018 FR-268): the relay rewrites its record. Lost with no link. */
  sendBrowserName(name: string): void;
  /** 018 FR-274: the owner's answer on the choice card, addressed to the choose link's session. */
  sendBrowserChoiceResult(sessionId: string, requestId: string, decision: "confirm" | "decline"): void;
  disconnect(): void;
};

/** The six things the owner's answer can be (014/R-187 §1); the runtime maps its card to one. */
export type UploadConsentDecision = "once" | "always" | "deny" | "timed-out" | "interrupted" | "busy";

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
  /**
   * The last link ended on an identity conflict this worker could not re-mint its way out of (T515
   * M1). The next `relay-started` then does not start the cadence over: with storage still failing
   * that relay meets the same conflict, and resetting there is what made it a respawn loop.
   */
  let unresolvedConflict = false;
  /**
   * The last link ended because this browser's identity could not be read in time (T513). Like an
   * unresolved conflict, the next `relay-started` does not start the cadence over, so a storage
   * that keeps hanging backs off instead of dialling a relay every few seconds.
   */
  let identityUnread = false;

  function cancelReopen(): void {
    if (reopen === undefined) return;
    timer.clear(reopen);
    reopen = undefined;
  }

  /**
   * One fact for the ack, bounded. A read that fails or is slow resolves to `undefined`: the ack
   * goes without it, which every relay reads as "not said".
   */
  function boundedForAck<T>(
    read: (() => Promise<T | undefined>) | undefined,
    boundMs: number,
    codes: { slow: string; unreadable: string },
    onSlow?: T,
  ): Promise<T | undefined> {
    if (read === undefined) return Promise.resolve(undefined);
    return new Promise<T | undefined>((resolve) => {
      const bound = setTimeout(() => {
        deps.reportDiagnostic?.(codes.slow);
        resolve(onSlow);
      }, boundMs);
      void (async () => {
        try {
          return await read();
        } catch {
          deps.reportDiagnostic?.(codes.unreadable);
          return undefined;
        }
      })().then((value) => {
        clearTimeout(bound);
        resolve(value);
      });
    });
  }

  /**
   * The browser run for the ack, under its short bound (two browsers, 2026-10-02): without it the
   * relay takes over as it always did.
   */
  function browserRunForAck(): Promise<string | undefined> {
    return boundedForAck(deps.browserRunId, AGENT_ACK_RUN_ID_BOUND_MS, {
      slow: "agent.bridge.browser-run-slow",
      unreadable: "agent.bridge.browser-run-unreadable",
    });
  }

  /**
   * The identity for the ack, under its own bound (018 R-279). `IDENTITY_UNREAD` when the store
   * exists but failed or did not answer in time: unlike the run id, that is not "goes without it" -
   * a new worker with no identity yet is not yet published, never legacy (T513).
   */
  function identityForAck(): Promise<AgentBrowserIdentity | undefined | typeof IDENTITY_UNREAD> {
    const read = deps.browserIdentity?.read;
    if (read === undefined) return Promise.resolve(undefined);
    return boundedForAck<AgentBrowserIdentity | typeof IDENTITY_UNREAD>(
      () => read().catch(() => {
        deps.reportDiagnostic?.("agent.bridge.identity-unreadable");
        return IDENTITY_UNREAD;
      }),
      AGENT_ACK_IDENTITY_BOUND_MS,
      { slow: "agent.bridge.identity-slow", unreadable: "agent.bridge.identity-unreadable" },
      IDENTITY_UNREAD,
    );
  }

  /**
   * The identity store did not answer (T513): no ack, so the relay publishes nothing for this
   * worker; the link goes and the normal backoff retries it.
   */
  function abandonUnidentifiedLink(answering: AgentPortLike): void {
    deps.reportDiagnostic?.("agent.bridge.identity-unread");
    identityUnread = true;
    if (port !== answering) return;
    port = undefined;
    answering.disconnect();
    setStatus("disconnected");
    scheduleReopen();
  }

  /**
   * Answers `relay-started`, then reports the link (004/T169). Split out because the answer may now
   * wait on the browser run id; nothing is done for a port that went away in the meantime.
   */
  function acknowledgeRelay(
    answering: AgentPortLike,
    relayPid: number,
    recordPath: string | undefined,
    browserRunId: string | undefined,
    identity: AgentBrowserIdentity | undefined,
  ): void {
    if (port !== answering) return;
    // Before anything else: the relay publishes its record only on this answer (004/T169,
    // protocol 2), and a `relay-started` this worker never answered is a host with no owner.
    send({
      type: "relay-ack",
      relayPid,
      ...(browserRunId === undefined ? {} : { browserRunId }),
      // 018 R-268: who this browser is, so the relay writes `browsers/<browserId>.json`.
      ...(identity === undefined
        ? {}
        : {
            browserId: identity.browserId,
            browserKind: identity.kind,
            ...(identity.name === undefined ? {} : { browserName: identity.name }),
          }),
      // 018 R-279: the relay's "can show the choice card" flag comes from here, not its version.
      ...(deps.onBrowserChoiceRequest === undefined ? {} : { features: [BROWSER_CHOICE_FEATURE] }),
    });
    setStatus("connected");
    deps.onRelayStarted?.(relayPid, recordPath);
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
            // 018 R-273: a choose-only link; the runtime creates no session state for it.
            ...(link.data.intent === undefined ? {} : { intent: link.data.intent }),
          });
          return;
        case "browser-choice-request":
          // 018 FR-274: the agent's name is remote input; the code is logged, the name never is.
          deps.reportDiagnostic?.("agent.bridge.browser-choice-request");
          deps.onBrowserChoiceRequest?.({
            sessionId: link.data.sessionId,
            requestId: link.data.requestId,
            agentName: link.data.agentName,
            boundMs: link.data.boundMs,
          });
          return;
        case "browser-choice-withdraw":
          deps.reportDiagnostic?.("agent.bridge.browser-choice-withdraw");
          deps.onBrowserChoiceWithdraw?.({ sessionId: link.data.sessionId, requestId: link.data.requestId });
          return;
        case "session-ended":
          deps.reportDiagnostic?.("agent.bridge.session-ended");
          deps.onSessionEnded?.(link.data.sessionId);
          return;
        case "session-label":
          // 016 FR-226: the host's folder name for its session, sent after every greeting. The code
          // is logged, the label never is.
          deps.reportDiagnostic?.("agent.bridge.session-label");
          deps.onSessionLabel?.({ sessionId: link.data.sessionId, label: link.data.label });
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
           *
           * The ack carries this browser's run id (two browsers, 2026-10-02), read under a short
           * bound; without an id to read it goes at once, exactly as before.
           */
          if (!unresolvedConflict && !identityUnread) attempts = 0;
          unresolvedConflict = false;
          identityUnread = false;
          {
            const answering = port;
            const { relayPid, recordPath } = link.data;
            if (answering === undefined) return;
            if (deps.browserRunId === undefined && deps.browserIdentity === undefined) {
              acknowledgeRelay(answering, relayPid, recordPath, undefined, undefined);
            } else {
              void Promise.all([browserRunForAck(), identityForAck()]).then(([id, identity]) => {
                if (identity === IDENTITY_UNREAD) abandonUnidentifiedLink(answering);
                else acknowledgeRelay(answering, relayPid, recordPath, id, identity);
              });
            }
          }
          return;
        case "browser-peers":
          // 018 FR-268, FR-279: the others are counted, never named; for the panel only.
          deps.onBrowserPeers?.({ others: link.data.others, defaultName: link.data.defaultName });
          return;
        case "browser-identity-conflict": {
          /**
           * 018 R-276: another live browser of another run holds this browser's id (a copied
           * profile). The relay did not publish; this worker mints a new identity and opens a new
           * link, whose relay hears the new id on its ack. A reconnect rather than a second ack on
           * this port: the relay has already had the one ack it waits for.
           */
          deps.reportDiagnostic?.("agent.bridge.identity-conflict");
          const conflicted = port;
          const remint = deps.browserIdentity?.remint;
          if (conflicted === undefined || remint === undefined) return;
          void remint().then(
            () => {
              // A link that already went away needs nothing: its re-open reads the new identity.
              if (port !== conflicted) return;
              port = undefined;
              conflicted.disconnect();
              bridge.connect();
            },
            () => {
              deps.reportDiagnostic?.("agent.bridge.identity-remint-failed");
              // T515 M1: the identity is unchanged, so dialling at once would only meet the same
              // conflict - one host process every few hundred ms. Lost link, normal backoff.
              unresolvedConflict = true;
              if (port !== conflicted) return;
              port = undefined;
              conflicted.disconnect();
              setStatus("disconnected");
              scheduleReopen();
            },
          );
          return;
        }
        case "upload-roots":
          // The relay's answer about the owner's own file (014 FR-194). It is a fact about their
          // machine, shown to them: it never goes to a page, a call or an agent.
          deps.onUploadRoots?.({
            roots: [...link.data.roots],
            path: link.data.path,
            ...(link.data.malformed === undefined ? {} : { malformed: link.data.malformed }),
            // S3 review F4: where a document the host could not read was kept, passed through as
            // every other field of this frame is - the panel is the one place it means anything.
            ...(link.data.preserved === undefined ? {} : { preserved: link.data.preserved }),
          });
          return;
        default:
          // `hello-ack` belongs to the relay's loopback half; a relay sending one up the native
          // port is not speaking this protocol. A 0.10.x relay's `relay-standby` lands here too:
          // stand-by is retired (018 R-274), so it is dropped and the port closing is a lost link.
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
        /**
         * The browser run, asked for beside the decision and never instead of it (013/R-184).
         *
         * A storage failure resolves to `undefined` rather than rejecting, because the answer the
         * server is waiting on is the owner's: a pairing left unanswered over an id the host treats
         * as optional would hold the agent's call for the whole pairing bound.
         */
        const browserRun = (async () => {
          try {
            return await deps.browserRunId?.();
          } catch {
            deps.reportDiagnostic?.("agent.bridge.browser-run-unreadable");
            return undefined;
          }
        })();
        void Promise.all([
          deps.decidePairing({
            agentId: pairing.agentId,
            displayName: pairing.displayName,
            origin: pairing.origin,
            sessionId: pairing.sessionId,
            ...(pairing.requestId === undefined ? {} : { requestId: pairing.requestId }),
          }),
          browserRun,
        ])
          // The session is echoed from the request, on every arm. It is what the relay addresses
          // the answer by, so an answer that omitted it - which is what 003's shape did - is
          // dropped as unaddressed and the server waits out its whole pairing bound for nothing.
          .then(([answer, browserRunId]) => {
            if (answer === "abandoned") {
              // The link this request came over is gone and the owner decided nothing, so there is
              // no answer to give (FR-032a). Sent as a refusal it would now tell the host the owner
              // unpaired it; the host's own bound and re-request are what an abandoned card means.
              deps.reportDiagnostic?.("agent.bridge.pairing-abandoned");
              return;
            }
            const features = [
              // 014/R-187 §1: what this worker can be asked beyond answering calls. Derived from
              // the handler rather than declared beside it, so the advertisement cannot outlive
              // the thing it advertises - a host told "I can ask" by a worker that cannot would
              // hold every outside-roots upload until its own bound.
              ...(deps.onUploadConsentRequest === undefined ? [] : ["upload-consent"]),
              // 015 FR-219: this worker takes a `pair-withdraw` and parses a `pair-request` that
              // names its exchange. A 0.7.0 worker's strict parse refuses that `requestId` - and
              // with it the whole card - so the host sends one only after reading this here.
              ...(deps.onPairWithdraw === undefined ? [] : ["pair-withdraw"]),
              // 017 R-251: this worker raises the site-plan card for `propose_sites`.
              ...(deps.sitePlans === true ? [SITE_PLAN_FEATURE] : []),
              // 003 FR-032a: the owner declined this request, which is not an unpair. In
              // `features` because a new key would make a 0.6.0 host drop the whole frame; that
              // host ignores the member and answers the refusal as it always has.
              ...(answer === "declined" ? [PAIRING_DECLINED_MARKER] : []),
            ];
            send({
              type: "pair-result",
              agentId: pairing.agentId,
              sessionId: pairing.sessionId,
              accepted: answer === "accepted",
              ...(browserRunId === undefined ? {} : { browserRunId }),
              ...(features.length === 0 ? {} : { features }),
              // 015 FR-218: the exchange this answers, echoed from the request as the session is.
              // The host ignores an answer naming one it withdrew; a 0.7.0 host sent none, and gets
              // none back - the frame it has always parsed.
              ...(pairing.requestId === undefined ? {} : { requestId: pairing.requestId }),
            });
          })
          /**
           * The decision itself failed (its storage, typically) - which is not an answer of the
           * owner's either, so none is sent (FR-032a). Until then this sent a refusal, and a refusal
           * now says "declined" or "unpaired, reconnect", both of them things the owner did not do.
           * The server's pairing bound ends the call as nobody having answered and its next call
           * asks again, which is also the retry a transient storage failure wants.
           */
          .catch(() => deps.reportDiagnostic?.("agent.bridge.pairing-failed"));
        return;
      }
      case "upload-consent-request":
        /**
         * The one frame the host sends *during* a call it has not made (014/R-187 §1).
         *
         * It carries the owner's own paths, which is why it exists at all: the host is the only
         * side that can see them and the panel is the only place they can be shown. The worker
         * passes them straight to the runtime and keeps none - no page, no call and no log here
         * ever learns a file name (FR-151).
         */
        deps.reportDiagnostic?.("agent.bridge.upload-consent");
        deps.onUploadConsentRequest?.({
          sessionId: control.data.sessionId,
          callId: control.data.callId,
          files: control.data.files.map((file) => ({ path: file.path, directory: file.directory })),
        });
        return;
      case "pair-withdraw":
        // 015 FR-216, FR-217: the host's half of the pairing bound, said out loud. An older worker
        // drops this type as unknown and falls back on its own mirrored bound (FR-219).
        deps.reportDiagnostic?.("agent.bridge.pair-withdraw");
        deps.onPairWithdraw?.({
          agentId: control.data.agentId,
          sessionId: control.data.sessionId,
          ...(control.data.requestId === undefined ? {} : { requestId: control.data.requestId }),
        });
        return;
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
    sendWaiting(frame: PromptWaitingFrame): void {
      // `send` is a no-op with no port: a tick that lands in the moment between the link going away
      // and the runtime cancelling the question it was about is lost, which is what it is.
      send(frame);
    },
    sendUploadConsentResult(callId: string, decision: UploadConsentDecision, hint?: string): void {
      send({ type: "upload-consent-result", callId, decision, ...(hint === undefined ? {} : { hint }) });
    },
    requestUploadRoots(): void {
      send({ type: "upload-roots-list" });
    },
    removeUploadRoot(root: string): void {
      send({ type: "upload-roots-remove", root });
    },
    sendBrowserName(name: string): void {
      send({ type: "browser-name", name });
    },
    sendBrowserChoiceResult(sessionId: string, requestId: string, decision: "confirm" | "decline"): void {
      send({ type: "browser-choice-result", sessionId, requestId, decision });
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
