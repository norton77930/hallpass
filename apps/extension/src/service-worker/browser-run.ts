/**
 * Which run of the browser this is (013/S4, R-184, FR-168).
 *
 * One opaque id, minted the first time anything asks for it after the browser started and kept in
 * `chrome.storage.session`. It is not a session, not a pairing and not an identity: nothing in the
 * browser reads it, and its whole purpose is to be *compared* by the host on the other end of the
 * link.
 *
 * **Why it exists.** The host holds the screenshots an agent may upload (R-177), and FR-168 asks
 * two things of that retention at once: it survives the worker being recycled, and it ends when the
 * browser exits. S1 read both off the link dropping, which cannot tell them apart - Chrome
 * recycling the service worker kills the native host with it, so a recycling looks exactly like a
 * browser that went away (the gate's F4). `chrome.storage.session` is the one thing in the browser
 * whose lifetime is precisely the difference: Chrome keeps it across an eviction and throws it away
 * when the browser closes. So an id kept there, carried to the host on the worker's pairing answer,
 * *is* the distinction - unchanged means the same browser came back, different means a new one, and
 * the host clears only in the second case.
 *
 * **Why it is not the pairing id or the relay's pid.** The pairing is the owner's decision and does
 * not change at all across either event; the relay's pid changes across both, since Chrome respawns
 * the host either way. Neither can answer the question.
 */

/** Where the id lives; `chrome.storage.session`, so it dies with the browser as the run does. */
export const AGENT_BROWSER_RUN_KEY = "agentBrowserRun";

/** The part of a storage area this module uses; `chrome.storage.session` is one. */
export type StorageAreaLike = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

export type BrowserRun = {
  /**
   * This browser run's id, minting it on first use. `undefined` when there is no session storage
   * to keep one in: an id this worker could not keep would be a fresh one after every eviction,
   * which the host would read as a browser restart every time, so saying nothing is the honest
   * answer and leaves the host on its own fall-back.
   */
  id(): Promise<string | undefined>;
};

/** An opaque id, as `content-broker.ts` mints its message ids; 36 chars, inside the 64 the frame allows. */
function mintRunId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createBrowserRun(area: StorageAreaLike | undefined, mint: () => string = mintRunId): BrowserRun {
  /**
   * The read-or-mint, held for this worker's life once it has started.
   *
   * It is the one piece of state this module keeps in memory, and it is kept for a reason the
   * storage pattern elsewhere (`viewport-emulation.ts`) does not have: two calls that raced would
   * otherwise mint two ids for one browser, and the host would read the second as a restart and
   * forget a picture it promised to keep. Losing the variable to an eviction costs nothing - the
   * next worker reads the same id back out of storage.
   */
  let settled: Promise<string | undefined> | undefined;

  async function readOrMint(): Promise<string | undefined> {
    if (!area) return undefined;
    const stored = (await area.get([AGENT_BROWSER_RUN_KEY]))[AGENT_BROWSER_RUN_KEY];
    if (typeof stored === "string" && stored.length > 0) return stored;
    const minted = mint();
    await area.set({ [AGENT_BROWSER_RUN_KEY]: minted });
    return minted;
  }

  return {
    id() {
      settled ??= readOrMint().catch((error: unknown) => {
        // A storage read that failed is not a run this worker may name, and it must not be the
        // answer for the rest of the browser's life either: the next ask tries again.
        settled = undefined;
        throw error;
      });
      return settled;
    },
  };
}

/**
 * The real run, over `chrome.storage.session`.
 *
 * Held by its caller for the life of the worker rather than in a module variable: the in-memory
 * half of this is a per-worker fact, and a module singleton would outlive a test's fake area while
 * still answering with the id it minted there.
 */
export function sessionBrowserRun(): BrowserRun {
  return createBrowserRun(
    typeof chrome !== "undefined" ? (chrome.storage?.session as unknown as StorageAreaLike | undefined) : undefined,
  );
}
