import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  AGENT_PANEL_PORT_NAME,
  agentPanelMessageSchema,
  type AgentPanelCommand,
  type AgentPanelState,
} from "@hallpass/contracts";
import { reportTestDiagnostic } from "../../diagnostics.js";
import { panelWindowMessage } from "../../panel-window.js";
import { NotConnected } from "./NotConnected.js";
import { NoticeCard, PromptCard } from "./PromptCard.js";
import { SessionCard } from "./SessionCard.js";
import { SiteList } from "./SiteList.js";
import { StatusRow } from "./StatusRow.js";
import "./tokens.css";
import "./agent.css";

/**
 * The agent build's side panel (006 S1): a status, consent and control surface over the panel
 * port (D-006-1).
 *
 * It owns the port the way the 003 panel did - its own, beside the archived control port - and it
 * keeps nothing else (R-125): which of the compositions is on screen is computed from the last
 * projection that parsed, so the panel can never show a page the worker did not send. Everything
 * the owner presses leaves as one closed command.
 */

const EMPTY_STATE: AgentPanelState = { paired: [], sessions: [], tabs: [], sites: [], bridge: "disconnected" };

/**
 * How many times the panel silently reconnects to a worker that keeps going away - the archived
 * control port's number. An MV3 worker idling out is ordinary and reconnects transparently; one
 * that cannot be reached this many times is not a transient idle, and retrying forever leaves the
 * owner looking at a panel that quietly does nothing.
 */
const MAX_RECONNECT_ATTEMPTS = 6;

/** The three compositions the projection can land on; a pending prompt sits over any of them. */
export type AgentComposition = "not-connected" | "idle" | "sessions";

/**
 * R-125 in one place. Not connected wins over everything: a paired browser whose link is down has
 * nothing the owner can do about a session, and an unpaired one has no session to show.
 */
export function deriveComposition(state: AgentPanelState): AgentComposition {
  if (state.bridge !== "connected" || state.paired.length === 0) return "not-connected";
  return state.sessions.length === 0 ? "idle" : "sessions";
}

export type SendCommand = (command: AgentPanelCommand) => void;

function useAgentPort(): { state: AgentPanelState; send: SendCommand } {
  const [state, setState] = useState<AgentPanelState>(EMPTY_STATE);
  const portRef = useRef<chrome.runtime.Port | undefined>(undefined);
  /** A fresh connection on the owner's word, for after the backoff has given up. */
  const reconnectRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.runtime?.connect) {
      return;
    }
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const onMessage = (message: unknown): void => {
      const parsed = agentPanelMessageSchema.safeParse(message);
      if (!parsed.success) {
        // Keep showing the last projection that parsed. Rendering a state nobody sent is how a
        // panel ends up offering the owner a decision about something that is not there.
        reportTestDiagnostic("agent.panel.projection-rejected");
        return;
      }
      // A projection proves this connection is healthy, so the next drop backs off from scratch.
      attempt = 0;
      setState(parsed.data.payload);
    };
    const connect = (): void => {
      if (disposed) {
        return;
      }
      let port: chrome.runtime.Port;
      try {
        port = chrome.runtime.connect({ name: AGENT_PANEL_PORT_NAME });
      } catch {
        // An extension page orphaned by a reload throws "Extension context invalidated": there is
        // no worker this page can ever reach again, so say so rather than retry.
        reportTestDiagnostic("agent.panel.connect-unavailable");
        setState((current) => ({ ...current, bridge: "disconnected" }));
        return;
      }
      portRef.current = port;
      port.onMessage.addListener(onMessage);
      /**
       * Which window this panel is in, on every connection (fix 2026-09-23, panel in another
       * window). The worker counts a panel as in front of the owner only when it is in the window
       * they last focused - a panel open in another window left the badge off and a pairing card
       * on the 45 s bound while the owner saw nothing - and the port itself does not say where the
       * panel is. Every connection rather than the first: a worker that restarted remembers nothing.
       *
       * Until this arrives the worker counts the panel as not seen, which only means the badge may
       * be on for the moment `getCurrent` takes. A failure leaves it that way and is said.
       */
      void Promise.resolve()
        .then(() => chrome.windows?.getCurrent?.())
        .then((window) => {
          if (portRef.current !== port || typeof window?.id !== "number") return;
          port.postMessage(panelWindowMessage(window.id));
        })
        .catch(() => reportTestDiagnostic("agent.panel.window-unknown"));
      port.onDisconnect.addListener(() => {
        // An MV3 service worker idles out, and an extension reload or a worker restart does the
        // same: each takes the port with it. Without this the panel keeps a dead handle - every
        // button silently stops working with nothing on screen to say so, and the new worker has
        // no panel to publish its consent prompts to. Observed three times on 2026-09-16.
        if (portRef.current === port) {
          portRef.current = undefined;
        }
        // Chrome's own sentence about the drop, read so it is on the record (and so Chrome does
        // not log it as unchecked) - the one fact that tells a worker idling out from a worker
        // that cannot start.
        const reason = chrome.runtime.lastError?.message;
        reportTestDiagnostic(`agent.panel.disconnected${reason ? `: ${reason}` : ""}`);
        if (disposed) {
          return;
        }
        // The last projection stays on screen while a retry is pending: the worker re-publishes
        // the whole projection the moment the new port is accepted, so the picture is a
        // fraction of a second stale, not wrong.
        attempt += 1;
        if (attempt > MAX_RECONNECT_ATTEMPTS) {
          setState((current) => ({ ...current, bridge: "disconnected" }));
          return;
        }
        retryTimer = setTimeout(connect, Math.min(250 * 2 ** (attempt - 1), 5000));
      });
    };

    connect();
    reconnectRef.current = () => {
      // The owner pressed something with no port to carry it: whether the backoff gave up or is
      // mid-wait, their press is the better signal - start over now, from the first delay.
      if (disposed || portRef.current) {
        return;
      }
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      attempt = 0;
      connect();
    };

    return () => {
      disposed = true;
      reconnectRef.current = undefined;
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
      }
      const port = portRef.current;
      portRef.current = undefined;
      if (port) {
        port.onMessage.removeListener(onMessage);
        port.disconnect();
      }
    };
  }, []);

  const send: SendCommand = (command) => {
    const port = portRef.current;
    if (!port) {
      // This press is lost - the projection it answered may not survive the reconnect anyway -
      // but it is the owner asking, so the next one has a port to leave on. Without this the
      // give-up page's Retry would be a button that can never work.
      reportTestDiagnostic("agent.panel.message-dropped");
      reconnectRef.current?.();
      return;
    }
    try {
      port.postMessage(command);
    } catch {
      // The worker can idle out between the last projection and this click.
      reportTestDiagnostic("agent.panel.send-failed");
      portRef.current = undefined;
    }
  };

  return { state, send };
}

/** How often the cards' "last action" words are measured again (016 FR-230). */
export const LAST_ACTION_TICK_MS = 60_000;

/**
 * The panel's own minute clock (016 FR-230, R-206).
 *
 * "Idle · last action 12 min ago" goes stale while the worker has nothing new to say, and asking
 * it for a projection once a minute would be traffic for the sake of a word. So the shell ticks
 * once a minute and the cards measure against the tick; nothing leaves the panel.
 */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), LAST_ACTION_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function AgentShell(props: { locale: string }): ReactElement {
  const { state, send } = useAgentPort();
  const now = useMinuteClock();
  const composition = deriveComposition(state);

  /**
   * The name the owner knows an agent by (FR-035's stated name), never the session id. The fallback
   * to the id covers the moment mid-unpair when a session is projected for an agent no longer listed.
   */
  const agentName = (agentId: string): string =>
    state.paired.find((agent) => agent.agentId === agentId)?.displayName ?? agentId;

  // Newest activity first (US3 scenario 1); a session without a timestamp sorts last.
  const sessions = [...state.sessions].sort((a, b) =>
    (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""),
  );

  /**
   * Whose question the consent card is about: the session the worker marked `waiting` (R-127), or
   * the paired agent when the projection names none - which is the one-agent case, where the two
   * are the same agent.
   */
  const waiting = state.sessions.find((session) => session.state === "waiting");
  const promptAgent = waiting ? agentName(waiting.agentId) : (state.agentName ?? "");
  /** The newest non-blocking notice any session is carrying (008 FR-114); at most one is shown. */
  const notice = state.sessions
    .map((session) => session.notice)
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
    .sort((left, right) => right.at - left.at)[0];

  return (
    <div className="agent-shell" data-agent-state={composition}>
      {/* 016 FR-224: no in-panel heading - the browser's side-panel header already names the product. */}
      <PromptCard state={state} locale={props.locale} promptAgent={promptAgent} send={send} />
      {/*
        008 FR-114: under the question area, never in it. A notice is not an answerable question,
        so it sits below whatever is being asked and takes no focus from it; the newest session's
        is the one on screen, because the notice is about what just happened.
      */}
      {notice === undefined ? null : <NoticeCard notice={notice} locale={props.locale} />}
      {composition === "not-connected" ? (
        <NotConnected
          variant={state.paired.length === 0 ? "not-paired" : "bridge-lost"}
          diagnostics={state.diagnostics ?? {}}
          locale={props.locale}
          onRetry={() => {
            send({ type: "ui.agent.retry-bridge", payload: {} });
          }}
        />
      ) : (
        <>
          <StatusRow
            sessionCount={state.sessions.length}
            paired={state.paired}
            locale={props.locale}
            onUnpair={(agentId) => {
              // 016 FR-223: the agent the owner chose, and no other - the menu names each one.
              send({ type: "ui.agent.unpair", payload: { agentId } });
            }}
          />
          {sessions.map((session) => (
            <SessionCard
              key={session.sessionId}
              session={session}
              agentName={agentName(session.agentId)}
              locale={props.locale}
              now={now}
              onStop={() => {
                send({ type: "ui.agent.session-stop", payload: { sessionId: session.sessionId } });
              }}
              onRelease={() => {
                send({ type: "ui.agent.session-release", payload: { sessionId: session.sessionId } });
              }}
              onInterrupt={() => {
                send({ type: "ui.agent.session-interrupt", payload: { sessionId: session.sessionId } });
              }}
            />
          ))}
          <SiteList
            sites={state.sites}
            transitions={state.transitions}
            uploadRoots={state.uploadRoots}
            locale={props.locale}
            send={send}
          />
        </>
      )}
    </div>
  );
}
