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

/**
 * Issue #54: siblings are listed in their parent's own frame order, which is what the frame offsets
 * pair against the debugger's tree. Ordered as text, a frame at index 10 came before the one at 2.
 */
describe("#54 enumerateTabFrames - sibling order", () => {
  it("lists eleven siblings in their index order, not their text order", async () => {
    const indexes = [10, 2, 0, 9, 1, 3, 4, 5, 6, 7, 8];
    stubChrome([
      { frameId: 0, result: { url: "https://fixtures.test/top", path: [] } },
      ...indexes.map((index) => ({ frameId: 100 + index, result: { url: "about:srcdoc", path: [index] } })),
    ]);

    const frames = await enumerateTabFrames(9);

    expect(frames.filter((frame) => frame.parentFrameId === 0).map((frame) => frame.frameId)).toEqual([
      100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110,
    ]);
  });

  it("flags a frame that cannot find itself among its parent's frames (an iframe in a shadow root)", async () => {
    stubChrome([
      { frameId: 0, result: { url: "https://fixtures.test/top", path: [] } },
      { frameId: 5, result: { url: "about:srcdoc", path: [0] } },
      { frameId: 6, result: { url: "about:srcdoc", path: [-1] } },
    ]);

    const frames = await enumerateTabFrames(9);

    expect(frames.find((frame) => frame.frameId === 6)).toMatchObject({ unindexed: true });
    expect(frames.find((frame) => frame.frameId === 5)).not.toHaveProperty("unindexed");
    expect(frames.find((frame) => frame.frameId === 0)).not.toHaveProperty("unindexed");
  });
});
