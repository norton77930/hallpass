import { afterEach, describe, expect, it, vi } from "vitest";
import { enumerateTabFrames } from "../src/chrome-adapters/scripting.js";

function stubChrome(results: Array<{ frameId?: number; result?: { url?: string; path?: number[] } | null }>): void {
  vi.stubGlobal("chrome", {
    scripting: {
      async executeScript() {
        return results;
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * 004/T153 (S4 review). `enumerateTabFrames` places a frame under its parent by matching the
 * parent's own *path* (`byPath`) - the only way to pair them, since Chrome hands back one flat list
 * per frame with no parentage of its own. A frame that could not be scripted (sandboxed, CSP-
 * blocked, or simply not yet injectable) never answers at all and is correctly left out of the
 * list (the comment two lines above `byPath` says so) - but its *children* can still answer, since
 * injecting into a child does not depend on its own parent's script having run. Their `path` then
 * names a prefix `byPath` has no entry for.
 */
describe("004/T153 enumerateTabFrames - a parent that could not be scripted", () => {
  it("does not hand a mid-chain frame the same parentFrameId the real top document has", async () => {
    // top (path []) answered; the mid frame (path [0]) never did; its own child (path [0, 0])
    // still answered.
    stubChrome([
      { frameId: 0, result: { url: "https://fixtures.test/top", path: [] } },
      { frameId: 7, result: { url: "https://fixtures.test/leaf", path: [0, 0] } },
    ]);

    const frames = await enumerateTabFrames(9);
    const leaf = frames.find((frame) => frame.frameId === 7);

    // The old `byPath.get(...) ?? -1` fallback made this frame's `parentFrameId` the exact value a
    // genuine top document has - indistinguishable from one, and `frames.ts`'s `offsetFor` treats
    // -1 as "nothing to add", handing an effect `{ x: 0, y: 0 }` for a frame that is not flush with
    // the top at all (precisely what `frames.ts:473-475` says must never happen).
    expect(leaf?.parentFrameId).not.toBe(-1);
  });
});
