import { PROMPT_WAITING_TICK_MS } from "./agent-tools/prompts.js";

/**
 * The "Use this browser for <agent>?" card (018 FR-274, R-273): the worker's half of the in-browser
 * choice, mirroring the pairing card with withdraw (015).
 *
 * The requesting server owns the request and its bound (`boundMs`, two minutes): it asks every
 * browser that advertised the feature, settles on the first confirm and withdraws the rest. So this
 * controller decides nothing about the request - it shows a card, sends the owner's press back once,
 * and takes the card down silently on a withdrawal, at the bound, or when the choose link ends.
 *
 * One card on screen at a time (the panel's `browserChoice`); a second request - another agent
 * asking while the first card stands - waits behind it in arrival order rather than replacing it,
 * because each requester is waiting on its own answer.
 */

export type BrowserChoiceWaitingTick = {
  kind: "browser-choice";
  sessionId: string;
  waitedMs: number;
  boundMs: number;
  panelConnected: boolean;
};

export type BrowserChoiceCard = { requestId: string; agentName: string; raisedAt: string };

export type BrowserChoiceControllerDeps = {
  /** The owner's press, addressed to the choose link the request came over. */
  send: (sessionId: string, requestId: string, decision: "confirm" | "decline") => void;
  onChange?: () => void;
  /** Whether the owner can see a panel (011 R-163); absent means somebody is looking. */
  panelPresence?: () => boolean;
  /** The "still waiting" tick, only while nobody could see the card (011 FR-148, as pairing). */
  onWaiting?: (tick: BrowserChoiceWaitingTick) => void;
  reportDiagnostic?: (code: string) => void;
  now?: () => number;
};

export type BrowserChoiceController = {
  /** The card the panel should show: the earliest request still standing. */
  current(): BrowserChoiceCard | undefined;
  raise(request: { sessionId: string; requestId: string; agentName: string; boundMs: number }): void;
  /** The owner's answer. False, and nothing sent, for a request that is not standing. */
  decide(requestId: string, confirm: boolean): boolean;
  withdraw(sessionId: string, requestId: string): void;
  /** The choose link ended: its cards go, silently. */
  endSession(sessionId: string): void;
  /** The link to the relay is gone: every card goes, silently. */
  clear(): void;
  /** 011 D-011-7: a card that goes out of sight starts ticking from its raise. */
  panelPresenceChanged(): void;
};

type Standing = BrowserChoiceCard & {
  sessionId: string;
  boundMs: number;
  raisedAtMs: number;
  expiry: ReturnType<typeof setTimeout>;
  ticker?: ReturnType<typeof setInterval>;
};

export function createBrowserChoiceController(deps: BrowserChoiceControllerDeps): BrowserChoiceController {
  const standing: Standing[] = [];
  const visible = (): boolean => deps.panelPresence?.() ?? true;

  function startTicker(card: Standing, fromMs: number): void {
    if (deps.onWaiting === undefined) return;
    const say = (waitedMs: number): void => {
      // A tick at the bound buys nothing; the card is over in that same instant.
      if (waitedMs >= card.boundMs) return;
      deps.onWaiting?.({
        kind: "browser-choice",
        sessionId: card.sessionId,
        waitedMs,
        boundMs: card.boundMs,
        panelConnected: deps.panelPresence?.() ?? false,
      });
    };
    let waitedMs = fromMs;
    if (fromMs > 0) say(fromMs);
    const ticker = setInterval(() => {
      waitedMs += PROMPT_WAITING_TICK_MS;
      say(waitedMs);
    }, PROMPT_WAITING_TICK_MS);
    (ticker as { unref?: () => void }).unref?.();
    card.ticker = ticker;
  }

  function remove(predicate: (card: Standing) => boolean): boolean {
    let removed = false;
    for (let index = standing.length - 1; index >= 0; index -= 1) {
      const card = standing[index]!;
      if (!predicate(card)) continue;
      clearTimeout(card.expiry);
      if (card.ticker !== undefined) clearInterval(card.ticker);
      standing.splice(index, 1);
      removed = true;
    }
    return removed;
  }

  function removeAndNotify(predicate: (card: Standing) => boolean): void {
    if (remove(predicate)) deps.onChange?.();
  }

  return {
    current() {
      const first = standing[0];
      return first === undefined ? undefined : { requestId: first.requestId, agentName: first.agentName, raisedAt: first.raisedAt };
    },
    raise({ sessionId, requestId, agentName, boundMs }) {
      // The same request asked again starts over rather than standing twice.
      remove((card) => card.sessionId === sessionId && card.requestId === requestId);
      const raisedAtMs = deps.now?.() ?? Date.now();
      const card: Standing = {
        sessionId,
        requestId,
        agentName,
        boundMs,
        raisedAtMs,
        raisedAt: new Date(raisedAtMs).toISOString(),
        expiry: setTimeout(() => removeAndNotify((other) => other === card), boundMs),
      };
      (card.expiry as { unref?: () => void }).unref?.();
      // As the pairing card: with the panel in sight the server's own wait covers the call, so a
      // tick would only repeat the card on screen.
      if (!visible()) startTicker(card, 0);
      standing.push(card);
      deps.onChange?.();
    },
    decide(requestId, confirm) {
      const card = standing.find((candidate) => candidate.requestId === requestId);
      if (card === undefined) {
        deps.reportDiagnostic?.("agent.browser-choice.late-answer");
        return false;
      }
      remove((other) => other === card);
      deps.send(card.sessionId, card.requestId, confirm ? "confirm" : "decline");
      deps.onChange?.();
      return true;
    },
    withdraw(sessionId, requestId) {
      removeAndNotify((card) => card.sessionId === sessionId && card.requestId === requestId);
    },
    endSession(sessionId) {
      removeAndNotify((card) => card.sessionId === sessionId);
    },
    clear() {
      removeAndNotify(() => true);
    },
    panelPresenceChanged() {
      if (visible()) return;
      const nowMs = deps.now?.() ?? Date.now();
      for (const card of standing) {
        if (card.ticker !== undefined) continue;
        startTicker(card, Math.max(0, nowMs - card.raisedAtMs));
      }
    },
  };
}
