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
  constructor(boundMs: number) {
    super(`an all-frames injection gave no answer within ${boundMs} ms`);
    this.name = "AllFramesTimeoutError";
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
