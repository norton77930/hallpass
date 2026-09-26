import { CLOSED_PANEL_TIMEOUT_MS, PROMPT_WAITING_TICK_MS } from "./agent-tools/prompts.js";

/**
 * Which agents the owner has paired, and the one prompt that can change that (003/T014, T015).
 *
 * The transitions are a pure reducer and the storage is a thin shell around it, because everything
 * worth being sure of is a transition: connecting never pairs, one agent's acceptance never pairs
 * another, and unpairing is effective at once rather than at the end of a session (FR-032).
 *
 * Pairings live in `chrome.storage.local` because they are the owner's standing decision and must
 * outlive the browser (R-108); sessions do not, and live elsewhere.
 */

/**
 * The server's own bound on a pairing exchange, mirrored here (011 R-163, contracts/prompt-waiting.md).
 *
 * The server owns the *agent's* side of the bound: it withdraws its request when this passes and
 * answers the call `timed-out` (FR-059), and it keeps this 45 s whenever a panel is open - which is
 * why no tick is sent in that case at all (review M1). A tick goes out on the one fact the server
 * cannot see - nobody has a panel open to answer in - and carries the closed-panel bound instead;
 * the server takes the larger of its own and the frame's, so the only thing this worker can do to a
 * pairing exchange is lengthen it.
 *
 * The worker owns the *card's* side of the same bound (review 4b): the withdrawal is silent, so
 * without this the panel would keep an Accept button for a request nobody is holding and the icon
 * would keep its badge (FR-147). Whichever bound the card was raised under is the one it is kept
 * to, so the two sides end together - lengthened to the closed-panel bound, from the raise, if the
 * panel goes out of sight while it waits (D-011-7), which the ticks then tell the server.
 */
export const PAIRING_BOUND_MS = 45_000;

/** One "still waiting" about the pairing card; the runtime turns it into the link frame. */
export type PairingWaitingTick = {
  kind: "pairing";
  /** The session that raised the card. Pairing has no call of its own; the server owns that. */
  sessionId: string;
  waitedMs: number;
  boundMs: number;
  panelConnected: boolean;
};

export type PairedAgent = {
  agentId: string;
  /** What the owner saw in the prompt, kept so the paired list says the same thing later. */
  displayName: string;
  origin: string;
  acceptedAt: string;
};

export type PendingPairing = { agentId: string; displayName: string; origin: string };

export type PairingState = {
  paired: PairedAgent[];
  /** At most one prompt at a time: the owner answers one question, not a queue of them. */
  pending?: PendingPairing;
};

export const EMPTY_PAIRING_STATE: PairingState = { paired: [] };

export type PairingEvent =
  | ({ type: "connection" } & PendingPairing)
  | { type: "decide"; agentId: string; accepted: boolean; at: string }
  | { type: "unpair"; agentId: string }
  /**
   * The prompt goes and nothing is stored - the owner's Ignore (006 FR-084) and the clock's expiry
   * alike. Whether the waiting agent is answered is the controller's business, not the reducer's:
   * Ignore answers it as a decline of this one request (FR-032a, amended 2026-09-24); expiry answers
   * nothing, because the host has already withdrawn the request at the same bound.
   */
  | { type: "ignore"; agentId: string }
  /**
   * The connection that raised the prompt has gone. A pending pairing belongs to one live first
   * connection (data-model PairedAgent), so it is dropped rather than carried across the gap: the
   * owner's answer would settle a promise nobody is holding, and the panel would be showing an
   * Accept button for an agent that is not there.
   */
  | { type: "abandon" };

export function reducePairing(state: PairingState, event: PairingEvent): PairingState {
  switch (event.type) {
    case "connection": {
      if (state.paired.some((agent) => agent.agentId === event.agentId)) {
        // Already the owner's decision. Asking again every session is exactly what SC-020 forbids.
        return state;
      }
      if (state.pending?.agentId === event.agentId) {
        // Another session of the same agent, arriving while its prompt is still open: it joins
        // that prompt. Replacing it would ask the owner once per session and, worse, orphan the
        // prompt the first session is holding its first tool call on (T096b).
        return state;
      }
      return {
        paired: state.paired,
        pending: { agentId: event.agentId, displayName: event.displayName, origin: event.origin },
      };
    }
    case "decide": {
      const pending = state.pending;
      if (!pending || pending.agentId !== event.agentId) {
        // A decision for something nobody asked about changes nothing: the prompt is the only
        // thing that can pair an agent, so an answer without one is not an answer.
        return state;
      }
      if (!event.accepted) {
        return { paired: state.paired };
      }
      return {
        paired: [...state.paired, { ...pending, acceptedAt: event.at }],
      };
    }
    case "unpair":
      return {
        paired: state.paired.filter((agent) => agent.agentId !== event.agentId),
        ...(state.pending && state.pending.agentId !== event.agentId ? { pending: state.pending } : {}),
      };
    case "ignore":
      if (state.pending?.agentId !== event.agentId) return state;
      return { paired: state.paired };
    case "abandon":
      // Only the prompt goes; the paired list is the owner's standing decision and survives a link
      // that dropped.
      return { paired: state.paired };
    default:
      return state;
  }
}

const STORAGE_KEY = "agentPairings";

/** Whether two readings of the durable half say the same thing, agent for agent. */
function samePaired(left: PairedAgent[], right: PairedAgent[]): boolean {
  return (
    left.length === right.length &&
    left.every((agent, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        agent.agentId === other.agentId &&
        agent.acceptedAt === other.acceptedAt
      );
    })
  );
}

export async function readPairingState(): Promise<PairingState> {
  const area = typeof chrome !== "undefined" ? chrome.storage?.local : undefined;
  if (!area) {
    return EMPTY_PAIRING_STATE;
  }
  const raw = (await area.get([STORAGE_KEY])) as Record<string, unknown>;
  const stored = raw[STORAGE_KEY];
  if (!stored || typeof stored !== "object" || !Array.isArray((stored as PairingState).paired)) {
    return EMPTY_PAIRING_STATE;
  }
  // Only the durable half is read back. A pending prompt belongs to a live connection, so one
  // restored from storage would ask the owner about an agent that is no longer there.
  return { paired: [...(stored as PairingState).paired] };
}

export async function writePairingState(state: PairingState): Promise<void> {
  const area = typeof chrome !== "undefined" ? chrome.storage?.local : undefined;
  if (!area) {
    return;
  }
  await area.set({ [STORAGE_KEY]: { paired: state.paired } });
}

/**
 * Tells the controller when the record changes under it (004/T111f).
 *
 * The controller's own writes raise this too, which costs one re-read and is the price of not
 * having to tell its own writes from anyone else's - a distinction storage does not offer and that
 * would put the cache back in charge of deciding whom to believe.
 */
export function watchPairingState(onExternalChange: () => void): void {
  const changed = typeof chrome !== "undefined" ? chrome.storage?.onChanged : undefined;
  changed?.addListener((changes, areaName) => {
    if (areaName === "local" && STORAGE_KEY in changes) {
      onExternalChange();
    }
  });
}

/**
 * How one waiting pairing request was settled (003 FR-032a).
 *
 * Four words rather than a boolean, because three different things used to arrive as `false` and
 * the host now has to act on them differently: the owner's Decline answers that request alone, an
 * unpair ends the session's standing until it reconnects, and a request abandoned with its link is
 * no answer of the owner's at all. The bridge marks the first, leaves the second unmarked (which is
 * what an unmarked refusal has always meant) and sends nothing for the third.
 */
export type PairingAnswer = "accepted" | "declined" | "unpaired" | "abandoned";

export type PairingControllerDeps = {
  read: () => Promise<PairingState>;
  write: (state: PairingState) => Promise<void>;
  now: () => string;
  /** Called whenever the state changes, so the panel's projection follows it. */
  onChange?: (state: PairingState) => void;
  /**
   * Registers a listener for changes to the stored record made outside this controller, so the
   * cache can be dropped instead of being written back over them (004/T111f).
   */
  watch?: (onExternalChange: () => void) => void;
  /**
   * Whether the owner can see a panel, read when a card is raised (011 R-163) and again on
   * `panelPresenceChanged` (D-011-7) - a connected
   * panel in the last-focused window since the fix of 2026-09-23 (panel in another window).
   * Absent means "assume somebody is looking", which is what every pre-011 composition meant.
   */
  panelPresence?: () => boolean;
  /**
   * Called every `PROMPT_WAITING_TICK_MS` while a pairing card stands unanswered in a panel nobody
   * had open when it was raised (011 FR-148, review M1), once per session waiting on it (M2).
   */
  onWaiting?: (tick: PairingWaitingTick) => void;
  /**
   * Called when the number of sessions waiting on the card changes (item 2, 2026-09-24). A second
   * session joining leaves the reducer's state as it was - nothing is written or announced through
   * `onChange` - yet the card has to say that one more connection is now waiting on it.
   */
  onWaitersChange?: () => void;
};

export type PairingController = {
  /**
   * The bridge's answer to one `pair-request`. Resolves immediately for a paired agent and
   * otherwise not until the owner answers the prompt.
   *
   * `sessionId` is who is asking (011): it addresses the "still waiting" ticks and nothing else, so
   * it is taken beside the request rather than inside it - the pending card, and the durable record
   * the owner's accept writes, are about an *agent*, and a session id has no business in either.
   */
  decidePairing: (request: PendingPairing & { sessionId?: string; requestId?: string }) => Promise<PairingAnswer>;
  /**
   * The host stopped waiting for one session's answer - its bound expired or the session closed
   * (015 FR-216, FR-217). The same quiet expiry the worker's own clock runs: that session leaves
   * the waiting list, and the card goes only with the last one. A `requestId` naming an exchange
   * other than the one the session is waiting on now is a withdrawal of an earlier question, and
   * changes nothing (FR-218).
   */
  withdraw: (agentId: string, sessionId: string, requestId?: string) => void;
  /** The panel's answer to the prompt. */
  decide: (agentId: string, accepted: boolean) => Promise<void>;
  /** The panel's Ignore (006 FR-084, amended 2026-09-24): the prompt goes and the waiting sessions are answered `declined` - this request only. */
  ignore: (agentId: string) => Promise<void>;
  unpair: (agentId: string) => Promise<void>;
  /**
   * One session is over - its server's socket closed, or its MCP session ended (011 review M2).
   *
   * Only its ticks go. The card is about the agent and another session of it may still be waiting
   * on the owner's answer, so ending the question here would take down a card somebody is looking
   * at; a tick addressed to a session the relay no longer has, on the other hand, is a frame that
   * can only be dropped.
   */
  sessionEnded: (sessionId: string) => void;
  /** The link dropped: forget the prompt it raised and refuse the call that was waiting on it. */
  abandonPending: () => Promise<void>;
  isPaired: (agentId: string) => Promise<boolean>;
  state: () => Promise<PairingState>;
  /** Resolves once every state change asked for so far has been written. */
  ready: () => Promise<void>;
  /** How many connections are waiting on this agent's card right now (item 2): what the card counts. */
  waitingSessions: (agentId: string) => number;
  /**
   * The panel's visibility may have changed (011 D-011-7): re-reads `panelPresence`, and a card
   * raised in sight that nobody can see any more is kept to the closed-panel bound from its raise,
   * with ticks. Idempotent; a panel coming into sight changes nothing.
   */
  panelPresenceChanged: () => void;
};

export function createPairingController(deps: PairingControllerDeps): PairingController {
  let loaded: PairingState | undefined;
  /**
   * One entry per session waiting on a prompt, resolved by the panel's decision. It is a list
   * because several sessions of one agent connect at once (D-004-2) and every one of them is
   * holding a tool call on the same single answer.
   */
  let waiting: {
    agentId: string;
    /**
     * Which session is holding this one (011 review 4b). The card is answered per agent, so this is
     * read for one thing only: a session whose own wait ran out is dropped without an answer, and
     * the sessions still inside theirs are left holding.
     */
    sessionId?: string;
    /** The host's id for the exchange this session is waiting on (015 FR-218), when it sent one. */
    requestId?: string;
    resolve: (answer: PairingAnswer) => void;
  }[] = [];
  /**
   * Every mutation runs on one chain. Two frames arriving together must not each read the state,
   * decide from it and write it back, which is how one of the two decisions disappears.
   */
  let queue: Promise<void> = Promise.resolve();

  /**
   * The record changed since `loaded` was taken, so `loaded` is a claim about storage that storage
   * no longer agrees with (004/T111f).
   */
  let stale = false;
  deps.watch?.(() => {
    stale = true;
    void reconcile();
  });

  async function load(): Promise<PairingState> {
    if (stale) {
      stale = false;
      const durable = await deps.read();
      // Only the durable half is re-read: the prompt lives in this worker, not in storage, and a
      // change to the paired list must not take it - and the session waiting on it - away.
      loaded = { paired: durable.paired, ...(loaded?.pending ? { pending: loaded.pending } : {}) };
    }
    loaded ??= await deps.read();
    return loaded;
  }

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * One ticker per session waiting on the card, while it stands (011, review M2).
   *
   * One card, several tickers, because the card and the frame are addressed to different things:
   * the card is about an *agent* and every session of it waits on the same answer, while a
   * `prompt-waiting` frame is routed to a *session* and is what holds that session's own server
   * back from answering `not-paired`. Two Claude Code windows on one unpaired agent are the
   * ordinary case, and the second of them used to hear nothing at all.
   */
  const waitingOn = new Map<
    string,
    {
      agentId: string;
      /** Absent when a panel was open at the raise: nothing is said about a card in front of them. */
      ticker?: ReturnType<typeof setInterval>;
      /** When this session's wait runs out, which is when the server withdraws its request. */
      expiry: ReturnType<typeof setTimeout>;
      /** When the card was raised for this session, and the bound it runs under (D-011-7). */
      raisedAtMs: number;
      boundMs: number;
      /** The host's id for this session's exchange (015 FR-218), when it sent one. */
      requestId?: string;
    }
  >();

  /**
   * Ticks for one session, from `fromMs` into its wait. A wait that went out of sight mid-way
   * (D-011-7) says so at once: the server's own 45 s may be about to pass.
   */
  function startTicker(sessionId: string, fromMs: number, boundMs: number): ReturnType<typeof setInterval> {
    const say = (waitedMs: number): void => {
      // A tick at the bound itself buys nothing - the host re-arms on `boundMs - waitedMs`, which
      // is zero by then - and the card is over in that same instant (review 4b). Said here rather
      // than left to which of the two timers the runtime happens to run first.
      if (waitedMs >= boundMs) return;
      // Read at each tick: a panel back in sight still ticks (the host's keep-alive for the bound
      // already granted) but must not have the agent told to open it.
      const panelConnected = deps.panelPresence?.() ?? false;
      deps.onWaiting?.({ kind: "pairing", sessionId, waitedMs, boundMs, panelConnected });
    };
    let waitedMs = fromMs;
    if (fromMs > 0) say(fromMs);
    const ticker = setInterval(() => {
      waitedMs += PROMPT_WAITING_TICK_MS;
      say(waitedMs);
    }, PROMPT_WAITING_TICK_MS);
    (ticker as { unref?: () => void }).unref?.();
    return ticker;
  }

  function stopWaiting(sessionId: string): void {
    const running = waitingOn.get(sessionId);
    if (!running) return;
    if (running.ticker !== undefined) clearInterval(running.ticker);
    clearTimeout(running.expiry);
    waitingOn.delete(sessionId);
  }

  /**
   * Keeps the ticks and the card in step. Every route out of a pending pairing - the owner's
   * answer, their Ignore, an unpair, the link going away, an acceptance written elsewhere - ends in
   * a state whose `pending` is gone or is about another agent, so this is the one place that has to
   * notice, rather than five places that each have to remember.
   */
  function syncWaiting(state: PairingState): void {
    for (const [sessionId, running] of [...waitingOn]) {
      if (state.pending?.agentId !== running.agentId) stopWaiting(sessionId);
    }
  }

  function startWaiting(agentId: string, sessionId: string | undefined, requestId?: string): void {
    // Nothing to address the tick to.
    if (sessionId === undefined) return;
    /**
     * A card raised again for a session that is already ticking starts that session over (L2).
     *
     * This is the server having withdrawn its request at its own bound and asked again on the next
     * call, with the card still on screen. It is a new question with a new start, and the panel may
     * have been opened since the old one was raised - so the presence and the bound are read here
     * rather than carried across, exactly as they are for a card nobody has raised before.
     */
    stopWaiting(sessionId);
    const raisedAtMs = Date.now();
    const panelConnected = deps.panelPresence?.() ?? true;
    const boundMs = panelConnected ? PAIRING_BOUND_MS : CLOSED_PANEL_TIMEOUT_MS;
    // Only while nobody can see the card (011 FR-148, review M1). With a panel open the server's
    // own 45 s and its own progress ticker already cover the wait, and this worker knows nothing
    // about it the server does not - a tick would only say the same thing twice. The bound below
    // still applies: it is the card's, not the tick's.
    const ticker = panelConnected ? undefined : startTicker(sessionId, 0, boundMs);
    // Armed after the ticker, so the bound's own tick - the one the server read to get here - still
    // goes out before the wait is declared over.
    const expiry = setTimeout(() => expireWaiting(agentId, sessionId), boundMs);
    (expiry as { unref?: () => void }).unref?.();
    waitingOn.set(sessionId, {
      agentId,
      ...(ticker === undefined ? {} : { ticker }),
      expiry,
      raisedAtMs,
      boundMs,
      ...(requestId === undefined ? {} : { requestId }),
    });
  }

  /**
   * The panel went out of sight while the card waits (011 D-011-7): every session still on the open
   * panel's 45 s becomes one raised with nobody looking - ticks from now, and the card kept to the
   * closed-panel bound counted from its raise, which is exactly what the ticks ask the server for.
   * A panel coming into sight shortens nothing, so that direction has nothing to do here.
   */
  function panelPresenceChanged(): void {
    if (deps.panelPresence?.() ?? true) return;
    for (const [sessionId, running] of waitingOn) {
      if (running.ticker !== undefined) continue;
      const waitedMs = Math.max(0, Date.now() - running.raisedAtMs);
      const boundMs = Math.max(running.boundMs, CLOSED_PANEL_TIMEOUT_MS);
      clearTimeout(running.expiry);
      running.boundMs = boundMs;
      running.ticker = startTicker(sessionId, waitedMs, boundMs);
      const agentId = running.agentId;
      running.expiry = setTimeout(() => expireWaiting(agentId, sessionId), Math.max(0, boundMs - waitedMs));
      (running.expiry as { unref?: () => void }).unref?.();
    }
  }

  /**
   * One session's wait is over (011 review 4b, FR-147, FR-059).
   *
   * The server withdrew its request at this same bound and said nothing about it: the agent has its
   * `timed-out`, and the next call raises the question afresh. This is the worker's half of that -
   * the owner's Ignore, arrived at by the clock rather than by them - and it is deliberately as
   * quiet: nothing is sent, because a `pair-result` now would reach a server that is no longer
   * asking and settle that session as *decided*, which is the outcome the withdrawal exists to
   * avoid. The waiting session is dropped rather than answered, exactly as `ignore` drops it, so
   * the prompt the next call raises gets fresh waiters.
   *
   * The card itself is about an agent, so it goes only when the last session waiting on it has run
   * out; one window closing its wait while another is mid-way through is not the card's ending.
   */
  function expireWaiting(agentId: string, sessionId: string): void {
    stopWaiting(sessionId);
    waiting = waiting.filter((waiter) => !(waiter.agentId === agentId && waiter.sessionId === sessionId));
    for (const running of waitingOn.values()) {
      if (running.agentId === agentId) {
        // The card stays, one connection fewer: its count says so.
        deps.onWaitersChange?.();
        return;
      }
    }
    // Nobody is being asked any more, so nothing may still be shown: `ignore` is the transition
    // that takes the card down without deciding anything, and the panel and the icon follow it.
    void enqueue(() => apply({ type: "ignore", agentId })).catch(() => undefined);
    // Including a session that was never given a clock of its own (no session id): the card it was
    // waiting on is gone, and an unresolved waiter here would answer the *next* card's question.
    waiting = waiting.filter((waiter) => waiter.agentId !== agentId);
  }

  /**
   * The host's withdrawal of one session's request (015 FR-216, FR-217), routed to `expireWaiting`
   * rather than beside it: the host has already answered its agent, exactly as at the worker's own
   * bound, so the card is taken down the same quiet way.
   *
   * Two withdrawals change nothing. One for a session that is not waiting on this agent, because
   * `expireWaiting` would read "nobody else is waiting" as the card's end and take down a card
   * raised for somebody else. And one naming an earlier exchange than the one the session is
   * waiting on now (FR-218): that question is already over, and the newer one is still being asked.
   */
  function withdraw(agentId: string, sessionId: string, requestId?: string): void {
    const running = waitingOn.get(sessionId);
    const ticking = running?.agentId === agentId ? running : undefined;
    const held = waiting.filter((waiter) => waiter.agentId === agentId && waiter.sessionId === sessionId);
    if (ticking === undefined && held.length === 0) return;
    if (requestId !== undefined) {
      const current = [ticking?.requestId, ...held.map((waiter) => waiter.requestId)];
      if (current.some((id) => id !== undefined && id !== requestId)) return;
    }
    expireWaiting(agentId, sessionId);
  }

  async function apply(event: PairingEvent): Promise<PairingState> {
    const current = await load();
    const next = reducePairing(current, event);
    if (next === current) {
      // The reducer answers with the same state for the transitions that change nothing - a paired
      // agent reconnecting, a second session joining a prompt. Writing and announcing those would
      // show the owner a fresh prompt for a question already on screen (T096b).
      return current;
    }
    // Written before it is believed (003 FR-032a review F1): a failed write used to leave `loaded`
    // holding a prompt the panel was never told about, and the host's re-request then matched it as
    // "already on screen" - no card, and every call timed out. Now the failed transition is simply
    // not taken, and the next request raises it afresh.
    await deps.write(next);
    loaded = next;
    syncWaiting(next);
    deps.onChange?.(next);
    return next;
  }

  /** One answer for one agent settles every session that was waiting on that agent's prompt. */
  function settle(agentId: string, answer: PairingAnswer): void {
    const answered = waiting.filter((waiter) => waiter.agentId === agentId);
    waiting = waiting.filter((waiter) => waiter.agentId !== agentId);
    for (const waiter of answered) {
      waiter.resolve(answer);
    }
  }

  /**
   * Acts on what the external write said, rather than only noticing that it happened (004/T111g).
   *
   * A durable record saying "paired" *is* the answer the waiting sessions were holding for: the
   * writer that put it there - a repair, another worker generation, the acceptance helper the probe
   * uses - cannot reach `decide`, which is the only other thing that settles them. Without this a
   * session waits out its whole pairing bound and answers `not-paired: no answer` against a record
   * that already said it was paired. The reverse half is the announcement: an accept or a removal
   * made elsewhere is now told to the panel, so nothing keeps showing a pairing storage no longer
   * has.
   */
  function reconcile(): Promise<void> {
    return enqueue(async () => {
      const before = loaded?.paired;
      const state = await load();
      const paired = new Set(state.paired.map((agent) => agent.agentId));
      for (const agentId of new Set(waiting.map((waiter) => waiter.agentId))) {
        if (paired.has(agentId)) {
          settle(agentId, "accepted");
        }
      }
      if (state.pending && paired.has(state.pending.agentId)) {
        // The prompt has been answered, just not through the panel: leaving it up would ask the
        // owner about an agent that is already paired.
        loaded = { paired: state.paired };
        syncWaiting(loaded);
      }
      if (!before || !samePaired(before, state.paired)) {
        deps.onChange?.(loaded ?? state);
      }
    }).catch(() => undefined);
  }

  return {
    decidePairing({ sessionId, requestId, ...request }) {
      // The state change is queued; the *wait* for the owner deliberately is not. Holding the queue
      // for the length of a human decision would stop the panel's own answer from ever being
      // applied - the deadlock this shape exists to avoid.
      return enqueue(() => apply({ type: "connection", ...request })).then((state): PairingAnswer | Promise<PairingAnswer> => {
        if (!state.pending) {
          return "accepted";
        }
        // Somebody is being asked something they may not be able to see (011 FR-148). Said every
        // five seconds from here until the card leaves the panel, whichever way it leaves.
        startWaiting(state.pending.agentId, sessionId, requestId);
        // Held, not refused: the owner is being asked right now, and the host is holding the
        // agent's first tool call on exactly this answer.
        return new Promise<PairingAnswer>((resolve) => {
          /**
           * One answer per session (live finding 2026-09-24). A session that asks again has already
           * withdrawn its earlier request at the host's bound, so that request is let go as
           * `abandoned` - which the bridge answers with nothing. Answered as well, one Ignore reached
           * the host as two declines, and the second refused the session's *next* request before the
           * owner had seen it.
           */
          if (sessionId !== undefined) {
            for (const earlier of waiting.filter((waiter) => waiter.agentId === request.agentId && waiter.sessionId === sessionId)) {
              earlier.resolve("abandoned");
            }
            waiting = waiting.filter((waiter) => !(waiter.agentId === request.agentId && waiter.sessionId === sessionId));
          }
          waiting.push({
            agentId: request.agentId,
            ...(sessionId === undefined ? {} : { sessionId }),
            ...(requestId === undefined ? {} : { requestId }),
            resolve,
          });
          // Told after the push, so the count read from here includes this session.
          deps.onWaitersChange?.();
        });
      });
    },
    async decide(agentId, accepted) {
      await enqueue(() => apply({ type: "decide", agentId, accepted, at: deps.now() }));
      // Read after the queue drains: the connections that raised the prompt are ahead of this in
      // the same queue, so their waiters exist by now. A no here is the owner's Decline of this
      // request (FR-032a), which the bridge marks so the host does not take it for an unpair.
      settle(agentId, accepted ? "accepted" : "declined");
    },
    async ignore(agentId) {
      await enqueue(() => apply({ type: "ignore", agentId }));
      // Answered as a decline of this one request (006 FR-084 as amended 2026-09-24, 003 FR-032a):
      // the agent hears at once instead of waiting out the host's bound, and nothing is stored, so
      // its next call raises a fresh prompt. `settle` also empties the waiters, so none of them can
      // answer that later prompt. (Silence was right only while every refusal was permanent.)
      settle(agentId, "declined");
    },
    async unpair(agentId) {
      await enqueue(() => apply({ type: "unpair", agentId }));
      settle(agentId, "unpaired");
    },
    withdraw,
    sessionEnded(sessionId) {
      stopWaiting(sessionId);
    },
    async abandonPending() {
      await enqueue(() => apply({ type: "abandon" }));
      // Every waiting session's `decidePairing` promise must settle: an unresolved one would hold
      // its connection handler for the life of the worker. Settled as `abandoned`, not as a refusal:
      // the owner decided nothing, and the bridge answers it with nothing (FR-032a).
      for (const waiter of waiting.splice(0)) {
        waiter.resolve("abandoned");
      }
    },
    async isPaired(agentId) {
      const state = await enqueue(load);
      return state.paired.some((agent) => agent.agentId === agentId);
    },
    async state() {
      return enqueue(load);
    },
    async ready() {
      await queue;
    },
    waitingSessions(agentId) {
      return waiting.filter((waiter) => waiter.agentId === agentId).length;
    },
    panelPresenceChanged,
  };
}
