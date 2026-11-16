import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FOCUS_WALK_MAX_DEPTH, focusOfFrame } from "../src/chrome-adapters/frame-focus.js";

/**
 * 030/T908 review round 2 - the in-frame half of the focus walk answers unknown for anything it
 * cannot establish (FR-464).
 *
 * `focusOfFrame` runs in every frame; `focusedChild: -1` tells the walk "keys land in this
 * document", which decides them by this frame's site. So -1 is only for focus that ended on a plain
 * element of this document: a shadow chain deeper than the cap, or a focused frame holder whose
 * child cannot be named, is `null`. jsdom has no `chrome.dom`, so each test stands one in that opens
 * open and closed roots the way Chrome's does; without it the read cannot see into closed roots and
 * answers unknown (#52).
 */

/** Closed roots made here, which only the `chrome.dom` stand-in can open. */
let closedRoots = new WeakMap<Element, ShadowRoot>();

/** A `chrome` whose `dom.openOrClosedShadowRoot` opens open and closed roots alike, as Chrome's does. */
function chromeWithDom(): unknown {
  return {
    dom: {
      openOrClosedShadowRoot: (element: HTMLElement) => element.shadowRoot ?? closedRoots.get(element) ?? null,
    },
  };
}

beforeEach(() => {
  closedRoots = new WeakMap();
  vi.stubGlobal("chrome", chromeWithDom());
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** `levels` nested shadow hosts under the body, each root `mode`; the innermost root gets `inner`. */
function nestInShadowHosts(levels: number, inner: Element, mode: ShadowRootMode = "open"): void {
  let parent: Element | ShadowRoot = document.body;
  for (let level = 0; level < levels; level += 1) {
    const host = document.createElement("div");
    parent.append(host);
    const root = host.attachShadow({ mode });
    if (mode === "closed") closedRoots.set(host, root);
    parent = root;
  }
  parent.append(inner);
}

describe("030 focusOfFrame", () => {
  it("answers null for a frame focused below more shadow levels than the cap", () => {
    const frame = document.createElement("iframe");
    nestInShadowHosts(FOCUS_WALK_MAX_DEPTH + 1, frame);
    frame.focus();
    expect(focusOfFrame(FOCUS_WALK_MAX_DEPTH)).toEqual({ path: [], focusedChild: null });
  });

  it("answers null for a focused embed or object, whose document is not one of this window's frames", () => {
    for (const tag of ["embed", "object"] as const) {
      const holder = document.createElement(tag);
      holder.tabIndex = 0;
      document.body.replaceChildren(holder);
      holder.focus();
      expect(document.activeElement).toBe(holder);
      expect(focusOfFrame(FOCUS_WALK_MAX_DEPTH)).toEqual({ path: [], focusedChild: null });
    }
  });

  it("answers -1 for a plain focused input in the top document, and for no focus at all", () => {
    expect(focusOfFrame(FOCUS_WALK_MAX_DEPTH)).toEqual({ path: [], focusedChild: -1 });
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect(focusOfFrame(FOCUS_WALK_MAX_DEPTH)).toEqual({ path: [], focusedChild: -1 });
  });

  it("answers -1 for a plain input within the cap of shadow levels", () => {
    const input = document.createElement("input");
    nestInShadowHosts(FOCUS_WALK_MAX_DEPTH, input);
    input.focus();
    expect(focusOfFrame(FOCUS_WALK_MAX_DEPTH)).toEqual({ path: [], focusedChild: -1 });
  });

  it("names the child index of a focused iframe one shadow level down", () => {
    document.body.append(document.createElement("iframe"), document.createElement("iframe"));
    const frame = document.createElement("iframe");
    nestInShadowHosts(1, frame);
    // jsdom loads no document into a shadow tree's iframe; Chrome does and numbers it among
    // `frames`. Stand in a window this one does number, at index 1.
    expect(window.length).toBe(2);
    Object.defineProperty(frame, "contentWindow", { get: () => window[1] });
    frame.focus();
    expect(focusOfFrame(FOCUS_WALK_MAX_DEPTH)).toEqual({ path: [], focusedChild: 1 });
  });

  it("names the child index of a focused iframe inside a closed shadow root, which chrome.dom opens", () => {
    document.body.append(document.createElement("iframe"), document.createElement("iframe"));
    const frame = document.createElement("iframe");
    nestInShadowHosts(1, frame, "closed");
    expect(window.length).toBe(2);
    Object.defineProperty(frame, "contentWindow", { get: () => window[1] });
    frame.focus();
    expect(focusOfFrame(FOCUS_WALK_MAX_DEPTH)).toEqual({ path: [], focusedChild: 1 });
  });

  it("answers null for a focused iframe whose window is not one of this window's frames", () => {
    const frame = document.createElement("iframe");
    nestInShadowHosts(1, frame);
    frame.focus();
    expect(frame.contentWindow).toBeNull();
    expect(focusOfFrame(FOCUS_WALK_MAX_DEPTH)).toEqual({ path: [], focusedChild: null });
  });

  it("answers path null, unknown, for a frame hung deeper than the cap", () => {
    // jsdom cannot nest 33 windows cheaply; a cap of 0 makes a frame one level down too deep.
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const inner = frame.contentWindow as unknown as { chrome?: unknown; eval(source: string): unknown };
    // The function runs in the child's own realm, so the child needs its own `chrome`.
    inner.chrome = chromeWithDom();
    const answer = inner.eval(`(${focusOfFrame.toString()})(0)`);
    expect(answer).toEqual({ path: null, focusedChild: null });
    // Within the cap, the same frame names its place.
    expect(inner.eval(`(${focusOfFrame.toString()})(1)`)).toEqual({ path: [0], focusedChild: -1 });
  });

  // #52: a fenced frame holds focus in a document that is not among `frames` and has no
  // `contentWindow`, so where keys land is not known.
  it("answers null for a focused fencedframe, in the document and inside a closed shadow root", () => {
    const top = document.createElement("fencedframe");
    top.tabIndex = 0;
    document.body.append(top);
    top.focus();
    expect(document.activeElement).toBe(top);
    expect(focusOfFrame(FOCUS_WALK_MAX_DEPTH)).toEqual({ path: [], focusedChild: null });

    document.body.replaceChildren();
    const inner = document.createElement("fencedframe");
    inner.tabIndex = 0;
    nestInShadowHosts(1, inner, "closed");
    inner.focus();
    expect(focusOfFrame(FOCUS_WALK_MAX_DEPTH)).toEqual({ path: [], focusedChild: null });
  });

  // #52: without `chrome.dom` a closed root cannot be opened, so the read cannot tell whether one
  // hides the focus - not even when the focus looks like a plain element of this document.
  it("answers null for a plain focused input when chrome.dom.openOrClosedShadowRoot is missing", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    for (const chromeStandIn of [undefined, {}, { dom: {} }]) {
      vi.stubGlobal("chrome", chromeStandIn);
      expect(focusOfFrame(FOCUS_WALK_MAX_DEPTH)).toEqual({ path: [], focusedChild: null });
    }
  });

  it("still names its place without chrome.dom: the path does not depend on it", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const inner = frame.contentWindow as unknown as { eval(source: string): unknown };
    expect(inner.eval(`(${focusOfFrame.toString()})(1)`)).toEqual({ path: [0], focusedChild: null });
  });
});
