import type { WindowSize, WindowState } from "../chrome-adapters/windows.js";

/**
 * Giving a window back the way it was (008/T231, FR-118..FR-120, D-008-6, R-141).
 *
 * `resize_window` honours a size by un-maximising the window first (003 FR-045): a maximized window
 * drops the bounds without an error, so the only way to give the agent the size it asked for is to
 * take the window out of the state the owner left it in. That is a change to the owner's furniture
 * made for the agent's convenience, and it is owed back when the session lets the window go.
 *
 * No reference does this (design-notes §5) - neither bundle records a prior state at all - so the whole
 * design is ours, and the part worth being careful about is not the restoring but the four ways it
 * must *not* act. Each is a fact read at the moment of release rather than remembered, which is why
 * the decision is one pure function over three arguments: the record, the window as Chrome reports
 * it now, and how many other sessions still hold a record for that window.
 *
 * The record lives in `chrome.storage.session`, like every other per-session fact this worker keeps
 * (recordings, leases, downloads): MV3 evicts the worker between the resize and the release, and a
 * promise held in a variable would be the one thing that did not survive it.
 */

/** The states a window can be put back into; the only two `resize_window` ever has to leave. */
export type RestorableWindowState = Extract<WindowState, "maximized" | "fullscreen">;

/** One window this session un-maximised, and what it was (data-model WindowRestoreRecord). */
export type WindowRestoreRecord = {
  windowId: number;
  /** First seen wins (FR-120): a second resize by the same session changes the size, not the state. */
  priorState: RestorableWindowState;
  sessionId: string;
  /** The size the tool actually obtained, so a hand resize afterwards is recognisable. */
  setSize: WindowSize;
};

/** The window as Chrome reports it at the moment of the release; `undefined` when it is gone. */
export type WindowFacts = { state?: string | undefined; width?: number | undefined; height?: number | undefined };

export type RestoreDecision = "restore" | "drop" | "leave-to-other";

/** Where the records live; `chrome.storage.session`, so they die with the browser as the session does. */
export const AGENT_WINDOW_RESTORES_KEY = "agentWindowRestores";

/**
 * Whether this record is owed a restore right now (FR-119), in the order the spec states it.
 *
 * The order is the rule, not an implementation detail. "Already in that state" is asked before
 * "somebody else holds one" because a window that is where it belongs needs nothing from anybody,
 * and asking about the size last keeps the owner's own hand the last word: a window they resized
 * themselves after the agent did is theirs now, and putting it back would undo *their* change
 * rather than ours (D-008-6).
 *
 * A window Chrome reports without bounds is treated as a window whose size cannot be vouched for,
 * so it is dropped rather than restored: the promise this makes to the owner is "we only undo what
 * we can still see we did".
 */
export function decideRestore(
  record: WindowRestoreRecord,
  window: WindowFacts | undefined,
  othersForWindow: number,
): RestoreDecision {
  if (!window) return "drop";
  if (window.state === record.priorState) return "drop";
  if (othersForWindow > 0) return "leave-to-other";
  if (window.width !== record.setSize.width || window.height !== record.setSize.height) return "drop";
  return "restore";
}

/** The part of a storage area this module uses; `chrome.storage.session` is one. */
export type StorageAreaLike = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

export type WindowRestoreStore = {
  /** Records a window this session un-maximised, or updates the size of the one already recorded. */
  remember(record: WindowRestoreRecord): Promise<void>;
  /** Every window this session still owes something to. */
  forSession(sessionId: string): Promise<WindowRestoreRecord[]>;
  /** How many *other* sessions hold a record for this window (FR-119's "leave it to the last holder"). */
  othersForWindow(windowId: number, sessionId: string): Promise<number>;
  forget(windowId: number, sessionId: string): Promise<void>;
};

function listOf(raw: unknown): WindowRestoreRecord[] {
  return Array.isArray(raw) ? (raw as WindowRestoreRecord[]) : [];
}

/**
 * The store over one storage area, read on every call and never cached.
 *
 * Re-read rather than remembered for the reason the recorder's store is: the worker that wrote the
 * record is usually not the worker that restores the window, and a cached list would be the state
 * an eviction silently took away.
 */
export function createWindowRestoreStore(area: StorageAreaLike | undefined): WindowRestoreStore {
  async function read(): Promise<WindowRestoreRecord[]> {
    const raw = await area?.get([AGENT_WINDOW_RESTORES_KEY]);
    return listOf(raw?.[AGENT_WINDOW_RESTORES_KEY]);
  }

  async function write(records: WindowRestoreRecord[]): Promise<void> {
    await area?.set({ [AGENT_WINDOW_RESTORES_KEY]: records });
  }

  return {
    async remember(record) {
      const records = await read();
      const existing = records.findIndex(
        (candidate) => candidate.windowId === record.windowId && candidate.sessionId === record.sessionId,
      );
      if (existing === -1) {
        await write([...records, record]);
        return;
      }
      // FR-120: the first state seen is the one the owner had, whatever the window looks like by the
      // second call - by then it is "normal" because we made it so, and recording that would be
      // recording our own change.
      records[existing] = { ...records[existing]!, setSize: record.setSize };
      await write(records);
    },
    async forSession(sessionId) {
      return (await read()).filter((record) => record.sessionId === sessionId);
    },
    async othersForWindow(windowId, sessionId) {
      return (await read()).filter((record) => record.windowId === windowId && record.sessionId !== sessionId).length;
    },
    async forget(windowId, sessionId) {
      const records = await read();
      const kept = records.filter((record) => !(record.windowId === windowId && record.sessionId === sessionId));
      if (kept.length !== records.length) await write(kept);
    },
  };
}

/** The real store: `chrome.storage.session`, read lazily so composing this needs no browser. */
export function sessionWindowRestoreStore(): WindowRestoreStore {
  const area = (): StorageAreaLike | undefined =>
    typeof chrome !== "undefined" ? (chrome.storage?.session as unknown as StorageAreaLike | undefined) : undefined;
  return {
    remember: (record) => createWindowRestoreStore(area()).remember(record),
    forSession: (sessionId) => createWindowRestoreStore(area()).forSession(sessionId),
    othersForWindow: (windowId, sessionId) => createWindowRestoreStore(area()).othersForWindow(windowId, sessionId),
    forget: (windowId, sessionId) => createWindowRestoreStore(area()).forget(windowId, sessionId),
  };
}

export type WindowRestorerDeps = {
  store: WindowRestoreStore;
  /** The window as Chrome has it now; `undefined` when it is gone (`chrome-adapters/windows.ts`). */
  getWindow(windowId: number): Promise<WindowFacts | undefined>;
  setWindowState(windowId: number, state: RestorableWindowState): Promise<void>;
  /** Which windows the session still holds a tab in, asked at the moment a tab left it. */
  windowsHeldBy(sessionId: string): Promise<number[]>;
  /** The card's line about it (FR-119); the panel writes the sentence from the state word. */
  onRestored?(sessionId: string, state: RestorableWindowState): void;
  reportDiagnostic?(code: string): void;
};

export type WindowRestorer = {
  /** Every window this session owes something to, or just the one named. */
  restoreFor(sessionId: string, windowId?: number): Promise<void>;
  /** A tab left the session: every window it no longer has a tab in is given back (FR-119). */
  onTabLeft(sessionId: string): Promise<void>;
};

/**
 * The two hooks, over one decision (008/T232).
 *
 * The record is always forgotten, `leave-to-other` included, and that is the one place this differs
 * from a literal reading of FR-119. This session is not a holder of that window any more whatever
 * happens next, and a record left behind would count itself in the *other* session's own "does
 * anybody else still hold this": each would wait for the other and the window would never be given
 * back to anybody. Dropping it is what makes US4 scenario 5 true - the last one to let go restores.
 */
export function createWindowRestorer(deps: WindowRestorerDeps): WindowRestorer {
  async function restoreOne(record: WindowRestoreRecord): Promise<void> {
    const window = await deps.getWindow(record.windowId).catch(() => undefined);
    const others = await deps.store.othersForWindow(record.windowId, record.sessionId);
    if (decideRestore(record, window, others) === "restore") {
      try {
        await deps.setWindowState(record.windowId, record.priorState);
        deps.onRestored?.(record.sessionId, record.priorState);
      } catch {
        // The owner closed or moved the window between the read and the write. Nothing is broken,
        // and nothing is owed any more: the record goes either way, below.
        deps.reportDiagnostic?.("agent.window.restore-failed");
      }
    }
    await deps.store.forget(record.windowId, record.sessionId).catch(() => undefined);
  }

  return {
    async restoreFor(sessionId, windowId) {
      const records = await deps.store.forSession(sessionId).catch(() => []);
      for (const record of records) {
        if (windowId !== undefined && record.windowId !== windowId) continue;
        await restoreOne(record);
      }
    },
    async onTabLeft(sessionId) {
      const records = await deps.store.forSession(sessionId).catch(() => []);
      if (records.length === 0) return;
      // One question about the session rather than one per record: which windows it is still in.
      const held = new Set(await deps.windowsHeldBy(sessionId).catch(() => []));
      for (const record of records) {
        if (held.has(record.windowId)) continue;
        await restoreOne(record);
      }
    },
  };
}
