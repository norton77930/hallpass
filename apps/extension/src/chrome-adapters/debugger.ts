/**
 * The `chrome.debugger` calls the diagnostics tools make (003/T057, US6, FR-049, FR-050).
 *
 * A wrapper with no policy, for the same reason the tabs adapter is one: the decisions - whether
 * the owner granted diagnostics for this site, when to attach, when to let go - belong in
 * `agent-tools/diagnostics.ts`, and a test wants one seam to fake rather than a global.
 *
 * The protocol version is pinned here and nowhere else. It is the one place that knows this
 * extension speaks DevTools at all, which is also why the "is debugging this browser" bar Chrome
 * shows the owner is a fact about *this* module's lifetime: attach and detach here are what raise
 * and lower it.
 */

/** The DevTools protocol version this extension speaks. Pinned: a floating one is a silent upgrade. */
export const DEBUGGER_PROTOCOL_VERSION = "1.3";

export type DebuggerEventListener = (
  tabId: number,
  method: string,
  params: Record<string, unknown>,
) => void;

export type DebuggerAdapter = {
  attach(tabId: number): Promise<void>;
  detach(tabId: number): Promise<void>;
  /**
   * `sessionId` addresses a flattened child session directly - an out-of-process frame's own target
   * (004/T129) - rather than the tab's top-level session; Chrome accepts the pair `{tabId,
   * sessionId}` and refuses a bare `{targetId}` (measured, B73/B74).
   */
  send(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>>;
  /** Every protocol event for every attached tab; the caller routes by tab. */
  onEvent(listener: DebuggerEventListener): void;
  /**
   * Chrome dropping the attachment on its own - the tab closed, or the owner clicked Cancel on the
   * debugging bar. The caller has to hear about it, or it would keep believing it was attached and
   * would answer reads from a buffer nothing is filling.
   */
  onDetach(listener: (tabId: number) => void): void;
  /**
   * The tabs Chrome currently reports a debugger on (003/C1).
   *
   * The service worker can be evicted while an attachment it made is still live, and the worker
   * that starts next has no memory of it. This is the only way back to the truth: what Chrome says
   * is attached right now, which the caller reconciles against what it believes.
   */
  attachedTabIds(): Promise<number[]>;
};

type ChromeDebugger = {
  attach(target: { tabId: number }, version: string): Promise<void>;
  detach(target: { tabId: number }): Promise<void>;
  sendCommand(
    target: { tabId: number; sessionId?: string },
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined>;
  onEvent: {
    addListener(callback: (source: { tabId?: number }, method: string, params?: unknown) => void): void;
  };
  onDetach: { addListener(callback: (source: { tabId?: number }, reason?: string) => void): void };
  getTargets(): Promise<Array<{ tabId?: number; type?: string; attached?: boolean }>>;
};

function api(): ChromeDebugger {
  const value = (globalThis as { chrome?: { debugger?: ChromeDebugger } }).chrome?.debugger;
  if (!value) {
    // Only the agent profile declares the permission, so this is a build reaching for a capability
    // it does not have rather than a runtime condition worth recovering from.
    throw new Error("debugger-unavailable");
  }
  return value;
}

export function createChromeDebuggerAdapter(): DebuggerAdapter {
  return {
    async attach(tabId) {
      await api().attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
    },
    async detach(tabId) {
      await api().detach({ tabId });
    },
    async send(tabId, method, params, sessionId) {
      const result = await api().sendCommand(
        sessionId === undefined ? { tabId } : { tabId, sessionId },
        method,
        params,
      );
      return result ?? {};
    },
    onEvent(listener) {
      api().onEvent.addListener((source, method, params) => {
        if (source.tabId === undefined) return;
        listener(source.tabId, method, (params ?? {}) as Record<string, unknown>);
      });
    },
    onDetach(listener) {
      api().onDetach.addListener((source) => {
        if (source.tabId === undefined) return;
        listener(source.tabId);
      });
    },
    async attachedTabIds() {
      const targets = await api().getTargets();
      // Pages only, and only the ones something is already attached to. Chrome does not say *who*
      // is attached, so the caller's own detach - which fails harmlessly when the attachment is
      // somebody else's - is what makes the distinction.
      return targets
        .filter((target) => target.attached === true && target.type === "page" && target.tabId !== undefined)
        .map((target) => target.tabId as number);
    },
  };
}
