import { measureViewport } from "./agent-tools/computer.js";
import type { AgentInputAttachments, InputUnavailableReason } from "./agent-tools/input.js";

/**
 * The size a page is laid out at, when it is not the window's (012/T306, US1, FR-156, FR-159,
 * FR-160, R-166, R-167).
 *
 * `resize_window` changes the owner's furniture to answer "how does this look on a phone"; this
 * changes only what the page believes, through `Emulation.setDeviceMetricsOverride` on the debugger
 * attachment the session already makes for input. The window keeps its position, its state and its
 * size, and the agent gets the layout it asked about.
 *
 * **Why the clear is explicit.** The reference reading assumed detaching the debugger drops an
 * emulation. R-166 measured the opposite on Chromium 151: a page set to 500 px was still 500 px two
 * and a half seconds after `chrome.debugger.detach`, and only a reload put it back. So an emulation
 * that is not cleared *before* the detach outlives the session that asked for it, and the owner is
 * left with a page laid out for a phone on a tab they were handed back. That is what `onBeforeRelease`
 * is for, and it is why there is a fourth attachment holder: the attachment has to last exactly as
 * long as the emulation does, so that there is something to send the clear over.
 *
 * **Why the record is in storage.** MV3 evicts the worker between the `set` and the release, and
 * Chrome keeps both the emulation and the extension's attachments across the eviction. A promise
 * held in a variable would be the one thing that did not survive it, so the record lives in
 * `chrome.storage.session` exactly as `window-restore.ts`'s does, and the next `acquire` on the tab
 * re-applies what the record says (`onAttached`) rather than leaving Chrome and this worker
 * disagreeing about the page.
 */

/** Where the records live; `chrome.storage.session`, so they die with the browser as the session does. */
export const AGENT_VIEWPORTS_KEY = "agentViewports";

/** One emulated tab (data-model ViewportRecord). */
export type ViewportRecord = {
  tabId: number;
  /** The session that set it; only that session may reset it (ownership, as every tab tool). */
  sessionId: string;
  width: number;
  height: number;
  setAt: number;
};

export type ViewportSize = { width: number; height: number };

/** What giving a page back its own size costs, decided before anything is sent (data-model). */
export type ClearDecision = "nothing" | "send-clear" | "attach-clear-detach";

/**
 * Whether there is an emulation to clear, and whether an attachment has to be made to clear it.
 *
 * Pure, and over the two facts that decide it, because the second one is the eviction case: the
 * record says the page is emulated and this worker has no attachment on the tab, which is a
 * perfectly ordinary state after MV3 put the worker to sleep. Skipping the clear there would leave
 * the page the wrong size for as long as it is open.
 */
export function decideClear(record: ViewportRecord | undefined, attached: boolean): ClearDecision {
  if (!record) return "nothing";
  return attached ? "send-clear" : "attach-clear-detach";
}

/** The part of a storage area this module uses; `chrome.storage.session` is one. */
export type StorageAreaLike = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

export type ViewportStore = {
  /** Records an emulated tab, or replaces the record a second `set` on the same tab covers. */
  remember(record: ViewportRecord): Promise<void>;
  forTab(tabId: number): Promise<ViewportRecord | undefined>;
  forget(tabId: number): Promise<void>;
};

type StoredViewport = Omit<ViewportRecord, "tabId">;

function mapOf(raw: unknown): Record<string, StoredViewport> {
  return raw !== null && typeof raw === "object" ? (raw as Record<string, StoredViewport>) : {};
}

/**
 * The store over one storage area, read on every call and never cached - the reason
 * `window-restore.ts`'s is: the worker that wrote the record is often not the worker that clears
 * the emulation, and a cached map would be the state an eviction silently took away.
 *
 * Keyed by tab rather than kept as a list (R-170): a tab has one viewport, and a second `set` is
 * the same emulation at another size rather than a second one to remember.
 */
export function createViewportStore(area: StorageAreaLike | undefined): ViewportStore {
  async function read(): Promise<Record<string, StoredViewport>> {
    const raw = await area?.get([AGENT_VIEWPORTS_KEY]);
    return mapOf(raw?.[AGENT_VIEWPORTS_KEY]);
  }

  async function write(records: Record<string, StoredViewport>): Promise<void> {
    await area?.set({ [AGENT_VIEWPORTS_KEY]: records });
  }

  return {
    async remember(record) {
      const records = await read();
      const { tabId, ...rest } = record;
      records[String(tabId)] = rest;
      await write(records);
    },
    async forTab(tabId) {
      const stored = (await read())[String(tabId)];
      return stored === undefined ? undefined : { tabId, ...stored };
    },
    async forget(tabId) {
      const records = await read();
      if (!(String(tabId) in records)) return;
      delete records[String(tabId)];
      await write(records);
    },
  };
}

/** The real store: `chrome.storage.session`, read lazily so composing this needs no browser. */
export function sessionViewportStore(): ViewportStore {
  const area = (): StorageAreaLike | undefined =>
    typeof chrome !== "undefined" ? (chrome.storage?.session as unknown as StorageAreaLike | undefined) : undefined;
  return {
    remember: (record) => createViewportStore(area()).remember(record),
    forTab: (tabId) => createViewportStore(area()).forTab(tabId),
    forget: (tabId) => createViewportStore(area()).forget(tabId),
  };
}

export type ViewportEmulationDeps = {
  store: ViewportStore;
  attachments: Pick<AgentInputAttachments, "acquire" | "drop" | "send" | "attached">;
  /** The card's line about it (FR-159); the panel writes the sentence from the outcome and size. */
  onActivity?(sessionId: string, outcome: "set" | "cleared", size?: ViewportSize): void;
  reportDiagnostic?(code: string): void;
};

export type ViewportSetOutcome = { ok: true } | { ok: false; unavailableReason: InputUnavailableReason };

/**
 * What a `reset` could do (012/S2c F4).
 *
 * `real` is absent when nothing could measure the page - the tab was never emulated and nobody
 * holds an attachment on it - which is a different fact from a reset that failed: the caller then
 * answers from what the browser knows about the tab rather than refusing. A refusal is only ever
 * the attachment's, and it means the page is *still emulated*.
 */
export type ViewportResetOutcome =
  | { ok: true; real?: ViewportSize }
  | { ok: false; unavailableReason: InputUnavailableReason };

export type ViewportEmulation = {
  set(sessionId: string, tabId: number, size: ViewportSize): Promise<ViewportSetOutcome>;
  /** Puts the page back and answers the real size, when the attachment could still measure one. */
  reset(sessionId: string, tabId: number): Promise<ViewportResetOutcome>;
  /** The record for a tab, for the tools that have to know which size the page is laid out at. */
  current(tabId: number): Promise<ViewportRecord | undefined>;
  /**
   * Drops the record for a tab that is gone (012/S2c F5).
   *
   * Nothing is sent: there is no page left to clear and no attachment to clear it over. What this
   * prevents is the record outliving the tab - Chrome gives tab ids out again, and the next tab to
   * be handed this one would be emulated by the first `acquire` that touched it, on behalf of a
   * session that never asked anything about it.
   */
  forget(tabId: number): Promise<void>;
  /** A tab was attached: re-apply what the record says (the eviction path, R-167). */
  onAttached(tabId: number): Promise<void>;
  /** A tab's attachment is about to go: clear the emulation while there is still something to send it over. */
  onBeforeRelease(tabId: number): Promise<void>;
};

const APPLY = "Emulation.setDeviceMetricsOverride";
const CLEAR = "Emulation.clearDeviceMetricsOverride";

/**
 * What the page is told it has.
 *
 * `deviceScaleFactor: 1` and `mobile: false` are stated rather than left out because CDP treats an
 * omitted factor as "no override at all" on some builds: the size would be honoured and the density
 * left wherever it was. Emulating density, touch or a user agent is out of scope (spec) - this is a
 * viewport, not a device.
 */
function overrideFor(size: ViewportSize): Record<string, unknown> {
  return { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false };
}

export function createViewportEmulation(deps: ViewportEmulationDeps): ViewportEmulation {
  async function apply(tabId: number, size: ViewportSize): Promise<boolean> {
    try {
      await deps.attachments.send(tabId, APPLY, overrideFor(size));
      return true;
    } catch {
      deps.reportDiagnostic?.("agent.viewport.apply-failed");
      return false;
    }
  }

  /** What one `clear` did: nothing to do, the attachment refused, or the page has its size back. */
  type ClearResult =
    | { state: "nothing" }
    | { state: "unavailable"; unavailableReason: InputUnavailableReason }
    | { state: "done"; record: ViewportRecord; real?: ViewportSize; borrowed: boolean };

  /**
   * Gives one tab its real size back, over whichever attachment it takes (data-model `decideClear`).
   *
   * The record goes whatever Chrome answers, including after a failed clear: the tab is being let
   * go of, and a record kept for it would be a promise to clear something nobody holds an
   * attachment on any more. The failure is reported instead, which is what a diagnostic is for.
   */
  async function clear(
    tabId: number,
    options: { measure: boolean; keepOnRefusal: boolean },
  ): Promise<ClearResult> {
    const record = await deps.store.forTab(tabId).catch(() => undefined);
    const decision = decideClear(record, deps.attachments.attached().includes(tabId));
    if (decision === "nothing" || !record) return { state: "nothing" };
    const borrowed = decision === "attach-clear-detach" ? await deps.attachments.acquire(tabId, "viewport") : undefined;
    if (borrowed !== undefined && !borrowed.ok && options.keepOnRefusal) {
      /**
       * 012/S2c F4 - nothing was cleared, so nothing is forgotten.
       *
       * Only the caller that is *asking* for the page back keeps the record: the page is still
       * emulated, and the record is the one thing that would let the next call put that right. A
       * release cannot keep it - the tab is leaving this session whatever Chrome says - so it goes
       * on down to the drop below, which is what this module did before this branch existed.
       */
      deps.reportDiagnostic?.("agent.viewport.clear-failed");
      return { state: "unavailable", unavailableReason: borrowed.unavailableReason };
    }
    let real: ViewportSize | undefined;
    if (borrowed === undefined || borrowed.ok) {
      try {
        // R-176 (branded Chrome 153): a clear from a *fresh* attachment does not undo an override
        // the detached one set - the page stayed 500x500 - while re-asserting the size first and
        // then clearing put it back every run. So a borrowed attachment takes the emulation over
        // before it gives it up; an attachment this worker already holds needs only the clear.
        if (borrowed !== undefined) await deps.attachments.send(tabId, APPLY, overrideFor(record));
        await deps.attachments.send(tabId, CLEAR);
        // Measured after the clear and before the attachment goes - what comes back is then the
        // window's own viewport, which is the only honest answer to "what size is the page now" -
        // and only for the caller that has to answer it. A release sends the clear and nothing
        // else: the tab is going back to the owner and nobody is waiting to be told its size.
        if (options.measure) {
          real = await measureViewport(tabId, (id, method, params) => deps.attachments.send(id, method, params));
        }
      } catch {
        deps.reportDiagnostic?.("agent.viewport.clear-failed");
      }
    } else {
      deps.reportDiagnostic?.("agent.viewport.clear-failed");
    }
    await deps.store.forget(tabId).catch(() => undefined);
    if (borrowed !== undefined) await deps.attachments.drop(tabId, "viewport").catch(() => undefined);
    return { state: "done", record, borrowed: borrowed !== undefined, ...(real === undefined ? {} : { real }) };
  }

  return {
    async set(sessionId, tabId, size) {
      const acquired = await deps.attachments.acquire(tabId, "viewport");
      if (!acquired.ok) return acquired;
      if (!(await apply(tabId, size))) {
        // The page was never given the size, so nothing is recorded and the holder is let go: a
        // record here would be a promise to clear an emulation that does not exist.
        await deps.attachments.drop(tabId, "viewport").catch(() => undefined);
        return { ok: false, unavailableReason: "restricted-page" };
      }
      await deps.store.remember({ tabId, sessionId, width: size.width, height: size.height, setAt: Date.now() });
      deps.onActivity?.(sessionId, "set", size);
      return { ok: true };
    },
    async reset(sessionId, tabId) {
      const cleared = await clear(tabId, { measure: true, keepOnRefusal: true });
      // 012/S2c F4: a refused attachment cleared nothing, so this answers the refusal rather than
      // `emulated: false` about a page that is still the size the agent gave it.
      if (cleared.state === "unavailable") return { ok: false, unavailableReason: cleared.unavailableReason };
      if (cleared.state === "nothing") {
        // Nothing was emulated. The page still has a size, and it is measured only if something
        // already holds an attachment on the tab: a reset is not a reason to start debugging one.
        const real = deps.attachments.attached().includes(tabId)
          ? await measureViewport(tabId, (id, method, params) => deps.attachments.send(id, method, params))
          : undefined;
        return { ok: true, ...(real === undefined ? {} : { real }) };
      }
      // The holder this emulation took is let go of here rather than inside `clear`, which also
      // runs on the release path - where the attachment is going anyway and dropping a holder
      // mid-detach would be bookkeeping about a tab nobody holds. An attachment `clear` borrowed
      // for itself has already been given back.
      if (!cleared.borrowed) await deps.attachments.drop(tabId, "viewport").catch(() => undefined);
      deps.onActivity?.(sessionId, "cleared");
      return { ok: true, ...(cleared.real === undefined ? {} : { real: cleared.real }) };
    },
    current(tabId) {
      return deps.store.forTab(tabId).catch(() => undefined);
    },
    async forget(tabId) {
      await deps.store.forget(tabId).catch(() => undefined);
    },
    async onAttached(tabId) {
      const record = await deps.store.forTab(tabId).catch(() => undefined);
      if (!record) return;
      // 012/S2c F1: the holder as well as the size. Whatever attached this tab now - an effect, the
      // diagnostics - will drop its own holder eventually, and a detach while a record still exists
      // is the emulation outliving the session all over again. This is the same claim `set` makes,
      // re-established on the one path that did not go through `set`: the eviction.
      await deps.attachments.acquire(tabId, "viewport").catch(() => undefined);
      await apply(tabId, record);
    },
    async onBeforeRelease(tabId) {
      // The tab is going back to the owner whatever Chrome says about attaching to it, so this
      // path drops the record on a refusal as it always has: a record owed to an attachment nobody
      // holds is a promise this worker cannot keep.
      const cleared = await clear(tabId, { measure: false, keepOnRefusal: false });
      if (cleared.state !== "done") return;
      deps.onActivity?.(cleared.record.sessionId, "cleared");
    },
  };
}
