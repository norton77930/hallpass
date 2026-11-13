import { executeInAllFrames } from "./all-frames.js";

/**
 * Reads one global out of every frame's main world (030 R-442 as settled by T886).
 *
 * The coordinate walk writes a one-time nonce through the debugger into the frame it found under a
 * point; this is the other half of that round trip, and the reverse of the out-of-process resolver's
 * (`writeFrameNonce`): the browser runs the read in every frame and attaches its own frame id and
 * document id to each answer, which is what names the debugger's frame to the extension. Only a
 * string is passed back - nothing else the page keeps under that name is carried.
 *
 * `MAIN` because that is where the debugger's write landed; the read itself takes nothing from the
 * page but that one value. Needs no permission the extension does not already hold.
 */

/** One frame's answer: the browser's frame and document ids, and the string found, or `null`. */
export type MainWorldMark = { frameId?: number; documentId?: string; result?: unknown };

/** Runs in each frame: the value under `key` when it is a string, otherwise nothing. */
function readMark(key: string): string | null {
  const value = (window as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

export async function readMainWorldMarks(tabId: number, key: string): Promise<MainWorldMark[]> {
  const results = (await executeInAllFrames({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func: readMark,
    args: [key],
  })) as Array<{ frameId?: number; documentId?: string; result?: unknown }> | undefined;
  return (results ?? []).map((entry) => ({
    ...(typeof entry.frameId === "number" ? { frameId: entry.frameId } : {}),
    ...(typeof entry.documentId === "string" ? { documentId: entry.documentId } : {}),
    result: entry.result ?? null,
  }));
}
