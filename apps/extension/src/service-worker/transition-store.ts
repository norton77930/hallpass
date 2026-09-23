import type { TabTransitionState } from "./agent-tools/transitions.js";

/**
 * Where a transition's three lifetimes are written down (014 data-model, FR-185, FR-190).
 *
 * Three stores, because the three facts die at three different moments and the moments are the
 * product decision:
 *
 * - a tab's own state (`chrome.storage.session`) dies with the lease, because it is a fact about
 *   one session driving one tab, and an eviction of the worker in the middle of that must not lose
 *   it - a recycled worker that forgot where the tab had been would ask the owner about a move
 *   they had already answered;
 * - a session's allowed pairs (`chrome.storage.session`) die with the session, because 繼續 means
 *   "for the rest of this session" and nothing longer;
 * - the owner's remembered pairs (`chrome.storage.local`) outlive the browser, because 一律允許 is
 *   a durable decision, and they are listed and revoked on the panel (FR-191).
 *
 * Only origins and timestamps are written, ever. Not a url, not a title, not a word of a page
 * (FR-190): what is remembered is that this owner expects this site to hand the session to that
 * one, which needs nothing else to be meaningful.
 *
 * Each area holds *one* key with a map or a list inside it rather than a key per record. That is
 * the shape `window-restore.ts` and `site-mode-store.ts` already use here, and it is what lets a
 * tab's state be dropped by id alone: the lease that ends names the tab and not the session, and
 * enumerating a storage area to find the rest of the key would be a read of everything the
 * extension has ever stored.
 */

/** Per-session, per-tab state. `chrome.storage.session`: it dies with the browser, as a session does. */
export const AGENT_TRANSITIONS_KEY = "agentTransitions";
/** The pairs each live session has been told 繼續 about. Same area, same lifetime. */
export const AGENT_TRANSITIONS_ALLOWED_KEY = "agentTransitionsAllowed";
/** The owner's remembered pairs (contracts/transitions.md): `chrome.storage.local`, listed on the panel. */
export const AGENT_TRANSITION_ALLOWANCES_KEY = "agentTransitionAllowances";
/**
 * The gate's switch (contracts/transitions.md, R-186 §6): rule (a) off, so a loopback fixture can
 * stand in for a real cross-site move. Never written by the product - only a gate sets it, and all
 * it can do is make the product ask about *more* than it would otherwise.
 */
export const AGENT_TRANSITIONS_TEST_SWITCH_KEY = "agentTransitionsTestNoLoopbackExemption";

/** One remembered pair, exactly as `AgentPanelState.transitions` carries it. */
export type TransitionAllowance = {
  from: string;
  to: string;
  allowedAt: string;
  lastUsedAt?: string;
};

/** The part of a storage area this module uses; `chrome.storage.session` and `.local` are two. */
export type StorageAreaLike = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

export type TransitionStore = {
  stateOf(sessionId: string, tabId: number): Promise<TabTransitionState | undefined>;
  save(sessionId: string, tabId: number, state: TabTransitionState): Promise<void>;
  /** The lease ended: the tab's state goes, for whichever session held it. */
  forgetTab(tabId: number): Promise<void>;
  /** The session ended: its tabs' states and its allowed pairs go, and nobody else's. */
  forgetSession(sessionId: string): Promise<void>;
  allowsForSession(sessionId: string, from: string, to: string): Promise<boolean>;
  allowForSession(sessionId: string, from: string, to: string): Promise<void>;
  /** The owner's remembered pairs, for the panel's rows and for rule (d). */
  allowances(): Promise<TransitionAllowance[]>;
  remember(from: string, to: string): Promise<void>;
  /** Rule (d) used a remembered pair; `false` when there was none to touch. */
  touch(from: string, to: string): Promise<boolean>;
  forget(from: string, to: string): Promise<void>;
  /** Whether rule (a) is on: true unless a gate has set the switch. */
  loopbackExempt(): Promise<boolean>;
};

export type TransitionStoreDeps = {
  session: StorageAreaLike | undefined;
  local: StorageAreaLike | undefined;
  now?: () => string;
};

type TabStates = Record<string, TabTransitionState>;
type SessionAllowed = Record<string, string[]>;

function tabKey(sessionId: string, tabId: number): string {
  return `${sessionId}:${tabId}`;
}

function pairKey(from: string, to: string): string {
  return `${from}→${to}`;
}

/**
 * The store over two areas, read on every call and never cached.
 *
 * Re-read rather than remembered for the reason every other session-area store here is: the worker
 * that recorded the move is often not the worker that answers the next call, and a cached map is
 * exactly the state an eviction takes away silently.
 */
export function createTransitionStore(deps: TransitionStoreDeps): TransitionStore {
  const stamp = deps.now ?? ((): string => new Date().toISOString());

  async function readTabs(): Promise<TabStates> {
    const raw = await deps.session?.get([AGENT_TRANSITIONS_KEY]);
    const value = raw?.[AGENT_TRANSITIONS_KEY];
    return typeof value === "object" && value !== null ? ({ ...value } as TabStates) : {};
  }

  async function writeTabs(states: TabStates): Promise<void> {
    await deps.session?.set({ [AGENT_TRANSITIONS_KEY]: states });
  }

  async function readAllowed(): Promise<SessionAllowed> {
    const raw = await deps.session?.get([AGENT_TRANSITIONS_ALLOWED_KEY]);
    const value = raw?.[AGENT_TRANSITIONS_ALLOWED_KEY];
    return typeof value === "object" && value !== null ? ({ ...value } as SessionAllowed) : {};
  }

  async function readAllowances(): Promise<TransitionAllowance[]> {
    const raw = await deps.local?.get([AGENT_TRANSITION_ALLOWANCES_KEY]);
    const value = raw?.[AGENT_TRANSITION_ALLOWANCES_KEY];
    return Array.isArray(value) ? ([...value] as TransitionAllowance[]) : [];
  }

  async function writeAllowances(records: TransitionAllowance[]): Promise<void> {
    await deps.local?.set({ [AGENT_TRANSITION_ALLOWANCES_KEY]: records });
  }

  return {
    async stateOf(sessionId, tabId) {
      return (await readTabs())[tabKey(sessionId, tabId)];
    },
    async save(sessionId, tabId, state) {
      const states = await readTabs();
      states[tabKey(sessionId, tabId)] = state;
      await writeTabs(states);
    },
    async forgetTab(tabId) {
      const states = await readTabs();
      const suffix = `:${tabId}`;
      let dropped = false;
      for (const key of Object.keys(states)) {
        if (!key.endsWith(suffix)) continue;
        delete states[key];
        dropped = true;
      }
      if (dropped) await writeTabs(states);
    },
    async forgetSession(sessionId) {
      const states = await readTabs();
      const prefix = `${sessionId}:`;
      let dropped = false;
      for (const key of Object.keys(states)) {
        if (!key.startsWith(prefix)) continue;
        delete states[key];
        dropped = true;
      }
      if (dropped) await writeTabs(states);
      const allowed = await readAllowed();
      if (sessionId in allowed) {
        delete allowed[sessionId];
        await deps.session?.set({ [AGENT_TRANSITIONS_ALLOWED_KEY]: allowed });
      }
    },
    async allowsForSession(sessionId, from, to) {
      return ((await readAllowed())[sessionId] ?? []).includes(pairKey(from, to));
    },
    async allowForSession(sessionId, from, to) {
      const allowed = await readAllowed();
      const pairs = allowed[sessionId] ?? [];
      const pair = pairKey(from, to);
      if (pairs.includes(pair)) return;
      allowed[sessionId] = [...pairs, pair];
      await deps.session?.set({ [AGENT_TRANSITIONS_ALLOWED_KEY]: allowed });
    },
    allowances: readAllowances,
    async remember(from, to) {
      const records = await readAllowances();
      // The first yes is the one that is dated: a second 一律允許 on a pair the owner already
      // allowed is the same decision, and re-dating it would hide how old the permission is.
      if (records.some((record) => record.from === from && record.to === to)) return;
      await writeAllowances([...records, { from, to, allowedAt: stamp() }]);
    },
    async touch(from, to) {
      const records = await readAllowances();
      const index = records.findIndex((record) => record.from === from && record.to === to);
      // Never a write for a pair nobody remembered: this list grows by the owner's answer alone.
      if (index === -1) return false;
      records[index] = { ...(records[index] as TransitionAllowance), lastUsedAt: stamp() };
      await writeAllowances(records);
      return true;
    },
    async forget(from, to) {
      const records = await readAllowances();
      const kept = records.filter((record) => !(record.from === from && record.to === to));
      if (kept.length !== records.length) await writeAllowances(kept);
    },
    async loopbackExempt() {
      const raw = await deps.local?.get([AGENT_TRANSITIONS_TEST_SWITCH_KEY]);
      return raw?.[AGENT_TRANSITIONS_TEST_SWITCH_KEY] !== true;
    },
  };
}

/** The real store: the browser's own areas, read lazily so composing this needs no browser. */
export function chromeTransitionStore(): TransitionStore {
  const areas = (): TransitionStoreDeps => ({
    session:
      typeof chrome === "undefined" ? undefined : (chrome.storage?.session as unknown as StorageAreaLike | undefined),
    local: typeof chrome === "undefined" ? undefined : (chrome.storage?.local as unknown as StorageAreaLike | undefined),
  });
  return {
    stateOf: (sessionId, tabId) => createTransitionStore(areas()).stateOf(sessionId, tabId),
    save: (sessionId, tabId, state) => createTransitionStore(areas()).save(sessionId, tabId, state),
    forgetTab: (tabId) => createTransitionStore(areas()).forgetTab(tabId),
    forgetSession: (sessionId) => createTransitionStore(areas()).forgetSession(sessionId),
    allowsForSession: (sessionId, from, to) => createTransitionStore(areas()).allowsForSession(sessionId, from, to),
    allowForSession: (sessionId, from, to) => createTransitionStore(areas()).allowForSession(sessionId, from, to),
    allowances: () => createTransitionStore(areas()).allowances(),
    remember: (from, to) => createTransitionStore(areas()).remember(from, to),
    touch: (from, to) => createTransitionStore(areas()).touch(from, to),
    forget: (from, to) => createTransitionStore(areas()).forget(from, to),
    loopbackExempt: () => createTransitionStore(areas()).loopbackExempt(),
  };
}
