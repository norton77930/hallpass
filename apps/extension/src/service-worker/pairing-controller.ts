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
   * The owner's Ignore (006 FR-084): the prompt goes, and nothing is decided. Unlike a decline the
   * agent is not answered, so the request expires at the host's own bound and is raised again by
   * its next call - the owner was away for one question, not saying no to the agent.
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
};

export type PairingController = {
  /**
   * The bridge's answer to one `pair-request`. Resolves immediately for a paired agent and
   * otherwise not until the owner answers the prompt.
   */
  decidePairing: (request: PendingPairing) => Promise<boolean>;
  /** The panel's answer to the prompt. */
  decide: (agentId: string, accepted: boolean) => Promise<void>;
  /** The panel's Ignore (006 FR-084): the prompt goes and the waiting sessions are told nothing. */
  ignore: (agentId: string) => Promise<void>;
  unpair: (agentId: string) => Promise<void>;
  /** The link dropped: forget the prompt it raised and refuse the call that was waiting on it. */
  abandonPending: () => Promise<void>;
  isPaired: (agentId: string) => Promise<boolean>;
  state: () => Promise<PairingState>;
  /** Resolves once every state change asked for so far has been written. */
  ready: () => Promise<void>;
};

export function createPairingController(deps: PairingControllerDeps): PairingController {
  let loaded: PairingState | undefined;
  /**
   * One entry per session waiting on a prompt, resolved by the panel's decision. It is a list
   * because several sessions of one agent connect at once (D-004-2) and every one of them is
   * holding a tool call on the same single answer.
   */
  let waiting: { agentId: string; resolve: (accepted: boolean) => void }[] = [];
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

  async function apply(event: PairingEvent): Promise<PairingState> {
    const current = await load();
    const next = reducePairing(current, event);
    if (next === current) {
      // The reducer answers with the same state for the transitions that change nothing - a paired
      // agent reconnecting, a second session joining a prompt. Writing and announcing those would
      // show the owner a fresh prompt for a question already on screen (T096b).
      return current;
    }
    loaded = next;
    await deps.write(next);
    deps.onChange?.(next);
    return next;
  }

  /** One answer for one agent settles every session that was waiting on that agent's prompt. */
  function settle(agentId: string, accepted: boolean): void {
    const answered = waiting.filter((waiter) => waiter.agentId === agentId);
    waiting = waiting.filter((waiter) => waiter.agentId !== agentId);
    for (const waiter of answered) {
      waiter.resolve(accepted);
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
          settle(agentId, true);
        }
      }
      if (state.pending && paired.has(state.pending.agentId)) {
        // The prompt has been answered, just not through the panel: leaving it up would ask the
        // owner about an agent that is already paired.
        loaded = { paired: state.paired };
      }
      if (!before || !samePaired(before, state.paired)) {
        deps.onChange?.(loaded ?? state);
      }
    }).catch(() => undefined);
  }

  return {
    decidePairing(request) {
      // The state change is queued; the *wait* for the owner deliberately is not. Holding the queue
      // for the length of a human decision would stop the panel's own answer from ever being
      // applied - the deadlock this shape exists to avoid.
      return enqueue(() => apply({ type: "connection", ...request })).then((state) => {
        if (!state.pending) {
          return true;
        }
        // Held, not refused: the owner is being asked right now, and the host is holding the
        // agent's first tool call on exactly this answer.
        return new Promise<boolean>((resolve) => {
          waiting.push({ agentId: request.agentId, resolve });
        });
      });
    },
    async decide(agentId, accepted) {
      await enqueue(() => apply({ type: "decide", agentId, accepted, at: deps.now() }));
      // Read after the queue drains: the connections that raised the prompt are ahead of this in
      // the same queue, so their waiters exist by now.
      settle(agentId, accepted);
    },
    async ignore(agentId) {
      await enqueue(() => apply({ type: "ignore", agentId }));
      // Dropped, not settled: an answer here would be a decision the owner did not make. The
      // host's own bound withdraws the request, and the next one raises a fresh prompt with fresh
      // waiters - an old waiter left here would answer that later prompt twice.
      waiting = waiting.filter((waiter) => waiter.agentId !== agentId);
    },
    async unpair(agentId) {
      await enqueue(() => apply({ type: "unpair", agentId }));
      settle(agentId, false);
    },
    async abandonPending() {
      await enqueue(() => apply({ type: "abandon" }));
      // Every waiting session's `decidePairing` promise must settle: an unresolved one would hold
      // its connection handler for the life of the worker.
      for (const waiter of waiting.splice(0)) {
        waiter.resolve(false);
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
  };
}
