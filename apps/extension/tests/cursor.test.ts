/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindAgentContentRuntime } from "../src/content-runtime/agent-entry.js";
import { snapshotDocument } from "../src/content-runtime/collector.js";
import { applyCursor, CURSOR_MARKER_ATTRIBUTE, moveCursor } from "../src/content-runtime/cursor.js";
import { INDICATOR_MARKER_ATTRIBUTE } from "../src/content-runtime/indicator-marker.js";

/**
 * 004/T126 - the phantom cursor (US5, FR-064, R-119).
 *
 * It is a *marker*, not a piece of interface: it says where the agent is pointing so the owner can
 * follow along, and it must be incapable of doing anything else. Three claims carry that.
 *
 * - **It never takes a click.** The pointer effect the marker is drawn for is delivered to those
 *   very coordinates a moment later; an element under them that could swallow the press would make
 *   the marker the thing the agent clicked.
 * - **It is the top document's alone.** Coordinates are top-level, so a copy drawn in each frame
 *   would be several marks, all but one of them in the wrong place.
 * - **It is never read back.** It wears the marker the indicator wears, so the one exclusion the
 *   collector already has covers it - an agent that read its own pointer out of the page would be
 *   reading its own tail, and a second mechanism would be a second thing to forget.
 *
 * A fourth, since the pointer became one the owner can follow: **the worker is told when it has
 * arrived**, so the press lands where the owner just watched the pointer stop - not where it was
 * still going. The answer is the transition's own end, a timer when that never comes, and "now"
 * when there was nothing to watch.
 */

function cursor(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${CURSOR_MARKER_ATTRIBUTE}]`);
}

function top() {
  return { doc: document, isTopFrame: true };
}

/** What the browser fires when the glide ends; jsdom has no `TransitionEvent`, so the field is set by hand. */
function transitionEnd(propertyName: string): Event {
  return Object.assign(new Event("transitionend"), { propertyName });
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("T126 the phantom cursor", () => {
  it("moves to the point it is given, and is gone on the hide", () => {
    expect(applyCursor({ type: "cursor", x: 140, y: 50 }, top())).toBe(true);

    const mark = cursor();
    expect(mark, "a pointer effect draws the marker").not.toBeNull();
    expect(mark?.style.transform).toBe("translate3d(140px, 50px, 0)");

    applyCursor({ type: "cursor", x: 12, y: 9 }, top());
    expect(document.querySelectorAll(`[${CURSOR_MARKER_ATTRIBUTE}]`).length, "one marker, moved").toBe(1);
    expect(cursor()?.style.transform).toBe("translate3d(12px, 9px, 0)");

    applyCursor({ type: "cursor", hide: true }, top());
    expect(cursor(), "the tab left the session, so the mark goes with it").toBeNull();
  });

  it("cannot be pointed at", () => {
    applyCursor({ type: "cursor", x: 140, y: 50 }, top());

    // The effect's own press lands on these coordinates next; anything the marker intercepted
    // would be a click on the extension rather than on the page.
    expect(cursor()?.style.pointerEvents).toBe("none");
    expect(cursor()?.querySelectorAll("button, a, input").length, "nothing to interact with").toBe(0);
  });

  it("is an arrow whose tip is the hot spot, not a widget", () => {
    applyCursor({ type: "cursor", x: 140, y: 50 }, top());

    expect(cursor()?.querySelector("svg"), "an arrow pointer, drawn inline").not.toBeNull();
    expect(cursor()?.querySelectorAll("button, a, input, textarea, select").length).toBe(0);
    // The tip sits exactly on (x, y): nothing offsets it, the translate alone places it.
    expect(cursor()?.style.left).toBe("0px");
    expect(cursor()?.style.top).toBe("0px");
    expect(cursor()?.style.marginLeft).toBe("");
  });

  it("is drawn in the top document only", () => {
    expect(applyCursor({ type: "cursor", x: 140, y: 50 }, { doc: document, isTopFrame: false })).toBe(true);

    expect(cursor(), "a child frame's copy would be a mark in the wrong place").toBeNull();
  });

  it("is not a message this module owns unless it says so", () => {
    expect(applyCursor({ type: "indicator", show: true }, top())).toBe(false);
    expect(applyCursor(undefined, top())).toBe(false);
    expect(moveCursor({ type: "indicator", show: true }, top())).toBeUndefined();
    expect(cursor()).toBeNull();
  });

  it("wears the indicator's own marker, so no collection can see it", () => {
    document.body.innerHTML =
      '<p>Ordinary page text</p><button type="button">Real button</button>';
    applyCursor({ type: "cursor", x: 140, y: 50 }, top());

    expect(cursor()?.getAttribute(INDICATOR_MARKER_ATTRIBUTE), "one exclusion covers both").toBe("");

    const snapshot = snapshotDocument(document, "https://page.test", 200, undefined, "all-controls");

    expect(snapshot.visibleText).toContain("Ordinary page text");
    // 004/T117d: the page's own paragraph and button - the walk sees prose now - and nothing of the
    // cursor, which is what this test is about.
    expect(snapshot.targets.map((target) => target.role), "the page's own elements, and only them").toEqual([
      "paragraph",
      "button",
    ]);
    expect(snapshot.targets.find((target) => target.role === "button")?.text).toContain("Real button");
    expect(snapshot.controls).toEqual([]);
  });
});

describe("T126 arrival - when the worker may press", () => {
  it("arrives when the transform transition ends", async () => {
    applyCursor({ type: "cursor", x: 10, y: 10 }, top());
    let arrived = false;
    const arrival = moveCursor({ type: "cursor", x: 140, y: 50 }, top());
    expect(arrival).toBeInstanceOf(Promise);
    void arrival?.then(() => {
      arrived = true;
    });

    await Promise.resolve();
    expect(arrived, "still gliding").toBe(false);

    cursor()?.dispatchEvent(transitionEnd("transform"));
    await Promise.resolve();
    expect(arrived).toBe(true);
  });

  it("arrives on the fallback timer when the transition never reports", async () => {
    vi.useFakeTimers();
    applyCursor({ type: "cursor", x: 10, y: 10 }, top());
    let arrived = false;
    void moveCursor({ type: "cursor", x: 140, y: 50 }, top())?.then(() => {
      arrived = true;
    });

    await vi.advanceTimersByTimeAsync(239);
    expect(arrived, "not before the transition could have finished").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(arrived).toBe(true);
  });

  it("arrives at once when it is already there", async () => {
    vi.useFakeTimers();
    applyCursor({ type: "cursor", x: 140, y: 50 }, top());
    let arrived = false;
    void moveCursor({ type: "cursor", x: 140, y: 50 }, top())?.then(() => {
      arrived = true;
    });

    await Promise.resolve();
    expect(arrived, "no distance, no wait").toBe(true);
  });

  it("arrives at once on first sight - it is placed, not glided in from the corner", async () => {
    vi.useFakeTimers();
    let arrived = false;
    void moveCursor({ type: "cursor", x: 140, y: 50 }, top())?.then(() => {
      arrived = true;
    });

    await Promise.resolve();
    expect(arrived).toBe(true);
    expect(cursor()?.style.transform).toBe("translate3d(140px, 50px, 0)");
  });
});

/**
 * The entry's half: a cursor message is answered when the pointer has arrived, and the pointer
 * leaves the page with the indicator - the `show: false` that says the tab left the session.
 */
describe("T126 through the content runtime", () => {
  type Listener = (
    message: unknown,
    sender: { id?: string },
    sendResponse: (response: unknown) => void,
  ) => boolean | void;

  function bind(): { listener: Listener } {
    const captured: { listener?: Listener } = {};
    const runtime = {
      id: "hallpass-test-extension",
      sendMessage: () => undefined,
      onMessage: {
        addListener: (listener: Listener) => {
          captured.listener = listener;
        },
      },
    };
    bindAgentContentRuntime(runtime, document);
    if (!captured.listener) throw new Error("listener not registered");
    return { listener: captured.listener };
  }

  it("keeps the channel open and answers `arrived` for a cursor message", async () => {
    const { listener } = bind();
    const sendResponse = vi.fn();

    const kept = listener({ type: "cursor", x: 140, y: 50 }, { id: "hallpass-test-extension" }, sendResponse);

    expect(kept, "the reply is asynchronous, so the channel stays open").toBe(true);
    await Promise.resolve();
    expect(sendResponse).toHaveBeenCalledWith({ arrived: true });
    expect(cursor()?.style.transform).toBe("translate3d(140px, 50px, 0)");
  });

  it("removes the pointer when the indicator is lowered", () => {
    const { listener } = bind();
    listener({ type: "cursor", x: 140, y: 50 }, { id: "hallpass-test-extension" }, () => undefined);
    expect(cursor()).not.toBeNull();

    const kept = listener({ type: "indicator", show: false }, { id: "hallpass-test-extension" }, () => undefined);

    expect(kept).toBe(false);
    expect(cursor(), "the tab left the session; the pointer leaves with the banner").toBeNull();
  });

  it("survives a reply channel that already closed", async () => {
    const { listener } = bind();
    const sendResponse = vi.fn(() => {
      throw new Error("The message port closed before a response was received.");
    });

    listener({ type: "cursor", x: 140, y: 50 }, { id: "hallpass-test-extension" }, sendResponse);
    await Promise.resolve();
    await Promise.resolve();

    expect(sendResponse).toHaveBeenCalled();
  });
});
