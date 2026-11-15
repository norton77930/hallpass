/**
 * An all-frames injection, bounded.
 *
 * `chrome.scripting.executeScript` with `allFrames: true` waits for every frame of the tab, and a
 * frame that has not loaded yet - an `<iframe loading="lazy">` below the fold, measured on a page
 * with a lazy comments frame at its bottom - keeps the call pending until the page is scrolled
 * there. Nothing downstream of an unbounded call can answer, so every all-frames caller goes through
 * here: past the bound the call **rejects**, and each caller takes the path it already has for an
 * injection that threw (the top document alone for a read, "unknown" for a consent decision).
 * Frame-scoped injections (`frameIds`) are not affected and do not use this.
 */

/**
 * Two seconds, the same bound a single frame's answer gets: `FRAME_ANSWER_BOUND_MS` in
 * `agent-tools/frames.ts` is defined as this value, so the adapter layer never imports upward.
 */
export const ALL_FRAMES_BOUND_MS = 2_000;

/** The error an all-frames injection rejects with when the bound passes without an answer. */
export class AllFramesTimeoutError extends Error {
  /** The bound that passed, so a remembered timeout (#70) can say the same thing. */
  readonly boundMs: number;

  constructor(boundMs: number) {
    super(`an all-frames injection gave no answer within ${boundMs} ms`);
    this.name = "AllFramesTimeoutError";
    this.boundMs = boundMs;
  }
}

export async function executeInAllFrames(
  injection: Parameters<typeof chrome.scripting.executeScript>[0],
  boundMs: number = ALL_FRAMES_BOUND_MS,
): Promise<unknown[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AllFramesTimeoutError(boundMs)), boundMs);
  });
  try {
    return (await Promise.race([chrome.scripting.executeScript(injection), expired])) as unknown[];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tool calls' memory of a timed-out all-frames lookup, one tab at a time (#70).
 *
 * The frame that kept one lookup pending keeps the next one pending too, and a single tool call
 * makes several (a ref click claims the ref's frame before the gate and locates it after; keys to
 * focus read focus at the gate and again before dispatch). So once one of a call's lookups on a tab
 * has timed out, the rest of that call's lookups on that tab reject at once with the same
 * `AllFramesTimeoutError`, and every caller takes the reject path it already has - never an answer,
 * never an admit.
 *
 * The memory belongs to its owner (the effects runner) and reaches only the lookups the owner wraps
 * with `guard`: a call is told apart from everything else on the tab by the functions it looks up
 * through. Every other all-frames lookup made on the tab while a call is open there (attaching the
 * tab, `wait`, the uploads, the reads, the recorder) goes straight to `executeInAllFrames` - it is
 * neither refused by the call's memory nor marks it, exactly as before #70. Only waiting lookups are
 * guarded: the reads' immediate enumeration (#71) settles without waiting for frame loads and is
 * never handed to it.
 *
 * Opened and closed by the call itself (`open`, the effects runner's `runCall`), so it never
 * outlives the call: the next call waits the full bound again, because by then the frame may have
 * loaded. Kept per tab, and only while exactly one call is open on the tab - with two (one call per
 * tab is the rule, FR-043, so this is a guard) nothing is remembered and every lookup waits as
 * before. A lookup is charged to the call that was open when it started, so one that outlives its
 * call cannot mark the next.
 */
export type AllFramesCallMemo = {
  /** Opens one call's memory on `tabId`; the returned function closes it and must run however the call ends. */
  open(tabId: number): () => void;
  /** `lookup` as the owner's calls make it, under the memory of the call open on its tab. */
  guard<Rest extends unknown[], Result>(
    lookup: (tabId: number, ...rest: Rest) => Promise<Result>,
  ): (tabId: number, ...rest: Rest) => Promise<Result>;
};

/** One open call's memory: the timeout it saw, once it has seen one. */
type AllFramesCallScope = { timedOut?: AllFramesTimeoutError };

export function createAllFramesCallMemo(): AllFramesCallMemo {
  const openScopes = new Map<number, Set<AllFramesCallScope>>();

  /** The one call open on `tabId`, or nothing when there is none or more than one. */
  function soleScope(tabId: number): AllFramesCallScope | undefined {
    const open = openScopes.get(tabId);
    if (open === undefined || open.size !== 1) return undefined;
    const [scope] = open;
    return scope;
  }

  return {
    open(tabId) {
      const scope: AllFramesCallScope = {};
      const open = openScopes.get(tabId) ?? new Set<AllFramesCallScope>();
      open.add(scope);
      openScopes.set(tabId, open);
      // Closing twice is harmless.
      return () => {
        open.delete(scope);
        if (open.size === 0 && openScopes.get(tabId) === open) openScopes.delete(tabId);
      };
    },
    guard(lookup) {
      return async (tabId, ...rest) => {
        const scope = soleScope(tabId);
        // The same error, with the bound the remembered lookup was given.
        if (scope?.timedOut !== undefined) throw new AllFramesTimeoutError(scope.timedOut.boundMs);
        try {
          return await lookup(tabId, ...rest);
        } catch (error) {
          // Remembered only while the call it started in is still the tab's one open call.
          if (error instanceof AllFramesTimeoutError && scope !== undefined && soleScope(tabId) === scope) {
            scope.timedOut ??= error;
          }
          throw error;
        }
      };
    },
  };
}
