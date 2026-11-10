import type { DebuggerAdapter } from "../../src/chrome-adapters/debugger.js";

/**
 * A debugger adapter a suite drives directly (031/T943, T944).
 *
 * The chrome-global fakes cannot say "Chrome let go on its own" or hold a detach open, and the idle
 * release is about exactly those moments: the owner dismissing the debugging bar while a countdown
 * runs, and a call arriving while the idle detach is still on its way to Chrome.
 *
 * `emit` is a protocol event from the page, and it reaches a listener only while the tab is
 * attached - which is the whole of why a dialog or a "leave site?" nobody is attached for is never
 * heard (031 slice C review I1, P1).
 */
export function scriptedDebugger() {
  const detachListeners: Array<(tabId: number) => void> = [];
  const eventListeners: Array<(tabId: number, method: string, params: Record<string, unknown>) => void> = [];
  const state = {
    attached: new Set<number>(),
    attaches: [] as number[],
    detached: [] as number[],
    commands: [] as Array<{ tabId: number; method: string; params?: Record<string, unknown> }>,
    failMethod: undefined as string | undefined,
    detachGate: undefined as Promise<void> | undefined,
  };
  const adapter: DebuggerAdapter = {
    async attach(tabId) {
      if (state.attached.has(tabId)) throw new Error("Already attached");
      state.attached.add(tabId);
      state.attaches.push(tabId);
    },
    async detach(tabId) {
      if (state.detachGate) await state.detachGate;
      if (!state.attached.delete(tabId)) throw new Error("Not attached");
      state.detached.push(tabId);
    },
    async send(tabId, method, params) {
      state.commands.push({ tabId, method, ...(params ? { params } : {}) });
      if (!state.attached.has(tabId)) throw new Error("Debugger is not attached to the tab");
      if (method === state.failMethod) throw new Error(`${method} failed`);
      return {};
    },
    onEvent(listener) {
      eventListeners.push(listener);
    },
    onDetach(listener) {
      detachListeners.push(listener);
    },
    async attachedTabIds() {
      return [...state.attached];
    },
  };
  return {
    adapter,
    state,
    /** Chrome drops the attachment by itself - the bar's Cancel, or the tab closing. */
    externalDetach(tabId: number) {
      state.attached.delete(tabId);
      for (const listener of detachListeners) listener(tabId);
    },
    /** The page raised a protocol event; heard only over a live attachment. Says whether it was. */
    emit(tabId: number, method: string, params: Record<string, unknown>): boolean {
      if (!state.attached.has(tabId)) return false;
      for (const listener of eventListeners) listener(tabId, method, params);
      return true;
    },
    focusSends(tabId: number) {
      return state.commands.filter(
        (command) => command.tabId === tabId && command.method === "Emulation.setFocusEmulationEnabled",
      );
    },
  };
}
