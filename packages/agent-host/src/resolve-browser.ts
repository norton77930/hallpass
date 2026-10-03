import type { AgentBrowserSummary } from "@hallpass/contracts";

/**
 * Which browser a session's next call runs in, or why none (018 data-model "Resolution", R-270,
 * R-278).
 *
 * Pure because the server asks it in three places - at `initialize`, on every dial and in
 * `placeCall` (R-278) - and the three must never disagree: a dial that picked one browser and a call
 * that refused for "none chosen" would be the server guessing, which FR-272 forbids. Nothing here
 * reads a file or a clock; the directory, the choice store and the session's memory are the inputs.
 */
export type ResolveBrowserInput = {
  /** The connected browsers as the directory lists them, in its order. */
  connected: readonly AgentBrowserSummary[];
  /** The browser this session is bound to: its first forwarded call, or a select (D-018-12). */
  boundBrowserId?: string | undefined;
  /** The bound browser as last seen, so a refusal can name it after it has gone (FR-277). */
  boundBrowser?: AgentBrowserSummary | undefined;
  /** When the bound browser was first seen absent; `undefined` while absent means "just now". */
  boundAbsentSinceMs?: number | undefined;
  /** The attach bound a recycled worker gets to come back in before it is a refusal (R-278). */
  attachGraceMs: number;
  /** The browser this agent chose last (`choices/<agentId>.json`, R-271). */
  rememberedBrowserId?: string | undefined;
  now: number;
};

export type BrowserResolution =
  | { kind: "use"; browserId: string }
  /** The bound browser is absent but may still be a worker restart: wait, then resolve again. */
  | { kind: "wait" }
  | { kind: "refuse-not-chosen"; browsers: AgentBrowserSummary[] }
  | { kind: "refuse-disconnected"; browser: AgentBrowserSummary; browsers: AgentBrowserSummary[] }
  /** Nothing connected and nothing bound: today's `bridge-unavailable`, not a choice question. */
  | { kind: "none" };

export function resolveBrowser(input: ResolveBrowserInput): BrowserResolution {
  const connected = [...input.connected];
  const isConnected = (browserId: string): boolean => connected.some((browser) => browser.browserId === browserId);

  /**
   * Bound first (R-278, FR-277): once a session has acted somewhere, only that browser may act for
   * it. An absent one is waited for within the attach bound - a worker recycle retracts the record
   * for a moment - and then refused, however many others are connected, including exactly one.
   */
  if (input.boundBrowserId !== undefined) {
    if (isConnected(input.boundBrowserId)) {
      return { kind: "use", browserId: input.boundBrowserId };
    }
    const absentFor = input.now - (input.boundAbsentSinceMs ?? input.now);
    if (absentFor < input.attachGraceMs) {
      return { kind: "wait" };
    }
    const browser =
      input.boundBrowser?.browserId === input.boundBrowserId
        ? input.boundBrowser
        : { browserId: input.boundBrowserId, name: "Browser", kind: "unknown" as const };
    return { kind: "refuse-disconnected", browser, browsers: connected };
  }
  if (connected.length === 0) {
    return { kind: "none" };
  }
  /**
   * A remembered browser is the agent's choice whether or not it is connected (D-018-13): offline,
   * the session is asked again rather than quietly given the one other browser, which may hold the
   * owner's other accounts.
   */
  if (input.rememberedBrowserId !== undefined) {
    return isConnected(input.rememberedBrowserId)
      ? { kind: "use", browserId: input.rememberedBrowserId }
      : { kind: "refuse-not-chosen", browsers: connected };
  }
  const only = connected.length === 1 ? connected[0] : undefined;
  return only !== undefined ? { kind: "use", browserId: only.browserId } : { kind: "refuse-not-chosen", browsers: connected };
}
