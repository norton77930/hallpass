import { afterEach, describe, expect, it } from "vitest";
import { focusOfFrame } from "../src/service-worker/agent-tools/frame-focus.js";
import { FOCUS_WALK_MAX_DEPTH } from "../src/service-worker/agent-tools/frame-site.js";

/**
 * 030/T908 review round 2 - the in-frame half of the focus walk answers unknown for anything it
 * cannot establish (FR-464).
 *
 * `focusOfFrame` runs in every frame; `focusedChild: -1` tells the walk "keys land in this
 * document", which decides them by this frame's site. So -1 is only for focus that ended on a plain
 * element of this document: a shadow chain deeper than the cap, or a focused frame holder whose
 * child cannot be named, is `null`. jsdom has no `chrome.dom`, so these use open roots.
 */

afterEach(() => {
  document.body.replaceChildren();
});

/** `levels` nested open shadow hosts under the body; the innermost root gets `inner`. */
function nestInShadowHosts(levels: number, inner: Element): void {
  let parent: Element | ShadowRoot = document.body;
  for (let level = 0; level < levels; level += 1) {
    const host = document.createElement("div");
    parent.append(host);
    parent = host.attachShadow({ mode: "open" });
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
    const inner = frame.contentWindow as unknown as { eval(source: string): unknown };
    const answer = inner.eval(`(${focusOfFrame.toString()})(0)`);
    expect(answer).toEqual({ path: null, focusedChild: null });
    // Within the cap, the same frame names its place.
    expect(inner.eval(`(${focusOfFrame.toString()})(1)`)).toEqual({ path: [0], focusedChild: -1 });
  });
});
