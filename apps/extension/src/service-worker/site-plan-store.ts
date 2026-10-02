/**
 * Where a session's approved site plan is written down (017 R-246, data-model "Session site plan").
 *
 * `chrome.storage.session`, one key with a map of session id to plan inside it - the shape the
 * transition store's per-session allowances already use. The session area is the lifetime FR-258
 * asks for: it survives an interrupt and a worker eviction, and a browser restart empties it. The
 * plan is never copied into the remembered site list (`storage.local`); the caller clears it when
 * the session ends or the agent is unpaired - the latter by the agent id each plan records, so a
 * session the worker has forgotten since a restart loses its plan too.
 *
 * A new approval replaces the session's plan and never merges with it (FR-260): what the owner
 * approved last is the whole of what the session may do without asking. Coverage is exact-origin
 * only - `https://a.com` covers neither `https://www.a.com`, `http://a.com` nor `https://a.com:8443`.
 *
 * Read on every call and never cached, for the same reason as every other session-area store here:
 * the worker that recorded the approval is often not the worker that answers the next call.
 *
 * Every write is a read of the whole map, a change and a write back, so the writes of one store go
 * through one queue (S1 architecture review): an approval and a session ending side by side must
 * both land, and a cleared plan must never come back because a slower write read the map before
 * it was cleared. One store per worker - the runtime's - is what makes that queue the only one.
 *
 * An approval that cannot be written is thrown, never swallowed (`SITE_PLAN_NOT_RECORDED`, the 014
 * `upload-directory-not-recorded` precedent): the owner's yes must not be reported as granted when
 * the next call will not find it. Reads stay closed - no area, or nothing readable, is no plan.
 */

/** What `set` throws when there is no storage area to write the approval to. */
export const SITE_PLAN_NOT_RECORDED = "site-plan-not-recorded";

/** Per-session plans. `chrome.storage.session`: dies with the browser, cleared with the session. */
export const AGENT_SESSION_SITE_PLANS_KEY = "agentSessionSitePlans";

export type SessionSitePlan = {
  origins: string[];
  approvedAt: string;
  /**
   * The agent whose session it is, so an unpair can clear it without the session being in the
   * worker's memory (a worker restart forgets every session until it greets again). A record that
   * names no agent is read as no plan: nothing could ever unpair it.
   */
  agentId: string;
};

/** The part of a storage area this module uses. */
export type StorageAreaLike = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

export type SitePlanStore = {
  /** The session's active plan, or `undefined` when it has none. */
  forSession(sessionId: string): Promise<SessionSitePlan | undefined>;
  /**
   * Approve a plan for the session, replacing any earlier one (FR-260). Rejects when it was not
   * written: with `SITE_PLAN_NOT_RECORDED` when there is no area, or with the area's own error.
   */
  set(sessionId: string, origins: readonly string[], agentId: string): Promise<void>;
  /**
   * Whether the session's plan names exactly this origin and was approved for this agent. A session
   * id carries no proof of who is behind it: another paired agent can greet under one this worker
   * knows, and the owner's yes was to the agent they were shown (017 review M1).
   */
  covers(sessionId: string, origin: string, agentId: string): Promise<boolean>;
  /** The session ended or the owner withdrew the plan: its plan goes, and nobody else's. */
  clear(sessionId: string): Promise<void>;
  /** Several sessions ended at once: their plans go, and nobody else's. */
  clearMany(sessionIds: readonly string[]): Promise<void>;
  /** The agent was unpaired: every plan recorded for it goes, whether or not its session is known. */
  clearAgent(agentId: string): Promise<void>;
};

export type SitePlanStoreDeps = {
  /** Defaults to `chrome.storage.session`, looked up on each call so composing needs no browser. */
  session?: StorageAreaLike | undefined;
  now?: () => string;
};

type SessionPlans = Record<string, SessionSitePlan>;

/** A canonical origin: parses, is not opaque, and is already its own origin (no path, no slash). */
function isOrigin(value: string): boolean {
  try {
    const origin = new URL(value).origin;
    return origin !== "null" && origin === value;
  } catch {
    return false;
  }
}

function isPlan(value: unknown): value is SessionSitePlan {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.origins) &&
    record.origins.every((origin) => typeof origin === "string") &&
    typeof record.approvedAt === "string" &&
    typeof record.agentId === "string"
  );
}

function chromeSessionArea(): StorageAreaLike | undefined {
  return typeof chrome === "undefined"
    ? undefined
    : (chrome.storage?.session as unknown as StorageAreaLike | undefined);
}

export function createSitePlanStore(deps: SitePlanStoreDeps = {}): SitePlanStore {
  const stamp = deps.now ?? ((): string => new Date().toISOString());
  const area = (): StorageAreaLike | undefined => ("session" in deps ? deps.session : chromeSessionArea());

  /** Malformed data reads as no plan: a record that is not a plan cannot authorise anything. */
  async function read(): Promise<SessionPlans> {
    const raw = await area()?.get([AGENT_SESSION_SITE_PLANS_KEY]);
    const value = raw?.[AGENT_SESSION_SITE_PLANS_KEY];
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const plans: SessionPlans = {};
    for (const [sessionId, plan] of Object.entries(value)) {
      if (isPlan(plan)) {
        plans[sessionId] = { origins: [...plan.origins], approvedAt: plan.approvedAt, agentId: plan.agentId };
      }
    }
    return plans;
  }

  async function write(plans: SessionPlans): Promise<void> {
    await area()?.set({ [AGENT_SESSION_SITE_PLANS_KEY]: plans });
  }

  /** One write at a time; a failed one rejects its own caller and never stops the next. */
  let writes: Promise<unknown> = Promise.resolve();
  function serialised(job: () => Promise<void>): Promise<void> {
    const next = writes.then(job, job);
    writes = next.catch(() => undefined);
    return next;
  }

  return {
    async forSession(sessionId) {
      return (await read())[sessionId];
    },
    set(sessionId, origins, agentId) {
      return serialised(async () => {
        if (area() === undefined) throw new Error(SITE_PLAN_NOT_RECORDED);
        const plans = await read();
        plans[sessionId] = { origins: [...origins], approvedAt: stamp(), agentId };
        await write(plans);
      });
    },
    async covers(sessionId, origin, agentId) {
      if (!isOrigin(origin) || agentId.length === 0) return false;
      const plan = (await read())[sessionId];
      return plan !== undefined && plan.agentId === agentId && plan.origins.includes(origin);
    },
    clear(sessionId) {
      return serialised(async () => {
        const plans = await read();
        if (!(sessionId in plans)) return;
        delete plans[sessionId];
        await write(plans);
      });
    },
    clearMany(sessionIds) {
      return serialised(async () => {
        const plans = await read();
        let dropped = false;
        for (const sessionId of sessionIds) {
          if (!(sessionId in plans)) continue;
          delete plans[sessionId];
          dropped = true;
        }
        if (dropped) await write(plans);
      });
    },
    clearAgent(agentId) {
      return serialised(async () => {
        const plans = await read();
        const mine = Object.keys(plans).filter((sessionId) => plans[sessionId]?.agentId === agentId);
        if (mine.length === 0) return;
        for (const sessionId of mine) delete plans[sessionId];
        await write(plans);
      });
    },
  };
}
