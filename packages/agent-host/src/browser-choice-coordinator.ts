import {
  agentLinkFrameSchema,
  BROWSER_CHOICE_FEATURE,
  promptWaitingFrameSchema,
  type AgentBrowserSummary,
} from "@hallpass/contracts";

/**
 * The in-browser choice, held by the requesting session's server (018 FR-274, R-273, R-279).
 *
 * No single browser spans the choice, so the server that asked is the one party that can say
 * "the first confirm wins": it opens a separate choose-only link to every browser whose record
 * advertises the card, asks each, settles on the first `confirm`, and takes every other card down.
 * The links are separate because a `hello` naming the session's own id would *replace* the
 * session's live link at that relay (`relay-mux.ts`, R-279) - so each carries a derived id, and the
 * session's own link, pairing and calls are never touched by a choice.
 *
 * This module decides only the race and its endings; the dialling and the selection that follows a
 * confirm are the server's (`mcp-server.ts`), so the selection is exactly `select_browser`'s.
 */

/** How a test shortens the two minutes, as the other bounds are (the contract's constant is unchanged). */
export const BROWSER_CHOICE_BOUND_ENV = "HALLPASS_AGENT_BROWSER_CHOICE_BOUND_MS";

/**
 * How much longer than the card's bound the server waits before it gives up (S5 open question).
 *
 * The server's clock starts before any link has attached and the worker's starts when the card is
 * raised, so a confirm clicked in the card's last second still travels back after the server's
 * bound would have passed. The slack absorbs that dial and transit; the card itself never shows
 * longer than the bound the worker was given.
 */
export const BROWSER_CHOICE_SLACK_MS = 2_000;

/**
 * The sentence on a `{ chosen: false }` that was answered without asking anybody (S5 open question).
 *
 * The contract's answer has no room for a reason (`agentRequestBrowserChoiceResultSchema` is the
 * summary or `chosen: false`), and "nobody could be asked" calls for a different next move from
 * "the user said no": the agent has to ask in the conversation instead. So the answer stays the
 * contract's and this rides beside it as the reply's `hint`.
 */
export const BROWSER_CHOICE_HINTS = {
  noneCapable:
    "No connected browser can show the choice (its Hallpass is older, or none is running). Ask the user which " +
    "browser to use, then call select_browser with its browserId.",
} as const;

/**
 * What a waiting `request_browser_choice` says on its progress ticks (011 R-112 for this wait).
 *
 * A fixed sentence, as the pairing wait's is: nothing page-derived, nothing about any browser. The
 * ticks exist so a client whose request timeout restarts on progress (the MCP SDK's default is
 * 60 s) is not cut off inside the two minutes the owner is given.
 */
export const BROWSER_CHOICE_PROGRESS_MESSAGE = "waiting for the user to choose a browser in a side panel";

/** Whether a browser's record says its worker can show the card - from the worker's ack, not the relay's version (R-279). */
export function canShowBrowserChoice(browser: { features: readonly string[] }): boolean {
  return browser.features.includes(BROWSER_CHOICE_FEATURE);
}

/** What the coordinator is told about one choose link, by whoever dialled it. */
export type ChoiceLinkHandlers = {
  onAttached(): void;
  onFrame(value: unknown): void;
  onDetached(): void;
};

/** One choose link: send on it, and close it (which the relay reads as that link's session ending). */
export type ChoiceLink = {
  send(frame: unknown): boolean;
  close(): void;
};

export type BrowserChoiceOutcome =
  | { kind: "confirmed"; browser: AgentBrowserSummary }
  | {
      kind: "not-chosen";
      why: "declined" | "expired" | "superseded";
      /**
       * US3 AS4 (T515 m3): a browser that never declined said its side panel was closed while its card
       * waited, so the owner may never have seen it - the agent is to have them open it, as an
       * unanswered pairing does. Never set for `superseded`: the agent itself replaced the request.
       */
      panelClosed: boolean;
    };

export type BrowserChoiceRequest = {
  readonly result: Promise<BrowserChoiceOutcome>;
  /**
   * Whether, right now, a browser that did not say no has ticked that its side panel is closed
   * while its card waits (T515 m3 follow-up): what picks the attention sentence over the neutral
   * progress text for the ticks the requesting call reports while it waits.
   */
  panelClosed(): boolean;
  /** A newer request of the same session, or the session ending: every card still up is withdrawn. */
  supersede(): void;
};

type Entry = {
  readonly browser: AgentBrowserSummary;
  link: ChoiceLink | undefined;
  /** Whether the card was asked for on this link: only then is there a card to withdraw. */
  asked: boolean;
  /** `gone` is a link that dropped: that browser is not answering (S5 brief). */
  state: "waiting" | "declined" | "gone";
  /** Ends a link that has not attached within the attach bound: that browser is not answering. */
  attachTimer: ReturnType<typeof setTimeout> | undefined;
  /** The worker ticked `prompt-waiting{kind:"browser-choice"}` with no panel connected (T515 m3). */
  panelClosed: boolean;
};

export function requestBrowserChoice(options: {
  /** Only browsers that can show the card; the caller answers "none can" itself. */
  browsers: readonly AgentBrowserSummary[];
  /** The derived session id every choose link greets with (R-279). */
  linkSessionId: string;
  requestId: string;
  agentName: string;
  /** What the worker is told: how long its card stays up. */
  boundMs: number;
  /** How long this side waits: the bound plus `BROWSER_CHOICE_SLACK_MS`. */
  waitMs: number;
  /**
   * How long a choose link may take to attach before its browser counts as not answering - the
   * server's attach bound. Without it, a browser whose record is published but whose relay answers
   * nothing would hold the request open until the bound after every other browser had declined.
   */
  attachWaitMs: number;
  open(browser: AgentBrowserSummary, handlers: ChoiceLinkHandlers): ChoiceLink;
  log?: (code: string, detail?: string) => void;
}): BrowserChoiceRequest {
  const log = options.log ?? ((): void => undefined);
  const { linkSessionId: sessionId, requestId } = options;
  let settled = false;
  let resolveResult: (outcome: BrowserChoiceOutcome) => void = () => undefined;
  const result = new Promise<BrowserChoiceOutcome>((resolve) => {
    resolveResult = resolve;
  });

  /** Whether a browser that did not say no was, at some point, waiting behind a closed panel. */
  function unseenBehindClosedPanel(): boolean {
    return entries.some((entry) => entry.panelClosed && entry.state !== "declined");
  }

  function notChosen(why: "declined" | "expired" | "superseded"): BrowserChoiceOutcome {
    return { kind: "not-chosen", why, panelClosed: why !== "superseded" && unseenBehindClosedPanel() };
  }

  /** Withdraws every card that is still up, closes every link, and answers - once. */
  function settle(outcome: BrowserChoiceOutcome, winner?: Entry): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    for (const entry of entries) {
      clearTimeout(entry.attachTimer);
      if (entry !== winner && entry.asked && entry.state === "waiting") {
        entry.link?.send({ type: "browser-choice-withdraw", sessionId, requestId });
      }
      entry.link?.close();
    }
    log("agent.browser-choice.settled", outcome.kind === "confirmed" ? "confirmed" : outcome.why);
    resolveResult(outcome);
  }

  /** Every browser has said no or gone away: nobody is left who could still confirm. */
  function settleIfNobodyLeft(): void {
    if (entries.every((entry) => entry.state !== "waiting")) {
      settle(notChosen("declined"));
    }
  }

  const entries: Entry[] = options.browsers.map((browser) => ({
    browser,
    link: undefined,
    asked: false,
    state: "waiting",
    attachTimer: undefined,
    panelClosed: false,
  }));
  const timer = setTimeout(() => settle(notChosen("expired")), options.waitMs);
  (timer as { unref?: () => void }).unref?.();

  /** A link that dropped, or never attached: that browser is not answering (S5). */
  function markGone(entry: Entry, code: string): void {
    if (settled || entry.state !== "waiting") return;
    entry.state = "gone";
    clearTimeout(entry.attachTimer);
    entry.link?.close();
    log(code, entry.browser.kind);
    settleIfNobodyLeft();
  }

  for (const entry of entries) {
    entry.attachTimer = setTimeout(() => {
      if (!entry.asked) markGone(entry, "agent.browser-choice.link-unattached");
    }, options.attachWaitMs);
    (entry.attachTimer as { unref?: () => void }).unref?.();
    entry.link = options.open(entry.browser, {
      onAttached() {
        // Asked once per link: a link that dropped is not re-asked, it counts as not answering.
        if (settled || entry.asked || entry.state !== "waiting") return;
        clearTimeout(entry.attachTimer);
        entry.asked = true;
        entry.link?.send({
          type: "browser-choice-request",
          sessionId,
          requestId,
          agentName: options.agentName,
          boundMs: options.boundMs,
        });
      },
      onFrame(value) {
        // The worker's "still waiting" tick for this card (no callId: the choice is no call). Noted
        // only from a closed panel, and kept once set, as pairing keeps `pairingPanelClosed`.
        const waiting = promptWaitingFrameSchema.safeParse(value);
        if (waiting.success) {
          const tick = waiting.data;
          if (tick.kind === "browser-choice" && tick.sessionId === sessionId && !tick.panelConnected) {
            entry.panelClosed = true;
          }
          return;
        }
        const frame = agentLinkFrameSchema.safeParse(value);
        if (!frame.success || frame.data.type !== "browser-choice-result") return;
        // An answer to another request (a superseded one) or on another link's id is not this one's.
        if (frame.data.requestId !== requestId || frame.data.sessionId !== sessionId) return;
        if (settled || entry.state !== "waiting") return;
        if (frame.data.decision === "confirm") {
          settle({ kind: "confirmed", browser: entry.browser }, entry);
          return;
        }
        entry.state = "declined";
        settleIfNobodyLeft();
      },
      onDetached() {
        markGone(entry, "agent.browser-choice.link-dropped");
      },
    });
  }

  return {
    result,
    panelClosed: unseenBehindClosedPanel,
    supersede() {
      settle(notChosen("superseded"));
    },
  };
}
