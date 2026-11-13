/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindAgentContentRuntime } from "../src/content-runtime/agent-entry.js";
import { snapshotDocument } from "../src/content-runtime/collector.js";
import {
  applyCursor,
  applyPointerStep,
  CURSOR_MARKER_ATTRIBUTE,
  isCursorMessage,
  isPointerStep,
  moveCursor,
  removeCursor,
} from "../src/content-runtime/cursor.js";
import { planTravel } from "../src/content-runtime/cursor-motion.js";
import { INDICATOR_MARKER_ATTRIBUTE } from "../src/content-runtime/indicator-marker.js";
import { visibleTextOf } from "../src/content-runtime/visible-text.js";

/**
 * 004/T126 - the phantom cursor (US5, FR-064, R-119); 033/T991-T995 - it says what the agent is doing.
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
 * still going. The answer is the animation's own end, a timer when that never comes, and "now"
 * when there was nothing to watch.
 *
 * jsdom has no layout and no Web Animations: the tests below stub `animate`, `offsetWidth` and
 * `matchMedia` where a claim needs them. What the real browser does with them is the live gates'.
 */

const VIEW = document.defaultView as Window & typeof globalThis;
const EXTENSION = "hallpass-test-extension";

function cursor(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${CURSOR_MARKER_ATTRIBUTE}]`);
}

function caption(): HTMLElement | null {
  return cursor()?.querySelector<HTMLElement>("[data-hallpass-words]") ?? null;
}

function shownWords(): string | null {
  return caption()?.getAttribute("data-hallpass-words") ?? null;
}

function rings(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-hallpass-ring]")];
}

function top() {
  return { doc: document, isTopFrame: true };
}

type Mode = "travel" | "stay" | "rest";

function step(words: string, mode: Mode = "stay"): boolean {
  return applyPointerStep({ type: "pointer-step", words, mode }, top());
}

function textNodesUnder(root: Node): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let count = 0;
  while (walker.nextNode()) count += 1;
  return count;
}

/** jsdom's viewport is 1024 x 768; a test that needs another says so. */
function setViewport(width: number, height: number): void {
  Object.defineProperty(VIEW, "innerWidth", { configurable: true, writable: true, value: width });
  Object.defineProperty(VIEW, "innerHeight", { configurable: true, writable: true, value: height });
}

/** Where the rest spot lies at the current viewport: 16 px from the left, 16 px above the arrow's foot. */
function restTransform(): string {
  return `translate3d(16px, ${VIEW.innerHeight - 16 - 24}px, 0)`;
}

/** What the browser fires when an old-style glide ends; kept for the fallback-less assertions below. */
class FakeAnimation extends EventTarget {
  canceled = false;
  finished = false;
  constructor(
    readonly target: Element,
    readonly keyframes: Array<{ transform?: string; offset?: number }>,
    readonly options: unknown,
  ) {
    super();
  }
  cancel(): void {
    this.canceled = true;
    this.dispatchEvent(new Event("cancel"));
  }
  finish(): void {
    this.finished = true;
    this.dispatchEvent(new Event("finish"));
  }
}

let animations: FakeAnimation[] = [];

function installAnimate(): void {
  animations = [];
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    writable: true,
    value(this: HTMLElement, keyframes: FakeAnimation["keyframes"], options: unknown) {
      const animation = new FakeAnimation(this, keyframes, options);
      animations.push(animation);
      return animation;
    },
  });
}

/** The pointer's own animation (not its arrow's tilt). */
function pointerAnimations(): FakeAnimation[] {
  return animations.filter((animation) => animation.target === cursor());
}

function tiltAnimations(): FakeAnimation[] {
  return animations.filter((animation) => animation.target.hasAttribute("data-hallpass-cursor-arrow"));
}

let offsetWidthReads = 0;
const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");

/** A caption is 8 px per character wide and 20 px tall; anything else is 0 x 0, as in jsdom. */
function installLayout(): void {
  offsetWidthReads = 0;
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      const words = this.getAttribute("data-hallpass-words");
      if (words === null) return 0;
      offsetWidthReads += 1;
      return words.length * 8;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("data-hallpass-words") ? 20 : 0;
    },
  });
}

function stubReducedMotion(reduced: boolean): void {
  Object.defineProperty(VIEW, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({ matches: reduced && query.includes("prefers-reduced-motion"), media: query }),
  });
}

afterEach(() => {
  removeCursor(document);
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  vi.useRealTimers();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)["animate"];
  delete (VIEW as unknown as Record<string, unknown>)["matchMedia"];
  delete (document as unknown as Record<string, unknown>)["hidden"];
  if (originalWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalWidth);
  if (originalHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalHeight);
  setViewport(1024, 768);
  animations = [];
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

describe("033/T991 the messages are exact shapes", () => {
  it("accepts a pointer step of type, words (60 characters at most) and a known mode, and nothing else", () => {
    for (const mode of ["travel", "stay", "rest"]) {
      expect(isPointerStep({ type: "pointer-step", words: "Clicking", mode })).toBe(true);
    }
    expect(isPointerStep({ type: "pointer-step", words: "", mode: "stay" })).toBe(true);
    expect(isPointerStep({ type: "pointer-step", words: "x".repeat(60), mode: "stay" })).toBe(true);

    const rejected: unknown[] = [
      { type: "pointer-step", words: "x".repeat(61), mode: "stay" },
      { type: "pointer-step", words: "Clicking", mode: "stay", extra: 1 },
      { type: "pointer-step", words: "Clicking", mode: "fly" },
      { type: "pointer-step", words: "Clicking" },
      { type: "pointer-step", mode: "stay" },
      { type: "pointer-step", words: 7, mode: "stay" },
      { type: "cursor", words: "Clicking", mode: "stay" },
      null,
      "pointer-step",
      [],
    ];
    for (const message of rejected) expect(isPointerStep(message), JSON.stringify(message)).toBe(false);
  });

  it("widens the cursor message by `press: true` and still takes no other key", () => {
    expect(isCursorMessage({ type: "cursor", x: 1, y: 2 })).toBe(true);
    expect(isCursorMessage({ type: "cursor", x: 1, y: 2, press: true })).toBe(true);
    expect(isCursorMessage({ type: "cursor", hide: true })).toBe(true);

    const rejected: unknown[] = [
      { type: "cursor", x: 1, y: 2, press: false },
      { type: "cursor", x: 1, y: 2, press: "yes" },
      { type: "cursor", x: 1, y: 2, words: "hi" },
      { type: "cursor", x: 1 },
      { type: "cursor", x: Number.NaN, y: 2 },
      { type: "cursor", hide: true, x: 1, y: 2 },
      { type: "cursor", hide: false },
      { type: "cursors", x: 1, y: 2 },
    ];
    for (const message of rejected) expect(isCursorMessage(message), JSON.stringify(message)).toBe(false);
  });

  it("does not own a malformed step, and draws nothing for it", () => {
    expect(step("x".repeat(61))).toBe(false);
    expect(applyPointerStep({ type: "pointer-step", words: "Hi", mode: "stay", extra: true }, top())).toBe(false);
    expect(cursor()).toBeNull();
  });
});

describe("033/T991 the caption", () => {
  it("a stay step with no pointer draws it at the rest spot, the words in an attribute and in no text node", () => {
    expect(step("Reading page text")).toBe(true);

    expect(cursor()?.style.transform).toBe(restTransform());
    expect(shownWords()).toBe("Reading page text");
    const mark = caption();
    expect(mark?.getAttribute(INDICATOR_MARKER_ATTRIBUTE), "the one exclusion covers the caption too").toBe("");
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(textNodesUnder(cursor() as Node), "generated content is not text the page or the agent can reach").toBe(0);
    expect(cursor()?.textContent).toBe("");
    expect(document.body.textContent).toBe("");
  });

  it("draws the words through one marked stylesheet and only that", () => {
    step("Reading page text");
    step("Reading page");
    applyCursor({ type: "cursor", x: 140, y: 50 }, top());

    const sheets = document.querySelectorAll("style");
    expect(sheets.length, "added once per document").toBe(1);
    const sheet = sheets[0] as HTMLStyleElement;
    expect(sheet.getAttribute(INDICATOR_MARKER_ATTRIBUTE)).toBe("");
    expect(sheet.textContent).toContain("::before");
    expect(sheet.textContent).toContain("content: attr(data-hallpass-words)");
    expect(sheet.textContent, "no words ride in the stylesheet").not.toContain("Reading");
  });

  it("puts the words on the screen as an attribute, never as markup", () => {
    const hostile = '<img src=x onerror="alert(1)"><b>bold</b>';
    step(hostile);

    expect(shownWords()).toBe(hostile);
    expect(cursor()?.querySelectorAll("img, b").length).toBe(0);
    expect(textNodesUnder(cursor() as Node)).toBe(0);
  });

  it("a travel step stores the words without drawing; the next move draws them at its point", () => {
    expect(step("Clicking", "travel")).toBe(true);
    expect(cursor(), "a travel step never draws").toBeNull();

    applyCursor({ type: "cursor", x: 140, y: 50 }, top());

    expect(cursor()?.style.transform).toBe("translate3d(140px, 50px, 0)");
    expect(shownWords()).toBe("Clicking");
  });

  it("a travel step leaves the shown words alone until the move that carries them", () => {
    applyCursor({ type: "cursor", x: 140, y: 50 }, top());
    step("Pointing", "travel");
    applyCursor({ type: "cursor", x: 10, y: 10 }, top());
    expect(shownWords()).toBe("Pointing");

    step("Clicking", "travel");
    expect(shownWords(), "a failed call leaves the old caption until the next step").toBe("Pointing");
    expect(cursor()?.style.transform).toBe("translate3d(10px, 10px, 0)");

    applyCursor({ type: "cursor", x: 300, y: 300 }, top());
    expect(shownWords()).toBe("Clicking");
  });

  it("a stay step changes the words and leaves the pointer where it is", () => {
    applyCursor({ type: "cursor", x: 140, y: 50 }, top());
    step("Typing");

    expect(shownWords()).toBe("Typing");
    expect(cursor()?.style.transform).toBe("translate3d(140px, 50px, 0)");
  });

  it("empty words change nothing and draw nothing", () => {
    step("", "stay");
    step("", "travel");
    expect(cursor()).toBeNull();

    applyCursor({ type: "cursor", x: 140, y: 50 }, top());
    step("Typing");
    step("", "stay");
    expect(shownWords()).toBe("Typing");
  });

  it("a child frame draws nothing", () => {
    applyPointerStep({ type: "pointer-step", words: "Typing", mode: "stay" }, { doc: document, isTopFrame: false });
    expect(cursor()).toBeNull();
    expect(document.querySelectorAll("style").length).toBe(0);
  });

  it("measures the caption once per change of words, not once per move", () => {
    installLayout();
    step("Typing");
    const afterFirst = offsetWidthReads;
    expect(afterFirst).toBeGreaterThan(0);

    applyCursor({ type: "cursor", x: 140, y: 50 }, top());
    applyCursor({ type: "cursor", x: 300, y: 90 }, top());
    expect(offsetWidthReads, "same words, no new measure").toBe(afterFirst);

    step("Pressing Ctrl+A");
    expect(offsetWidthReads).toBeGreaterThan(afterFirst);
  });
});

describe("033/T989 the caption is placed with placeCaption", () => {
  it("sits below-right by default, moves left near the right edge and above near the bottom", () => {
    installLayout();
    setViewport(1000, 700);
    applyCursor({ type: "cursor", x: 300, y: 200 }, top());
    step("Clicking");
    expect(caption()?.getAttribute("data-side")).toBe("below-right");
    expect(caption()?.getAttribute("data-corner")).toBe("top-left");

    applyCursor({ type: "cursor", x: 995, y: 200 }, top());
    expect(caption()?.getAttribute("data-side")).toBe("left");
    expect(caption()?.getAttribute("data-corner")).toBe("top-right");
    expect(Number.parseFloat(caption()?.style.left ?? "0"), "left of the tip").toBeLessThan(0);

    applyCursor({ type: "cursor", x: 300, y: 695 }, top());
    expect(caption()?.getAttribute("data-side")).toBe("above");
    expect(caption()?.getAttribute("data-corner")).toBe("bottom-left");
    expect(Number.parseFloat(caption()?.style.top ?? "0"), "above the tip").toBeLessThan(0);
  });

  it("caps the width at the viewport minus 16 px", () => {
    installLayout();
    setViewport(300, 500);
    step("A long caption that cannot fit a narrow viewport");
    expect(caption()?.style.maxWidth).toBe("284px");
  });
});

describe("033/T991 fading", () => {
  it("fades 1 000 ms after the pointer arrives at a pointing position, and not before", async () => {
    vi.useFakeTimers();
    step("Clicking", "travel");
    await moveCursor({ type: "cursor", x: 140, y: 50 }, top());
    expect(caption()?.hasAttribute("data-faded")).toBe(false);

    await vi.advanceTimersByTimeAsync(999);
    expect(caption()?.hasAttribute("data-faded")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(caption()?.hasAttribute("data-faded")).toBe(true);
  });

  it("shows the next step's caption at full strength", async () => {
    vi.useFakeTimers();
    await moveCursor({ type: "cursor", x: 140, y: 50 }, top());
    step("Typing");
    await vi.advanceTimersByTimeAsync(1000);
    expect(caption()?.hasAttribute("data-faded")).toBe(true);

    step("Pressing Enter");
    expect(caption()?.hasAttribute("data-faded"), "a new step clears the fade").toBe(false);
    expect(shownWords()).toBe("Pressing Enter");
    await vi.advanceTimersByTimeAsync(1000);
    expect(caption()?.hasAttribute("data-faded"), "and fades again after a second").toBe(true);
  });

  it("a move clears the fade, and the next arrival starts the second again", async () => {
    vi.useFakeTimers();
    step("Clicking", "travel");
    await moveCursor({ type: "cursor", x: 140, y: 50 }, top());
    await vi.advanceTimersByTimeAsync(1000);
    expect(caption()?.hasAttribute("data-faded")).toBe(true);

    step("Pointing", "travel");
    await moveCursor({ type: "cursor", x: 300, y: 90 }, top());
    expect(caption()?.hasAttribute("data-faded")).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(caption()?.hasAttribute("data-faded")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(caption()?.hasAttribute("data-faded")).toBe(true);
  });

  it("never fades at the rest spot", async () => {
    vi.useFakeTimers();
    step("Reading page text");
    await vi.advanceTimersByTimeAsync(5000);
    expect(caption()?.hasAttribute("data-faded")).toBe(false);

    applyCursor({ type: "cursor", x: 140, y: 50 }, top());
    step("Opening localhost", "rest");
    await vi.advanceTimersByTimeAsync(5000);
    expect(caption()?.hasAttribute("data-faded")).toBe(false);
  });

  it("a step that is not the last one in flight does not let an older arrival fade the new caption early", async () => {
    vi.useFakeTimers();
    installAnimate();
    applyCursor({ type: "cursor", x: 10, y: 10 }, top());
    void moveCursor({ type: "cursor", x: 600, y: 400 }, top());
    step("Opening localhost", "rest");
    await vi.advanceTimersByTimeAsync(5000);
    expect(caption()?.hasAttribute("data-faded"), "the cancelled move's arrival must not fade a rest caption").toBe(false);
  });
});

describe("033/T992 the rest spot", () => {
  it("a rest step moves a pointing pointer to the rest spot and the caption stays", () => {
    applyCursor({ type: "cursor", x: 500, y: 300 }, top());
    step("Opening localhost", "rest");

    expect(cursor()?.style.transform).toBe(`translate3d(16px, ${768 - 16 - 24}px, 0)`);
    expect(shownWords()).toBe("Opening localhost");
  });

  it("a rest step with no pointer draws it at the rest spot", () => {
    step("Opening localhost", "rest");
    expect(cursor()?.style.transform).toBe(restTransform());
  });

  it("the next move travels from the rest spot", () => {
    installAnimate();
    applyCursor({ type: "cursor", x: 500, y: 300 }, top());
    step("Opening localhost", "rest");
    animations = [];

    void moveCursor({ type: "cursor", x: 400, y: 200 }, top());

    const [animation] = pointerAnimations();
    expect(animation?.keyframes[0]?.transform).toBe(restTransform());
    expect(animation?.keyframes.at(-1)?.transform).toBe("translate3d(400px, 200px, 0)");
  });

  it("a viewport resize while resting places it again, without animation", () => {
    installAnimate();
    step("Opening localhost", "rest");
    animations = [];

    setViewport(800, 500);
    VIEW.dispatchEvent(new Event("resize"));

    expect(cursor()?.style.transform).toBe("translate3d(16px, 460px, 0)");
    expect(animations, "re-placed, not animated").toEqual([]);
  });

  it("a resize while pointing leaves the pointer where the agent put it", () => {
    applyCursor({ type: "cursor", x: 500, y: 300 }, top());
    step("Clicking");
    setViewport(800, 500);
    VIEW.dispatchEvent(new Event("resize"));
    expect(cursor()?.style.transform).toBe("translate3d(500px, 300px, 0)");
  });

  it("stops listening for resizes when the pointer leaves", () => {
    step("Opening localhost", "rest");
    removeCursor(document);
    setViewport(800, 500);
    expect(() => VIEW.dispatchEvent(new Event("resize"))).not.toThrow();
    expect(cursor()).toBeNull();
  });
});

describe("033/T993 the press ripple", () => {
  it("adds one marked ring at the tip on arrival, and takes it away on animationend", async () => {
    await moveCursor({ type: "cursor", x: 140, y: 50 }, top());
    expect(rings(), "no press, no ring").toHaveLength(0);

    await moveCursor({ type: "cursor", x: 300, y: 90, press: true }, top());

    expect(rings()).toHaveLength(1);
    const ring = rings()[0] as HTMLElement;
    expect(ring.getAttribute(INDICATOR_MARKER_ATTRIBUTE)).toBe("");
    expect(ring.getAttribute("aria-hidden")).toBe("true");
    expect(ring.style.left).toBe("300px");
    expect(ring.style.top).toBe("90px");
    expect(ring.style.pointerEvents).toBe("none");
    expect(textNodesUnder(ring)).toBe(0);

    ring.dispatchEvent(new Event("animationend"));
    expect(rings()).toHaveLength(0);
  });

  it("is gone within 700 ms even when animationend never comes", async () => {
    vi.useFakeTimers();
    await moveCursor({ type: "cursor", x: 140, y: 50, press: true }, top());
    expect(rings()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(699);
    expect(rings()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rings()).toHaveLength(0);
  });

  it("waits for the arrival: the ring is not there while the pointer is still travelling", async () => {
    installAnimate();
    applyCursor({ type: "cursor", x: 10, y: 10 }, top());
    const arrival = moveCursor({ type: "cursor", x: 600, y: 400, press: true }, top());
    await Promise.resolve();
    expect(rings(), "still travelling").toHaveLength(0);

    pointerAnimations()[0]?.finish();
    await arrival;
    expect(rings()).toHaveLength(1);
  });

  it("shows at once for a press at the point the pointer is already at", async () => {
    applyCursor({ type: "cursor", x: 140, y: 50 }, top());
    await moveCursor({ type: "cursor", x: 140, y: 50, press: true }, top());
    expect(rings()).toHaveLength(1);
  });

  it("under reduced motion the ring is the fading kind, and the pointer is placed without travel", async () => {
    installAnimate();
    stubReducedMotion(true);
    applyCursor({ type: "cursor", x: 10, y: 10 }, top());
    await moveCursor({ type: "cursor", x: 600, y: 400, press: true }, top());

    expect(animations, "no travel under reduced motion").toEqual([]);
    expect(cursor()?.style.transform).toBe("translate3d(600px, 400px, 0)");
    expect(rings()[0]?.hasAttribute("data-reduced"), "fades instead of spreading").toBe(true);
  });

  it("the ordinary ring spreads (it is not marked reduced)", async () => {
    stubReducedMotion(false);
    await moveCursor({ type: "cursor", x: 140, y: 50, press: true }, top());
    expect(rings()[0]?.hasAttribute("data-reduced")).toBe(false);
  });

  it("the stylesheet holds the ring's 6 to 34 px spread over 520 ms and the 250 ms fade", async () => {
    await moveCursor({ type: "cursor", x: 140, y: 50, press: true }, top());
    const css = document.querySelector("style")?.textContent ?? "";
    expect(css).toContain("520ms");
    expect(css).toContain("250ms");
    expect(css).toMatch(/scale\(\s*5\.6\d*\s*\)/u);
  });

  it("leaves with the pointer", async () => {
    await moveCursor({ type: "cursor", x: 140, y: 50, press: true }, top());
    removeCursor(document);
    expect(rings()).toHaveLength(0);
    expect(document.querySelectorAll("style")).toHaveLength(0);
  });
});

/**
 * 033/T993-T994 arrival - when the worker may press. The answer is the animation's own end, a
 * timer at its duration plus 60 ms when that never comes, and "now" when there was nothing to watch.
 */
describe("T126 + 033/T994 arrival - when the worker may press", () => {
  it("plays the planned frames from where the pointer is to the target", async () => {
    installAnimate();
    applyCursor({ type: "cursor", x: 100, y: 100 }, top());
    void moveCursor({ type: "cursor", x: 500, y: 300 }, top());

    const plan = planTravel({ x: 100, y: 100 }, { x: 500, y: 300 }, false);
    const animation = pointerAnimations()[0];
    expect(animation?.options).toBe(plan.durationMs);
    expect(animation?.keyframes).toHaveLength(12);
    expect(animation?.keyframes[0]?.transform).toBe("translate3d(100px, 100px, 0)");
    expect(animation?.keyframes[11]?.transform).toBe("translate3d(500px, 300px, 0)");
    expect(animation?.keyframes.map((frame) => frame.transform)).toEqual(plan.frames.map((frame) => frame.transform));
    // The element rests on the target once the animation is over (and is already there if it fails).
    expect(cursor()?.style.transform).toBe("translate3d(500px, 300px, 0)");
  });

  it("tilts the arrow on its own inner element, upright at both ends", () => {
    installAnimate();
    applyCursor({ type: "cursor", x: 100, y: 100 }, top());
    void moveCursor({ type: "cursor", x: 500, y: 300 }, top());

    const tilt = tiltAnimations()[0];
    expect(tilt, "the arrow has its own track").toBeDefined();
    expect(tilt?.target.parentElement).toBe(cursor());
    expect(tilt?.target.querySelector("svg"), "the tilted element holds the arrow").not.toBeNull();
    expect(tilt?.keyframes[0]?.transform).toBe("rotate(0deg)");
    expect(tilt?.keyframes[11]?.transform).toBe("rotate(0deg)");
    expect(tilt?.keyframes.some((frame) => frame.transform !== "rotate(0deg)")).toBe(true);
  });

  it("arrives when the animation finishes", async () => {
    installAnimate();
    applyCursor({ type: "cursor", x: 10, y: 10 }, top());
    let arrived = false;
    void moveCursor({ type: "cursor", x: 140, y: 50 }, top())?.then(() => {
      arrived = true;
    });

    await Promise.resolve();
    expect(arrived, "still travelling").toBe(false);

    pointerAnimations()[0]?.finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(arrived).toBe(true);
  });

  it("arrives on the fallback timer, 60 ms past the duration, when the animation never reports", async () => {
    vi.useFakeTimers();
    installAnimate();
    applyCursor({ type: "cursor", x: 10, y: 10 }, top());
    const { durationMs } = planTravel({ x: 10, y: 10 }, { x: 140, y: 50 }, false);
    let arrived = false;
    void moveCursor({ type: "cursor", x: 140, y: 50 }, top())?.then(() => {
      arrived = true;
    });

    // Timers count whole milliseconds, so stay a clear millisecond short of the fractional deadline.
    await vi.advanceTimersByTimeAsync(Math.floor(durationMs) + 58);
    expect(arrived, "not before the animation could have finished").toBe(false);
    await vi.advanceTimersByTimeAsync(3);
    expect(arrived).toBe(true);
  });

  it("a new move cancels the running one and starts from where the pointer is now", async () => {
    installAnimate();
    applyCursor({ type: "cursor", x: 100, y: 100 }, top());
    let firstArrived = false;
    void moveCursor({ type: "cursor", x: 500, y: 300 }, top())?.then(() => {
      firstArrived = true;
    });
    const first = pointerAnimations()[0];
    // What the browser would answer mid-flight: the animated position, not the resting style.
    vi.spyOn(VIEW, "getComputedStyle").mockReturnValue({ transform: "matrix(1, 0, 0, 1, 250, 180)" } as CSSStyleDeclaration);

    void moveCursor({ type: "cursor", x: 50, y: 60 }, top());

    expect(first?.canceled).toBe(true);
    const second = pointerAnimations()[1];
    expect(second?.keyframes[0]?.transform).toBe("translate3d(250px, 180px, 0)");
    expect(second?.keyframes[11]?.transform).toBe("translate3d(50px, 60px, 0)");
    await Promise.resolve();
    await Promise.resolve();
    expect(firstArrived, "nobody keeps waiting on a move that was replaced").toBe(true);
  });

  it("arrives at once when it is already there, with no animation", async () => {
    vi.useFakeTimers();
    installAnimate();
    applyCursor({ type: "cursor", x: 140, y: 50 }, top());
    let arrived = false;
    void moveCursor({ type: "cursor", x: 140, y: 50 }, top())?.then(() => {
      arrived = true;
    });

    await Promise.resolve();
    expect(arrived, "no distance, no wait").toBe(true);
    expect(animations).toEqual([]);
  });

  it("arrives at once on first sight - it is placed, not animated in from the corner", async () => {
    vi.useFakeTimers();
    installAnimate();
    let arrived = false;
    void moveCursor({ type: "cursor", x: 140, y: 50 }, top())?.then(() => {
      arrived = true;
    });

    await Promise.resolve();
    expect(arrived).toBe(true);
    expect(cursor()?.style.transform).toBe("translate3d(140px, 50px, 0)");
    expect(animations).toEqual([]);
  });

  it("arrives at once, with the final transform, when the document is hidden", async () => {
    installAnimate();
    applyCursor({ type: "cursor", x: 10, y: 10 }, top());
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    let arrived = false;
    void moveCursor({ type: "cursor", x: 140, y: 50 }, top())?.then(() => {
      arrived = true;
    });

    await Promise.resolve();
    expect(arrived).toBe(true);
    expect(animations).toEqual([]);
    expect(cursor()?.style.transform).toBe("translate3d(140px, 50px, 0)");
  });

  it("arrives at once, with the final transform, when the browser has no animate", async () => {
    applyCursor({ type: "cursor", x: 10, y: 10 }, top());
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
 * The entry's half: a cursor message is answered when the pointer has arrived, a pointer step is
 * not answered at all, and the pointer leaves the page with the indicator - the `show: false` that
 * says the tab left the session.
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
      id: EXTENSION,
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

    const kept = listener({ type: "cursor", x: 140, y: 50 }, { id: EXTENSION }, sendResponse);

    expect(kept, "the reply is asynchronous, so the channel stays open").toBe(true);
    await Promise.resolve();
    expect(sendResponse).toHaveBeenCalledWith({ arrived: true });
    expect(cursor()?.style.transform).toBe("translate3d(140px, 50px, 0)");
  });

  it("removes the pointer when the indicator is lowered", () => {
    const { listener } = bind();
    listener({ type: "cursor", x: 140, y: 50 }, { id: EXTENSION }, () => undefined);
    listener({ type: "pointer-step", words: "Clicking", mode: "stay" }, { id: EXTENSION }, () => undefined);
    expect(cursor()).not.toBeNull();

    const kept = listener({ type: "indicator", show: false }, { id: EXTENSION }, () => undefined);

    expect(kept).toBe(false);
    expect(cursor(), "the tab left the session; the pointer leaves with the banner").toBeNull();
    expect(caption()).toBeNull();
    expect(document.querySelectorAll("style")).toHaveLength(0);
  });

  it("survives a reply channel that already closed", async () => {
    const { listener } = bind();
    const sendResponse = vi.fn(() => {
      throw new Error("The message port closed before a response was received.");
    });

    listener({ type: "cursor", x: 140, y: 50 }, { id: EXTENSION }, sendResponse);
    await Promise.resolve();
    await Promise.resolve();

    expect(sendResponse).toHaveBeenCalled();
  });

  it("routes a pointer step: drawn, no reply, channel not kept open", () => {
    const { listener } = bind();
    const sendResponse = vi.fn();

    const kept = listener({ type: "pointer-step", words: "Reading page", mode: "stay" }, { id: EXTENSION }, sendResponse);

    expect(kept).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    expect(shownWords()).toBe("Reading page");
    expect(cursor()?.style.transform).toBe(restTransform());
  });

  it("a step stored by `travel` is drawn by the cursor message that follows, press ring included", async () => {
    const { listener } = bind();
    const sendResponse = vi.fn();

    listener({ type: "pointer-step", words: "Clicking", mode: "travel" }, { id: EXTENSION }, sendResponse);
    expect(cursor()).toBeNull();
    listener({ type: "cursor", x: 140, y: 50, press: true }, { id: EXTENSION }, sendResponse);
    await Promise.resolve();

    expect(sendResponse).toHaveBeenCalledWith({ arrived: true });
    expect(shownWords()).toBe("Clicking");
    expect(rings()).toHaveLength(1);
  });

  it("ignores a step from another sender, and malformed steps, without a reply", () => {
    const { listener } = bind();
    const sendResponse = vi.fn();
    const good = { type: "pointer-step", words: "Reading page", mode: "stay" };

    expect(listener(good, { id: "someone-else" }, sendResponse)).toBe(false);
    expect(listener(good, {}, sendResponse)).toBe(false);
    expect(listener({ ...good, words: "x".repeat(61) }, { id: EXTENSION }, sendResponse)).toBe(false);
    expect(listener({ ...good, extra: 1 }, { id: EXTENSION }, sendResponse)).toBe(false);
    expect(listener({ ...good, mode: "fly" }, { id: EXTENSION }, sendResponse)).toBe(false);
    expect(listener({ type: "cursor", x: 1, y: 2, press: false }, { id: EXTENSION }, sendResponse)).toBe(false);

    expect(cursor()).toBeNull();
    expect(sendResponse).not.toHaveBeenCalled();
  });
});

/**
 * 033/T995, FR-504 - the caption is a mark, not content: whatever the agent reads from the page
 * has none of its words in it. Generated content is not in the DOM, so nothing needs a new rule.
 */
describe("033/T995 the caption is not page text", () => {
  it("read_page's structure, the visible text, find's candidates and the document's own text carry none of the words", async () => {
    document.body.innerHTML = '<p>Ordinary page text</p><button type="button">Real button</button>';
    step("Reading page text", "travel");
    await moveCursor({ type: "cursor", x: 140, y: 50, press: true }, top());
    step("Finding “Sign in”");
    expect(shownWords()).toBe("Finding “Sign in”");

    const snapshot = snapshotDocument(document, "https://page.test", 200, undefined, "all-controls");
    const everything = JSON.stringify(snapshot);
    for (const word of ["Reading page text", "Finding", "Sign in"]) {
      expect(everything, `snapshot mentions ${word}`).not.toContain(word);
    }
    expect(snapshot.targets.map((target) => target.role), "find can only choose among these").toEqual([
      "paragraph",
      "button",
    ]);
    const visible = visibleTextOf(INDICATOR_MARKER_ATTRIBUTE);
    expect(visible).toContain("Ordinary page text");
    for (const word of ["Reading", "Finding", "Sign in"]) expect(visible, `visible text mentions ${word}`).not.toContain(word);
    // What a page's own text search or selection would reach.
    expect(document.documentElement.textContent).not.toContain("Reading page text");
    expect(document.documentElement.textContent).not.toContain("Sign in");
  });
});

/**
 * 033/T996, FR-509, R-499 - the marks are hidden for a capture returned to the agent, and always
 * come back. The hiding is inline `opacity` and `transition` set from script, never the injected
 * stylesheet: a strict page CSP may block that sheet, and inline CSSOM writes are not subject to it.
 * Nothing else about the marks changes, so the page cannot learn a capture is under way from layout
 * or from what lies under a point.
 */
describe("033/T996 marks hidden for an agent capture", () => {
  type Listener = (
    message: unknown,
    sender: { id?: string },
    sendResponse: (response: unknown) => void,
  ) => boolean | void;

  const HIDDEN = "data-hallpass-hidden";
  let frames: Array<() => void> = [];

  function bind(): Listener {
    const captured: { listener?: Listener } = {};
    bindAgentContentRuntime(
      {
        id: EXTENSION,
        sendMessage: () => undefined,
        onMessage: {
          addListener: (listener: Listener) => {
            captured.listener = listener;
          },
        },
      },
      document,
    );
    if (!captured.listener) throw new Error("listener not registered");
    return captured.listener;
  }

  /** Two animation frames are the page's "painted"; the test runs them by hand. */
  function stubFrames(): void {
    frames = [];
    Object.defineProperty(VIEW, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: (callback: (time: number) => void) => {
        frames.push(() => callback(0));
        return frames.length;
      },
    });
  }

  function runFrame(): void {
    for (const frame of frames.splice(0)) frame();
  }

  function pill(): HTMLElement | null {
    return document.querySelector<HTMLElement>("[data-hallpass-pill]");
  }

  function glow(): HTMLElement | null {
    return document.querySelector<HTMLElement>("[data-hallpass-glow]");
  }

  /** Every mark the page can be wearing: pill, glow, pointer, caption and press ring. */
  function marks(): HTMLElement[] {
    return [pill(), glow(), cursor(), caption(), ...rings()].filter((element): element is HTMLElement => element !== null);
  }

  function drawEverything(listener: Listener): void {
    const from = { id: EXTENSION };
    listener({ type: "indicator", show: true, label: "Agent", action: "Back" }, from, () => undefined);
    listener({ type: "pointer-step", words: "Clicking", mode: "travel" }, from, () => undefined);
    listener({ type: "cursor", x: 140, y: 50, press: true }, from, () => undefined);
    expect(marks()).toHaveLength(5);
  }

  function layoutOf(element: HTMLElement): Record<string, string> {
    const { display, visibility, position, left, top, width, height, transform, zIndex, pointerEvents } = element.style;
    return { display, visibility, position, left, top, width, height, transform, zIndex, pointerEvents };
  }

  afterEach(() => {
    // The page keeps its hidden state per document between tests; every test ends with it lifted.
    bind()({ type: "marks", hidden: false }, { id: EXTENSION }, () => undefined);
    delete (VIEW as unknown as Record<string, unknown>)["requestAnimationFrame"];
    frames = [];
  });

  it("hides pointer, caption, ring, pill and glow with inline !important styles, and answers after two frames", () => {
    stubFrames();
    const listener = bind();
    drawEverything(listener);
    const before = marks().map(layoutOf);
    const sendResponse = vi.fn();

    const kept = listener({ type: "marks", hidden: true }, { id: EXTENSION }, sendResponse);

    expect(kept, "the reply comes after the frames, so the channel stays open").toBe(true);
    for (const mark of marks()) {
      expect(mark.hasAttribute(HIDDEN), `${mark.outerHTML.slice(0, 40)} wears the hidden attribute`).toBe(true);
      expect(mark.style.getPropertyValue("opacity")).toBe("0");
      expect(mark.style.getPropertyPriority("opacity"), "beats the glow's animation too").toBe("important");
      // (jsdom's CSSOM drops the priority of the `transition` shorthand, so only its value is pinned.)
      expect(mark.style.getPropertyValue("transition")).toBe("none");
    }
    expect(marks().map(layoutOf), "nothing moves and nothing under any point changes").toEqual(before);
    expect(document.querySelector("style[data-hallpass-cursor-style]")?.textContent ?? "").not.toContain(HIDDEN);

    expect(sendResponse).not.toHaveBeenCalled();
    runFrame();
    expect(sendResponse, "one frame is not yet painted").not.toHaveBeenCalled();
    runFrame();
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ painted: true });
  });

  it("restores on hidden:false at once, with each mark's own previous inline values, and answers after two frames", () => {
    stubFrames();
    const listener = bind();
    drawEverything(listener);
    expect(glow()?.style.opacity, "the glow has an inline resting opacity of its own").toBe("0.85");
    cursor()?.style.setProperty("transition", "transform 1s");
    cursor()?.style.setProperty("opacity", "0.5", "important");
    listener({ type: "marks", hidden: true }, { id: EXTENSION }, () => undefined);
    runFrame();
    runFrame();

    const sendResponse = vi.fn();
    const kept = listener({ type: "marks", hidden: false }, { id: EXTENSION }, sendResponse);

    expect(kept, "033 review I2: the show is answered after the frames, so the channel stays open").toBe(true);
    for (const mark of marks()) expect(mark.hasAttribute(HIDDEN), "the marks return at once").toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    runFrame();
    expect(sendResponse, "one frame is not yet painted").not.toHaveBeenCalled();
    runFrame();
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ painted: true });
    expect(glow()?.style.opacity).toBe("0.85");
    expect(pill()?.style.opacity).toBe("");
    expect(pill()?.style.transition).toBe("");
    expect(cursor()?.style.getPropertyValue("transition")).toBe("transform 1s");
    expect(cursor()?.style.getPropertyValue("opacity")).toBe("0.5");
    expect(cursor()?.style.getPropertyPriority("opacity"), "priority is restored with the value").toBe("important");
  });

  it("shows without a fade: opacity is back while transition is still none, a style flush, then the transition", () => {
    stubFrames();
    const listener = bind();
    drawEverything(listener);
    const target = caption() as HTMLElement;
    // The caption fades opacity over 200 ms; inline values of its own make the restore visible.
    target.style.setProperty("transition", "opacity 200ms ease");
    target.style.setProperty("opacity", "1");
    listener({ type: "marks", hidden: true }, { id: EXTENSION }, () => undefined);
    const seen: Array<{ opacity: string; transition: string; priority: string }> = [];
    const original = VIEW.getComputedStyle.bind(VIEW);
    const spy = vi.spyOn(VIEW, "getComputedStyle").mockImplementation((element: Element, pseudo?: string | null) => {
      if (element === target) {
        seen.push({
          opacity: target.style.getPropertyValue("opacity"),
          transition: target.style.getPropertyValue("transition"),
          priority: target.style.getPropertyPriority("opacity"),
        });
      }
      return original(element, pseudo);
    });
    listener({ type: "marks", hidden: false }, { id: EXTENSION }, () => undefined);
    spy.mockRestore();

    expect(seen, "the caption's style is flushed once between the two restores").toHaveLength(1);
    expect(seen[0]!.opacity, "opacity is already back at the flush").not.toBe("0");
    expect(seen[0]!.transition, "the transition is still none at the flush, so nothing fades in").toBe("none");
    expect(target.style.getPropertyValue("transition")).toBe("opacity 200ms ease");
    expect(target.style.getPropertyValue("opacity")).toBe("1");
  });

  it("replies at once to a show when the document has no animation frames to wait for", () => {
    const listener = bind();
    drawEverything(listener);
    listener({ type: "marks", hidden: true }, { id: EXTENSION }, () => undefined);
    delete (VIEW as unknown as Record<string, unknown>)["requestAnimationFrame"];
    const sendResponse = vi.fn();

    const kept = listener({ type: "marks", hidden: false }, { id: EXTENSION }, sendResponse);

    expect(kept).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ painted: true });
  });

  it("restores itself 3 s after hiding when no hidden:false comes", () => {
    vi.useFakeTimers();
    stubFrames();
    const listener = bind();
    drawEverything(listener);
    listener({ type: "marks", hidden: true }, { id: EXTENSION }, () => undefined);

    vi.advanceTimersByTime(2999);
    expect(marks().every((mark) => mark.hasAttribute(HIDDEN))).toBe(true);
    vi.advanceTimersByTime(1);

    for (const mark of marks()) {
      expect(mark.hasAttribute(HIDDEN)).toBe(false);
      expect(mark.style.getPropertyValue("opacity")).not.toBe("0");
    }
    expect(glow()?.style.opacity).toBe("0.85");
  });

  it("a second hide does not forget the first one's previous values", () => {
    stubFrames();
    const listener = bind();
    drawEverything(listener);
    listener({ type: "marks", hidden: true }, { id: EXTENSION }, () => undefined);
    listener({ type: "marks", hidden: true }, { id: EXTENSION }, () => undefined);

    listener({ type: "marks", hidden: false }, { id: EXTENSION }, () => undefined);

    expect(glow()?.style.opacity, "not left at 0").toBe("0.85");
    expect(glow()?.hasAttribute(HIDDEN)).toBe(false);
  });

  it("a pointer, caption, ring, pill or glow made while hidden is hidden too, and shown by hidden:false", () => {
    stubFrames();
    const listener = bind();
    listener({ type: "marks", hidden: true }, { id: EXTENSION }, () => undefined);

    drawEverything(listener);

    for (const mark of marks()) {
      expect(mark.hasAttribute(HIDDEN), `${mark.outerHTML.slice(0, 40)} made while hidden`).toBe(true);
      expect(mark.style.getPropertyValue("opacity")).toBe("0");
      expect(mark.style.getPropertyPriority("opacity")).toBe("important");
    }

    listener({ type: "marks", hidden: false }, { id: EXTENSION }, () => undefined);
    for (const mark of marks()) expect(mark.hasAttribute(HIDDEN)).toBe(false);
    expect(glow()?.style.opacity).toBe("0.85");
    expect(pill()?.style.opacity).toBe("");
  });

  it("a mark made after hidden:false is not hidden", () => {
    stubFrames();
    const listener = bind();
    listener({ type: "marks", hidden: true }, { id: EXTENSION }, () => undefined);
    listener({ type: "marks", hidden: false }, { id: EXTENSION }, () => undefined);

    drawEverything(listener);

    for (const mark of marks()) expect(mark.hasAttribute(HIDDEN)).toBe(false);
  });

  it("ignores another sender and every malformed shape, without a reply", () => {
    stubFrames();
    const listener = bind();
    drawEverything(listener);
    const sendResponse = vi.fn();
    const good = { type: "marks", hidden: true };

    expect(listener(good, { id: "someone-else" }, sendResponse)).toBe(false);
    expect(listener(good, {}, sendResponse)).toBe(false);
    expect(listener({ ...good, extra: 1 }, { id: EXTENSION }, sendResponse)).toBe(false);
    expect(listener({ type: "marks", hidden: "yes" }, { id: EXTENSION }, sendResponse)).toBe(false);
    expect(listener({ type: "marks", hidden: 1 }, { id: EXTENSION }, sendResponse)).toBe(false);
    expect(listener({ type: "marks" }, { id: EXTENSION }, sendResponse)).toBe(false);
    expect(listener(["marks", true], { id: EXTENSION }, sendResponse)).toBe(false);
    runFrame();
    runFrame();

    expect(sendResponse).not.toHaveBeenCalled();
    for (const mark of marks()) expect(mark.hasAttribute(HIDDEN)).toBe(false);
  });
});
