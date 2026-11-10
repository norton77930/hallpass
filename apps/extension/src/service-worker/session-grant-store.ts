/**
 * What the owner allowed a session to do on a site "for this session" (031 R-456, data-model
 * "Session grant").
 *
 * Its own store, not the 017 site plan: a plan is replaced whole by each approval, so a grant kept
 * there would erase an approved proposal. `chrome.storage.session`, one key with a map of session id
 * to that session's grants - it survives an interrupt and a worker eviction and dies with the browser,
 * as the site plan does.
 *
 * Entries are only ever added. Adding the same session, site and kind again keeps the first entry
 * (its `grantedAt` and `source` stand): a grant is a fact about when and how the owner first said
 * yes, and a repeat must not rewrite that. Coverage is exact-origin and exact-kind within one
 * session: a `diagnostics` grant never satisfies a page action and the other way round.
 *
 * Each session's record names its agent, so an unpair clears by agent even for a session this worker
 * has forgotten since a restart, and a read answers only for the agent it was recorded for: another
 * agent asking under the same session id reads no grants, and its first add replaces the record. A
 * record that names no agent is read as no grants.
 *
 * Read on every call and never cached; every write is a read of the whole map, a change and a write
 * back, so one store's writes go through one queue (the site plan store's reasoning). An add that
 * cannot be written is thrown (`SESSION_GRANT_NOT_RECORDED` when there is no area), never swallowed:
 * the owner's yes must not be reported as granted when the next call will not find it. Reads stay
 * closed: no area, or nothing readable, is no grant.
 */

/** What `add` throws when there is no storage area to write the grant to. */
export const SESSION_GRANT_NOT_RECORDED = "session-grant-not-recorded";

/** Per-session grants. `chrome.storage.session`: dies with the browser, cleared with the session. */
export const AGENT_SESSION_GRANTS_KEY = "agentSessionGrants";

export type SessionGrantKind = "page-actions" | "diagnostics";
export type SessionGrantSource = "client" | "browser";

export type SessionGrant = {
  sessionId: string;
  /** A full canonical origin. */
  site: string;
  kind: SessionGrantKind;
  source: SessionGrantSource;
  /** Epoch ms. */
  grantedAt: number;
};

/** What a caller says about a grant; the session, the agent and the time come from the store's call. */
export type SessionGrantInput = {
  site: string;
  kind: SessionGrantKind;
  source: SessionGrantSource;
};

/** The part of a storage area this module uses. */
export type StorageAreaLike = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

export type SessionGrantStore = {
  /**
   * Record a grant for the session and its agent. An entry for the same site and kind already there
   * is kept as it is. A record this session id holds for another agent is replaced, never merged
   * into: it is another agent's session, and as the site plan's `set` does, the new agent's record is
   * the whole of it. Rejects when it was not written: with `SESSION_GRANT_NOT_RECORDED` when there is
   * no area, or with the area's own error.
   */
  add(sessionId: string, agentId: string, grant: SessionGrantInput): Promise<void>;
  /**
   * Whether this session holds a grant of this kind for exactly this origin, recorded for this agent.
   * A session id carries no proof of who is behind it: after a restart another paired agent can greet
   * under a stored one, and the owner's yes was to the agent they were shown (the site plan's rule,
   * 017 review M1).
   */
  covers(sessionId: string, agentId: string, site: string, kind: SessionGrantKind): Promise<boolean>;
  /** The session's grants recorded for this agent, in the order they were added, for the side panel. */
  list(sessionId: string, agentId: string): Promise<SessionGrant[]>;
  /** The session ended: its grants go, and nobody else's. */
  clearSession(sessionId: string): Promise<void>;
  /** The agent was unpaired: every grant recorded for it goes, whether or not its session is known. */
  clearAgent(agentId: string): Promise<void>;
  /**
   * The owner revoked the site (032 R-487, FR-490): every grant of either kind for exactly this
   * origin goes, in every session and for every agent; grants on other sites stay.
   */
  forgetSite(site: string): Promise<void>;
};

export type SessionGrantStoreDeps = {
  /** Defaults to `chrome.storage.session`, looked up on each call so composing needs no browser. */
  session?: StorageAreaLike | undefined;
  /** Epoch ms. */
  now?: () => number;
};

type StoredGrant = Omit<SessionGrant, "sessionId">;
type StoredSession = { agentId: string; grants: StoredGrant[] };
type SessionGrants = Record<string, StoredSession>;

/** A canonical origin: parses, is not opaque, and is already its own origin (no path, no slash). */
function isOrigin(value: string): boolean {
  try {
    const origin = new URL(value).origin;
    return origin !== "null" && origin === value;
  } catch {
    return false;
  }
}

function isStoredGrant(value: unknown): value is StoredGrant {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.site === "string" &&
    (record.kind === "page-actions" || record.kind === "diagnostics") &&
    (record.source === "client" || record.source === "browser") &&
    typeof record.grantedAt === "number"
  );
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.agentId === "string" && Array.isArray(record.grants) && record.grants.every(isStoredGrant);
}

function chromeSessionArea(): StorageAreaLike | undefined {
  return typeof chrome === "undefined"
    ? undefined
    : (chrome.storage?.session as unknown as StorageAreaLike | undefined);
}

export function createSessionGrantStore(deps: SessionGrantStoreDeps = {}): SessionGrantStore {
  const stamp = deps.now ?? ((): number => Date.now());
  const area = (): StorageAreaLike | undefined => ("session" in deps ? deps.session : chromeSessionArea());

  /** Malformed data reads as no grants: a record that is not a grant cannot authorise anything. */
  async function read(): Promise<SessionGrants> {
    const raw = await area()?.get([AGENT_SESSION_GRANTS_KEY]);
    const value = raw?.[AGENT_SESSION_GRANTS_KEY];
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const sessions: SessionGrants = {};
    for (const [sessionId, session] of Object.entries(value)) {
      if (isStoredSession(session)) {
        sessions[sessionId] = {
          agentId: session.agentId,
          grants: session.grants.map((grant) => ({
            site: grant.site,
            kind: grant.kind,
            source: grant.source,
            grantedAt: grant.grantedAt,
          })),
        };
      }
    }
    return sessions;
  }

  async function write(sessions: SessionGrants): Promise<void> {
    await area()?.set({ [AGENT_SESSION_GRANTS_KEY]: sessions });
  }

  /** One write at a time; a failed one rejects its own caller and never stops the next. */
  let writes: Promise<unknown> = Promise.resolve();
  function serialised(job: () => Promise<void>): Promise<void> {
    const next = writes.then(job, job);
    writes = next.catch(() => undefined);
    return next;
  }

  return {
    add(sessionId, agentId, grant) {
      return serialised(async () => {
        if (area() === undefined) throw new Error(SESSION_GRANT_NOT_RECORDED);
        const sessions = await read();
        const stored = sessions[sessionId];
        const held = stored !== undefined && stored.agentId === agentId ? stored : { agentId, grants: [] };
        if (held.grants.some((entry) => entry.site === grant.site && entry.kind === grant.kind)) return;
        held.grants.push({ site: grant.site, kind: grant.kind, source: grant.source, grantedAt: stamp() });
        sessions[sessionId] = held;
        await write(sessions);
      });
    },
    async covers(sessionId, agentId, site, kind) {
      if (!isOrigin(site) || agentId.length === 0) return false;
      const held = (await read())[sessionId];
      return (
        held !== undefined &&
        held.agentId === agentId &&
        held.grants.some((entry) => entry.site === site && entry.kind === kind)
      );
    },
    async list(sessionId, agentId) {
      if (agentId.length === 0) return [];
      const held = (await read())[sessionId];
      if (held === undefined || held.agentId !== agentId) return [];
      return held.grants.map((grant) => ({ sessionId, ...grant }));
    },
    clearSession(sessionId) {
      return serialised(async () => {
        const sessions = await read();
        if (!(sessionId in sessions)) return;
        delete sessions[sessionId];
        await write(sessions);
      });
    },
    clearAgent(agentId) {
      return serialised(async () => {
        const sessions = await read();
        const mine = Object.keys(sessions).filter((sessionId) => sessions[sessionId]?.agentId === agentId);
        if (mine.length === 0) return;
        for (const sessionId of mine) delete sessions[sessionId];
        await write(sessions);
      });
    },
    forgetSite(site) {
      return serialised(async () => {
        const sessions = await read();
        let dropped = false;
        for (const held of Object.values(sessions)) {
          // The comparison `covers` makes: exact origin.
          const kept = held.grants.filter((entry) => entry.site !== site);
          if (kept.length === held.grants.length) continue;
          held.grants = kept;
          dropped = true;
        }
        if (dropped) await write(sessions);
      });
    },
  };
}
