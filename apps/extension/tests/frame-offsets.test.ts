import { describe, expect, it } from "vitest";
import { createTargetLocator } from "../src/service-worker/agent-tools/effects.js";
import {
  createFrameOffsets,
  createHybridFrameOffsets,
  type BrowserFrame,
  type FrameOffset,
} from "../src/service-worker/agent-tools/frames.js";
import type { AgentPageBinding } from "../src/service-worker/agent-tools/page-binding.js";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";

/**
 * 004/T124 - a reference inside a frame, in the coordinates input is addressed by (US4, R-114).
 *
 * Input goes to the tab as **top-level viewport** coordinates, and a frame's runtime reports its
 * elements in **its own** viewport. The gap between those two is silent: nothing fails, the click
 * simply lands somewhere else on the page. So every assertion here is about a *nested* frame, two
 * hops from the top document. A one-hop translation - the offset of the frame the element is in,
 * and no further - passes any single-level test and still clicks the wrong place on the page this
 * feature exists for, where the artifact body is a frame inside a frame.
 *
 * The other half is when it is measured (T125a). An offset kept past the effect it was measured
 * for is worse than no offset at all: it is a confident wrong answer, delivered as a real click on
 * whatever is painted there now - and the two ways a page moves without saying so, a frame
 * reloading at the url it already had and a parent laid out again without navigating, are invisible
 * to every key a cache could use. So the chain is measured for the delivery that is about to use
 * it, memoised inside that one delivery, and gone when it ends.
 */

const TAB = 9;
const TOP_URL = "https://fixtures.test:19443/frames";
const CHILD_URL = "https://fixtures.test:19443/frames/child";
const GRANDCHILD_URL = "https://other.test/inner";

/** Where each frame's owner element sits **in its own parent's viewport**, never in the top's. */
const OWNER_AT: Record<number, { x: number; y: number }> = { 11: { x: 10, y: 20 }, 22: { x: 5, y: 7 } };

/** The tab's frames as the enumeration reports them: top -> f1 -> f2. */
function framesAt(childUrl: string = CHILD_URL): BrowserFrame[] {
  return [
    { frameId: 0, parentFrameId: -1, url: TOP_URL },
    { frameId: 3, parentFrameId: 0, url: childUrl },
    { frameId: 7, parentFrameId: 3, url: GRANDCHILD_URL },
  ];
}

/** The debugger, answering the two queries an owner offset is made of, with the traffic recorded. */
function fakeProtocol() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const fail = { owner: false };
  const owner: Record<string, number> = { F1: 11, F2: 22 };
  /** The page's current layout, which a test moves the way a page moves: without asking anyone. */
  const ownerAt: Record<number, { x: number; y: number }> = { ...OWNER_AT };
  const send = async (
    _tabId: number,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    calls.push({ method, params });
    if (method === "Page.getFrameTree") {
      return {
        frameTree: {
          frame: { id: "TOP", url: TOP_URL },
          childFrames: [
            {
              frame: { id: "F1", parentId: "TOP", url: CHILD_URL },
              childFrames: [{ frame: { id: "F2", parentId: "F1", url: GRANDCHILD_URL } }],
            },
          ],
        },
      };
    }
    if (method === "DOM.getFrameOwner") {
      if (fail.owner) throw new Error("Frame owner not found");
      const backendNodeId = owner[String(params.frameId)];
      if (backendNodeId === undefined) throw new Error("unknown frame token");
      return { backendNodeId };
    }
    if (method === "DOM.getBoxModel") {
      const at = ownerAt[Number(params.backendNodeId)];
      if (!at) throw new Error("unknown node");
      return {
        model: { content: [at.x, at.y, at.x + 300, at.y, at.x + 300, at.y + 200, at.x, at.y + 200] },
      };
    }
    return {};
  };
  return {
    send,
    calls,
    fail,
    /** The page re-laid-out: the owner element is somewhere else now, and nothing said so. */
    moveOwner(backendNodeId: number, to: { x: number; y: number }) {
      ownerAt[backendNodeId] = to;
    },
    boxes: () => calls.filter((call) => call.method === "DOM.getBoxModel").length,
  };
}

const CONTEXT = testSessionContexts().forCall("session-f1", "call-locate");

const BINDING: AgentPageBinding = {
  tabId: TAB,
  canonicalOrigin: "https://fixtures.test:19443",
  documentEpoch: "doc-1",
} as AgentPageBinding;

/**
 * One frame's collection: the ref is in `frameId`, at the box that frame's own viewport sees.
 *
 * It answers the way the **real** collector does about handles (004/T129e): a node carries a
 * `targetHandle` only when the collection asked for `page.target-metadata`, because that is the
 * category the content runtime mints handles under and the broker projects them under
 * (`collector.ts` `includeTargets`, `content-broker.ts` `sanitizeSemanticNodes`). A fake that
 * attaches the handle regardless describes a document nobody has, and it is what let an effect
 * refuse a ref `find` had just handed back while every suite stayed green.
 */
function fakeCollect(where: { frameId: number; ref: string; rect: { x: number; y: number; width: number; height: number } }) {
  return async (input: { frameId?: number; rootTargetHandle?: string; requested: readonly string[] }) => ({
    tabId: TAB,
    contextHandle: "ctx-1",
    documentEpoch: "doc-1",
    canonicalOrigin: "https://fixtures.test:19443",
    formValueItems: [],
    semanticNodes:
      (input.frameId ?? 0) === where.frameId
        ? [
            {
              role: "button",
              ...(input.requested.includes("page.target-metadata") ? { targetHandle: where.ref } : {}),
              rect: where.rect,
            },
          ]
        : [],
  });
}

describe("T124/T125a frame offsets", () => {
  describe("the owner chain", () => {
    it("adds every hop up to the top document, not just the nearest one", async () => {
      const protocol = fakeProtocol();
      const offsets = createFrameOffsets({ send: protocol.send });

      const offset = await offsets.forDelivery(TAB).offsetFor(framesAt(), 7);

      // f2's owner sits at (5, 7) inside f1, and f1's owner sits at (10, 20) inside the top
      // document. Only the sum is where f2's own (0, 0) is on the page.
      expect(offset).toEqual({ x: 15, y: 27 });
    });

    it("is nothing at all for the top document", async () => {
      const protocol = fakeProtocol();
      const offsets = createFrameOffsets({ send: protocol.send });

      expect(await offsets.forDelivery(TAB).offsetFor(framesAt(), 0)).toEqual({ x: 0, y: 0 });
      expect(protocol.boxes()).toBe(0);
    });

    it("answers nothing rather than a guess when the owner cannot be measured", async () => {
      const protocol = fakeProtocol();
      protocol.fail.owner = true;
      const offsets = createFrameOffsets({ send: protocol.send });

      // Not `{ x: 0, y: 0 }`: an unmeasured frame treated as flush with the top document is a
      // click delivered somewhere on the page, which is the failure this whole module removes.
      expect(await offsets.forDelivery(TAB).offsetFor(framesAt(), 7)).toBeUndefined();
    });
  });

  describe("the memo", () => {
    it("measures each frame of the chain once within one delivery", async () => {
      const protocol = fakeProtocol();
      const delivery = createFrameOffsets({ send: protocol.send }).forDelivery(TAB);

      await delivery.offsetFor(framesAt(), 7);
      await delivery.offsetFor(framesAt(), 7);

      // One delivery locates a drag's two endpoints and re-measures the one it dragged; walking
      // the same chain three times would be three round trips for one answer.
      expect(protocol.boxes()).toBe(2);
    });

    it("measures again for the next delivery", async () => {
      const protocol = fakeProtocol();
      const offsets = createFrameOffsets({ send: protocol.send });

      await offsets.forDelivery(TAB).offsetFor(framesAt(), 7);
      await offsets.forDelivery(TAB).offsetFor(framesAt(), 7);

      // Both hops again. What makes it necessary is the next two tests: between two deliveries the
      // page can move with nothing in the enumeration changing.
      expect(protocol.boxes()).toBe(4);
    });
  });

  /**
   * 004/T125a - the geometry is measured for the effect that is about to use it.
   *
   * Both cases here are pages that moved while their urls stayed exactly the same, which is what
   * the url-keyed cache could not see. Neither shows up as a failure: the offset is still a
   * number, the click is still delivered, and it lands on whatever the page has painted there
   * since. That is the worst answer this module can give, so the chain is walked for the effect
   * that is about to use it rather than remembered from the one before.
   */
  describe("a page that moved without navigating", () => {
    it("re-measures a frame that reloaded at the same url", async () => {
      const protocol = fakeProtocol();
      const offsets = createFrameOffsets({ send: protocol.send });
      expect(await offsets.forDelivery(TAB).offsetFor(framesAt(), 7)).toEqual({ x: 15, y: 27 });

      // f2 reloads: same document url, taller content above it, so its owner element inside f1 is
      // 100px lower than it was. The enumeration says nothing about any of that.
      protocol.moveOwner(22, { x: 5, y: 107 });

      expect(await offsets.forDelivery(TAB).offsetFor(framesAt(), 7)).toEqual({ x: 15, y: 127 });
    });

    it("re-measures a parent that was laid out again without navigating", async () => {
      const protocol = fakeProtocol();
      const offsets = createFrameOffsets({ send: protocol.send });
      expect(await offsets.forDelivery(TAB).offsetFor(framesAt(), 7)).toEqual({ x: 15, y: 27 });

      // The top document opened a banner above f1. No frame navigated, no url changed, and every
      // frame inside f1 is now 200px lower than the last measurement said.
      protocol.moveOwner(11, { x: 10, y: 220 });

      // Still both hops: the grandchild's own offset inside f1 has not changed, and the answer is
      // only right if the parent's new box is added to it.
      expect(await offsets.forDelivery(TAB).offsetFor(framesAt(), 7)).toEqual({ x: 15, y: 227 });
    });
  });

  describe("what an effect is given", () => {
    it("turns a nested frame's rect into the page's coordinates", async () => {
      const protocol = fakeProtocol();
      const locate = createTargetLocator({
        offsets: createFrameOffsets({ send: protocol.send }),
        enumerateFrames: async () => framesAt(),
        collect: fakeCollect({ frameId: 7, ref: "t_inner", rect: { x: 100, y: 40, width: 80, height: 20 } }),
      }).forDelivery();

      const rect = await locate({ context: CONTEXT, binding: BINDING, ref: "t_inner", scroll: true });

      // 004/T128 gap 2: the frame that claimed the ref rides along too, in its own viewport - what
      // a same-frame confirmation has to ask in, since the offset above is only right for delivery.
      // gap 3: and its own epoch, as its own collection just declared it - never the top document's.
      // 004/T129: and its own origin, for the same reason.
      expect(rect).toEqual({
        x: 115,
        y: 67,
        width: 80,
        height: 20,
        frame: {
          frameId: 7,
          rect: { x: 100, y: 40, width: 80, height: 20 },
          documentEpoch: "doc-1",
          canonicalOrigin: "https://fixtures.test:19443",
        },
      });
    });

    it("leaves a top-document ref where its own document put it", async () => {
      const protocol = fakeProtocol();
      const locate = createTargetLocator({
        offsets: createFrameOffsets({ send: protocol.send }),
        enumerateFrames: async () => framesAt(),
        collect: fakeCollect({ frameId: 0, ref: "t_save", rect: { x: 100, y: 40, width: 80, height: 20 } }),
      }).forDelivery();

      const rect = await locate({ context: CONTEXT, binding: BINDING, ref: "t_save", scroll: true });

      expect(rect).toEqual({
        x: 100,
        y: 40,
        width: 80,
        height: 20,
        frame: {
          frameId: 0,
          rect: { x: 100, y: 40, width: 80, height: 20 },
          documentEpoch: "doc-1",
          canonicalOrigin: "https://fixtures.test:19443",
        },
      });
    });

    it("locates a ref on a page of one document, which is where `find` handed it back", async () => {
      // 004/T129e. The refusal both S4 scenarios died on was here, on the simplest page there is:
      // `find` resolved a top-frame control and the effect answered `target-not-located` without
      // delivering anything. Nothing was wrong with the ref - the collection the locator made
      // asked for `page.structure` alone, so every node came back nameless and the handle
      // comparison could not match anything the page had.
      const protocol = fakeProtocol();
      const locate = createTargetLocator({
        offsets: createFrameOffsets({ send: protocol.send }),
        enumerateFrames: async () => [{ frameId: 0, parentFrameId: -1, url: TOP_URL }],
        collect: fakeCollect({ frameId: 0, ref: "t_learn", rect: { x: 12, y: 34, width: 56, height: 78 } }),
      }).forDelivery();

      const rect = await locate({ context: CONTEXT, binding: BINDING, ref: "t_learn", scroll: true });

      expect(rect).toEqual({ x: 12, y: 34, width: 56, height: 78 });
    });

    /**
     * 004/T147 (S4 review) - the multi-frame branch already treats a frame it could not ask as one
     * that has not claimed the ref (`try { ... } catch { return undefined; }`, above); the
     * single-document branch skipped straight to `locateInFrame` with no such guard, so the same
     * throw a confirmation now catches (`createTargetConfirmer`) escaped uncaught here instead,
     * before the effect it was locating for had even been delivered.
     */
    it("does not throw when the page's own collection throws on a page of one document (T147)", async () => {
      const protocol = fakeProtocol();
      const locate = createTargetLocator({
        offsets: createFrameOffsets({ send: protocol.send }),
        enumerateFrames: async () => [{ frameId: 0, parentFrameId: -1, url: TOP_URL }],
        collect: async () => {
          // A throw that is not the `unsupported-page` family (T161, below): still "not located",
          // since the page itself may yet be asked again.
          throw new Error("stale-context");
        },
      }).forDelivery();

      await expect(
        locate({ context: CONTEXT, binding: BINDING, ref: "t_learn", scroll: true }),
      ).resolves.toBeUndefined();
    });

    /**
     * 004/T161: `undefined` here means "not located" - `locator`'s own caller reports that as
     * `target-not-located`, whose honest next move is "read the page again". A page this extension
     * cannot act on at all - the `unsupported-page` throw above - never becomes locatable by reading
     * it again, so collapsing the two into the same `undefined` hands the agent the wrong next move.
     */
    it("answers not-actionable, not merely not-located, when the collection throws unsupported-page", async () => {
      const protocol = fakeProtocol();
      const locate = createTargetLocator({
        offsets: createFrameOffsets({ send: protocol.send }),
        enumerateFrames: async () => [{ frameId: 0, parentFrameId: -1, url: TOP_URL }],
        collect: async () => {
          throw new Error("unsupported-page");
        },
      }).forDelivery();

      const result = await locate({ context: CONTEXT, binding: BINDING, ref: "t_learn", scroll: true });

      expect(result).toEqual({ notActionable: true });
    });

    it("does not locate a ref whose frame could not be measured", async () => {
      const protocol = fakeProtocol();
      protocol.fail.owner = true;
      const locate = createTargetLocator({
        offsets: createFrameOffsets({ send: protocol.send }),
        enumerateFrames: async () => framesAt(),
        collect: fakeCollect({ frameId: 7, ref: "t_inner", rect: { x: 100, y: 40, width: 80, height: 20 } }),
      }).forDelivery();

      expect(await locate({ context: CONTEXT, binding: BINDING, ref: "t_inner", scroll: true })).toBeUndefined();
    });
  });

  /**
   * 004/T128, B67 - the debugger's chain pairs the enumeration's frame ids with `Page.getFrameTree`'s
   * tokens **by order** (`pairFrameTokens`), which two structurally parallel branches - two sibling
   * frames of the same shape, exactly what `frames.html` has - can mis-key: its own comment warns a
   * mis-key "would offset an element by another frame's box". Measured live against `frames.html`
   * (B67), a same-origin grandchild's composed offset was off by (80, 350) from the offset an
   * in-page `frameElement` walk computes independently - the same shape of error this section
   * reproduces without a browser.
   */
  describe("the hybrid offset (same-origin in-page, cross-origin still the debugger's)", () => {
    it("prefers the in-page measurement over a mis-paired debugger chain", async () => {
      const protocol = fakeProtocol();
      // A CDP chain paired the wrong way round - exactly what a mis-keyed `pairFrameTokens` hands
      // back on two structurally parallel branches: the numbers below are deliberately not what
      // this frame's real chain is, so a caller that used them would be the bug this test catches.
      const wrongOffset: FrameOffset = { x: 999, y: 999 };
      const hybrid = createHybridFrameOffsets({
        measureInPage: async () => new Map([[7, { x: 15, y: 27 }]]),
        cdp: { forDelivery: () => ({ offsetFor: async () => wrongOffset }) },
      });

      const offset = await hybrid.forDelivery(TAB).offsetFor(framesAt(), 7);

      expect(offset).toEqual({ x: 15, y: 27 });
      // Never even asked the debugger: a same-origin chain the in-page walk covered needs no CDP
      // round trip at all.
      expect(protocol.boxes()).toBe(0);
    });

    it("falls back to the debugger for a frame the in-page walk could not reach the top from", async () => {
      const protocol = fakeProtocol();
      const hybrid = createHybridFrameOffsets({
        // The in-page walk hit a cross-origin hop and stopped, so it has nothing for this frame -
        // the one case `createFrameOffsets` (the debugger's chain) still has to cover.
        measureInPage: async () => new Map(),
        cdp: createFrameOffsets({ send: protocol.send }),
      });

      const offset = await hybrid.forDelivery(TAB).offsetFor(framesAt(), 7);

      expect(offset).toEqual({ x: 15, y: 27 });
      expect(protocol.boxes()).toBeGreaterThan(0);
    });

    it("wires into the target locator the same way the plain debugger chain did", async () => {
      const protocol = fakeProtocol();
      const locate = createTargetLocator({
        offsets: createHybridFrameOffsets({
          measureInPage: async () => new Map([[7, { x: 15, y: 27 }]]),
          cdp: createFrameOffsets({ send: protocol.send }),
        }),
        enumerateFrames: async () => framesAt(),
        collect: fakeCollect({ frameId: 7, ref: "t_inner", rect: { x: 100, y: 40, width: 80, height: 20 } }),
      }).forDelivery();

      const rect = await locate({ context: CONTEXT, binding: BINDING, ref: "t_inner", scroll: true });

      expect(rect).toEqual({
        x: 115,
        y: 67,
        width: 80,
        height: 20,
        frame: {
          frameId: 7,
          rect: { x: 100, y: 40, width: 80, height: 20 },
          documentEpoch: "doc-1",
          canonicalOrigin: "https://fixtures.test:19443",
        },
      });
      expect(protocol.boxes()).toBe(0);
    });
  });
});
