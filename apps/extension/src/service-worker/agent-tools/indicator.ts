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

export type IndicatorMessage = {
  type: "indicator";
  show: boolean;
  label?: string;
  action?: string;
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
};

export type AgentIndicator = {
  /** A tab joined a session: it says so on the page from now on. */
  raise: (tabId: number) => void;
  /** A tab left one - released, closed, the session ended, or the owner unpaired its agent. */
  lower: (tabId: number) => void;
  /** A page announced itself; it is answered with what its tab's lease says (T107b). */
  answerAnnouncement: (tabId: number) => Promise<void>;
};

export function createAgentIndicator(deps: AgentIndicatorDeps): AgentIndicator {
  function shown(): IndicatorMessage {
    const locale = deps.locale();
    return {
      type: "indicator",
      show: true,
      label: lookup("agent.indicator.active", locale),
      action: lookup("agent.indicator.focusMain", locale),
    };
  }

  return {
    raise(tabId) {
      // A raise nobody received means the page has no content script (an extension reload leaves
      // every open tab without one). Inject it once; its own announcement is then answered with
      // this tab's state, so nothing is resent here. Only the raise does this: a failed lower has
      // nothing on the page to take down, and the announcement's answer never injects - which is
      // what keeps inject -> announce -> answer from ever becoming a loop.
      void deps
        .send(tabId, shown())
        .catch(() => deps.inject(tabId).catch(() => deps.reportDiagnostic("agent.indicator.inject-failed")));
    },
    lower(tabId) {
      void deps.send(tabId, { type: "indicator", show: false }).catch(() => undefined);
    },
    async answerAnnouncement(tabId) {
      const holder = await deps.holderOf(tabId);
      void deps
        .send(tabId, holder === undefined ? { type: "indicator", show: false } : shown())
        .catch(() => undefined);
    },
  };
}
