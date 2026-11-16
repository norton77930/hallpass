import { lookup } from "../../locales/catalog.js";

/**
 * The indicator's sender (004/T107b, FR-062, SC-032).
 *
 * The page half is `content-runtime/indicator.ts` and the return half is `ui.agent.focus-main`;
 * this is the middle one - the only thing in the worker that ever says "show it".
 *
 * Two rules, and neither is about drawing anything:
 *
 * - **Only a tab the session holds is told.** The message is raised where a tab *joins* a session
 *   and lowered where it leaves, so the badge on the owner's page follows the lease and nothing
 *   else. A tab nobody holds is never asked to display an agent that is not working in it.
 * - **The page asks after a navigation.** A new document loses the indicator with the old one, so
 *   the freshly loaded content script announces itself and is answered with that tab's state.
 *   The worker therefore tracks no navigations, and the same answer heals a worker that was
 *   evicted. An announcement from an unheld tab is answered "no indicator" rather than dropped:
 *   silence and "you have none" are different facts, which is T107a's lesson from the other side.
 *
 * The copy crosses already localised. A content script running in a page has no business choosing
 * what the owner is told, so the worker looks the strings up in the browser's own UI language.
 */

/**
 * 034 R-518 (contracts/pill-messages.md): the pill's state. `working` shows Stop, `held` the held
 * label and Resume, `conversation` (a side-panel conversation's session) Stop and never Resume.
 */
export type PillMode = "working" | "held" | "conversation";

/**
 * The worker's copy of the message; the page's is `content-runtime/indicator.ts`. Both follow
 * contracts/pill-messages.md and change together (034 R-518, 035 R-530).
 *
 * 035: `edge` is the owner's edge; `moveToTop` and `moveToBottom` are the move control's words while
 * the pill is drawn at the bottom or at the top; `openPanel` is the open control's words and
 * `panelUnopened` what the pill says when the open did not succeed.
 */
export type IndicatorMessage = {
  type: "indicator";
  show: boolean;
  label?: string;
  action?: string;
  mode?: PillMode;
  stop?: string;
  resume?: string;
  heldLabel?: string;
  stopUndelivered?: string;
  resumeUndelivered?: string;
  edge?: "top" | "bottom";
  moveToTop?: string;
  moveToBottom?: string;
  openPanel?: string;
  panelUnopened?: string;
};

/** What a freshly loaded content script sends; the worker answers with the tab's state. */
export const AGENT_ANNOUNCE = "ui.agent.announce" as const;

export type AgentAnnounceMessage = { type: typeof AGENT_ANNOUNCE };

export function isAgentAnnounceMessage(message: unknown): message is AgentAnnounceMessage {
  return (
    !!message && typeof message === "object" && (message as { type?: unknown }).type === AGENT_ANNOUNCE
  );
}

export type AgentIndicatorDeps = {
  /**
   * Sends one tab its indicator message. Addressed to the top frame: the indicator is one badge on
   * the page, not one per frame, and the declared script runs in every frame of it.
   */
  send: (tabId: number, message: IndicatorMessage) => Promise<void>;
  /**
   * Puts the declared content script into a tab that has none. A tab already open when the
   * extension was (re)loaded never got it - the browser injects declared scripts only into
   * documents loaded afterwards - so a raise sent there finds no receiver.
   */
  inject: (tabId: number) => Promise<void>;
  /** A page that cannot be injected (the browser's own pages, the store) is only worth a diagnostic. */
  reportDiagnostic: (code: string) => void;
  /** Which session holds this tab right now, if any. The lease is the only authority (R-117). */
  holderOf: (tabId: number) => Promise<string | undefined>;
  /** The owner's language, as the browser reports it. */
  locale: () => string;
  /**
   * 034 R-518: which pill a session's tabs show. Synchronous on purpose: a raise must leave in the
   * order it was asked, or a lower sent right after it could reach the page first. Absent: working.
   */
  modeOf?: (sessionId: string) => PillMode;
  /** 034: the tabs a session holds right now, by its leases - what `raiseSession` tells. */
  tabsOf?: (sessionId: string) => Promise<number[]>;
  /**
   * 035 R-528: the owner's edge for the pill. `current` is the memory mirror, read when a message
   * leaves; `ready` resolves once the stored value has been loaded, and the first messages after a
   * worker start wait for it so a restarted worker never draws a pill at the wrong edge. Absent:
   * the edge is `top` and nothing waits.
   */
  pillEdge?: { ready: () => Promise<void>; current: () => "top" | "bottom" };
};

export type AgentIndicator = {
  /**
   * A tab joined a session: it says so on the page from now on, in the session's pill state (034).
   * Without a session the pill is the working one.
   */
  raise: (tabId: number, sessionId?: string) => void;
  /** 034 R-515: the session was held or resumed - every tab it holds redraws its pill. */
  raiseSession: (sessionId: string) => Promise<void>;
  /** A tab left one - released, closed, the session ended, or the owner unpaired its agent. */
  lower: (tabId: number) => void;
  /** A page announced itself; it is answered with what its tab's lease says (T107b). */
  answerAnnouncement: (tabId: number) => Promise<void>;
};

export function createAgentIndicator(deps: AgentIndicatorDeps): AgentIndicator {
  /**
   * The one place the pill's words are chosen (034 FR-523, FR-524). The not-delivered words go with
   * the state, because the worker may be the very thing a press cannot reach (R-517).
   */
  function shown(mode: PillMode): IndicatorMessage {
    const locale = deps.locale();
    const action = lookup("agent.indicator.focusMain", locale);
    // 035 R-530: the owner's edge and the four words of the move and open controls travel with every
    // pill, in either state; the page draws the controls from the words it is given.
    const common = {
      edge: deps.pillEdge?.current() ?? ("top" as const),
      moveToTop: lookup("agent.indicator.moveToTop", locale),
      moveToBottom: lookup("agent.indicator.moveToBottom", locale),
      openPanel: lookup("agent.indicator.openPanel", locale),
      panelUnopened: lookup("agent.indicator.panelUnopened", locale),
    };
    if (mode === "held") {
      return {
        type: "indicator",
        show: true,
        mode,
        heldLabel: lookup("agent.indicator.held", locale),
        action,
        resume: lookup("agent.indicator.resume", locale),
        resumeUndelivered: lookup("agent.indicator.resumeUndelivered", locale),
        ...common,
      };
    }
    return {
      type: "indicator",
      show: true,
      mode,
      label: lookup("agent.indicator.active", locale),
      action,
      stop: lookup("agent.indicator.stop", locale),
      stopUndelivered: lookup("agent.indicator.stopUndelivered", locale),
      ...common,
    };
  }

  const modeOf = (sessionId: string | undefined): PillMode =>
    sessionId === undefined ? "working" : (deps.modeOf?.(sessionId) ?? "working");

  /**
   * 035 R-528: the owner's edge is loaded from storage once per worker start. Until it has been, every
   * message waits behind the same promise - raise, lower and the announcement's answer alike - so they
   * still leave in the order they were asked; once it has, a send is made in the call, as it always was.
   */
  let edgeLoaded = deps.pillEdge === undefined;
  let edgeLoading: Promise<void> | undefined;
  function afterEdgeLoaded(): Promise<void> {
    edgeLoading ??= deps.pillEdge!.ready().then(
      () => {
        edgeLoaded = true;
      },
      () => {
        edgeLoaded = true;
      },
    );
    return edgeLoading;
  }

  /** Sends one message to a tab's top frame; a pill is told the edge as of the moment it leaves. */
  function dispatch(tabId: number, message: IndicatorMessage): Promise<void> {
    if (edgeLoaded) return deps.send(tabId, message);
    return afterEdgeLoaded().then(() =>
      deps.send(tabId, message.show ? { ...message, edge: deps.pillEdge?.current() ?? "top" } : message),
    );
  }

  function raise(tabId: number, sessionId?: string): void {
    // A raise nobody received means the page has no content script (an extension reload leaves
    // every open tab without one). Inject it once; its own announcement is then answered with
    // this tab's state, so nothing is resent here. Only the raise does this: a failed lower has
    // nothing on the page to take down, and the announcement's answer never injects - which is
    // what keeps inject -> announce -> answer from ever becoming a loop.
    void dispatch(tabId, shown(modeOf(sessionId))).catch(() =>
      deps.inject(tabId).catch(() => deps.reportDiagnostic("agent.indicator.inject-failed")),
    );
  }

  return {
    raise,
    async raiseSession(sessionId) {
      for (const tabId of (await deps.tabsOf?.(sessionId)) ?? []) raise(tabId, sessionId);
    },
    lower(tabId) {
      void dispatch(tabId, { type: "indicator", show: false }).catch(() => undefined);
    },
    async answerAnnouncement(tabId) {
      const holder = await deps.holderOf(tabId);
      // 034 US3.4: a page that reloads while its session is held draws the held pill again.
      void dispatch(tabId, holder === undefined ? { type: "indicator", show: false } : shown(modeOf(holder))).catch(
        () => undefined,
      );
    },
  };
}
