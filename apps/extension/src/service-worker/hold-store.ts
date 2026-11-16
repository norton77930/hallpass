/**
 * Where a page-Stop hold is written down (034 R-513, data-model "Hold").
 *
 * `chrome.storage.session`, one key with a map of session id to hold inside it - the shape the
 * site-plan store uses. The session area survives a worker eviction, and a browser restart empties
 * it, so a hold lives no longer than the browser does. The caller keeps a memory mirror (the check
 * on every tool call is synchronous) and loads this store into it once at worker start; this store
 * is what lets a hold outlive the worker that set it (US3).
 *
 * Nothing here lifts a hold on its own: the caller deletes it on Resume, when the session ends and
 * on unpair (R-514). A hold names the time it was set, the tab the press came from and whether the
 * worker that handled the press knew the session, and nothing else (spec Key Entities).
 *
 * Every write is a read of the whole map, a change and a write back, so the writes of one store go
 * through one queue, as in the site-plan store: a Stop and a session ending side by side must both
 * land, and a deleted hold must never come back because a slower write read the map before it was
 * deleted. Reads stay closed - no area, or nothing readable, is no hold.
 */

/** Per-session holds. `chrome.storage.session`: dies with the browser, deleted with the session. */
export const AGENT_SESSION_HOLDS_KEY = "agentSessionHolds";

export type SessionHold = {
  /** ISO time the accepted Stop press was handled. */
  at: string;
  /** The tab the press came from (`sender.tab.id`); informational. */
  tabId: number;
  /**
   * Whether the worker that handled the press had the session registered (review round 4) - the
   * owner's side of the record, never anything a greeting says. Only a hold set while the session
   * was not known may be dropped by a greeting, and only by its first one (R-514, FR-519). A record
   * written before the field existed reads as `false`.
   */
  sessionKnown: boolean;
};

/** The part of a storage area this module uses. */
export type StorageAreaLike = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

export type HoldStore = {
  /** The session's hold, or `undefined` when it is not held. */
  get(sessionId: string): Promise<SessionHold | undefined>;
  /** Every hold, keyed by session id. */
  load(): Promise<Record<string, SessionHold>>;
  /** Record the session's hold, replacing any earlier record of it. */
  set(sessionId: string, hold: SessionHold): Promise<void>;
  /** The session was resumed or ended: its hold goes, and nobody else's. */
  delete(sessionId: string): Promise<void>;
  /** Several sessions ended at once: their holds go, and nobody else's. */
  deleteMany(sessionIds: readonly string[]): Promise<void>;
};

export type HoldStoreDeps = {
  /** Defaults to `chrome.storage.session`, looked up on each call so composing needs no browser. */
  session?: StorageAreaLike | undefined;
};

type SessionHolds = Record<string, SessionHold>;

/**
 * Keyed by any session id, `__proto__` included (review N3): a session id is the agent's to choose,
 * and on an ordinary object that one key would set the prototype rather than hold a record.
 */
function emptyHolds(): SessionHolds {
  return Object.create(null) as SessionHolds;
}

/**
 * The time the store itself writes - `Date#toISOString`, exactly - and nothing looser (review N3).
 * It is shown on the session card as `heldAt`, an ISO date-time, so a record whose time is not one
 * is malformed and reads as no hold, as other malformed data does.
 */
function isHeldAt(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

function isHold(value: unknown): value is { at: string; tabId: number; sessionKnown?: boolean } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isHeldAt(record.at) &&
    typeof record.tabId === "number" &&
    Number.isInteger(record.tabId) &&
    (record.sessionKnown === undefined || typeof record.sessionKnown === "boolean")
  );
}

/** A copy with only the record's own fields; no `sessionKnown` (an earlier build's record) is `false`. */
function holdOf(hold: { at: string; tabId: number; sessionKnown?: boolean | undefined }): SessionHold {
  return { at: hold.at, tabId: hold.tabId, sessionKnown: hold.sessionKnown === true };
}

function chromeSessionArea(): StorageAreaLike | undefined {
  return typeof chrome === "undefined"
    ? undefined
    : (chrome.storage?.session as unknown as StorageAreaLike | undefined);
}

export function createHoldStore(deps: HoldStoreDeps = {}): HoldStore {
  const area = (): StorageAreaLike | undefined => ("session" in deps ? deps.session : chromeSessionArea());

  /** Malformed data - a `sessionKnown` that is there and not a boolean included - reads as no hold. */
  async function read(): Promise<SessionHolds> {
    const raw = await area()?.get([AGENT_SESSION_HOLDS_KEY]);
    const value = raw?.[AGENT_SESSION_HOLDS_KEY];
    if (typeof value !== "object" || value === null || Array.isArray(value)) return emptyHolds();
    const holds = emptyHolds();
    for (const [sessionId, hold] of Object.entries(value)) {
      if (isHold(hold)) holds[sessionId] = holdOf(hold);
    }
    return holds;
  }

  async function write(holds: SessionHolds): Promise<void> {
    await area()?.set({ [AGENT_SESSION_HOLDS_KEY]: holds });
  }

  /** One write at a time; a failed one rejects its own caller and never stops the next. */
  let writes: Promise<unknown> = Promise.resolve();
  function serialised(job: () => Promise<void>): Promise<void> {
    const next = writes.then(job, job);
    writes = next.catch(() => undefined);
    return next;
  }

  return {
    async get(sessionId) {
      return (await read())[sessionId];
    },
    load() {
      return read();
    },
    set(sessionId, hold) {
      return serialised(async () => {
        const holds = await read();
        holds[sessionId] = holdOf(hold);
        await write(holds);
      });
    },
    delete(sessionId) {
      return serialised(async () => {
        const holds = await read();
        if (!(sessionId in holds)) return;
        delete holds[sessionId];
        await write(holds);
      });
    },
    deleteMany(sessionIds) {
      return serialised(async () => {
        const holds = await read();
        let dropped = false;
        for (const sessionId of sessionIds) {
          if (!(sessionId in holds)) continue;
          delete holds[sessionId];
          dropped = true;
        }
        if (dropped) await write(holds);
      });
    },
  };
}
