/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { visibleTextOf } from "../src/content-runtime/visible-text.js";

/**
 * Issue #37 - `visibleTextOf` leaves out text the owner cannot see.
 *
 * jsdom has no layout: no `checkVisibility`, no `Range.getBoundingClientRect`, and every element box is
 * empty. The fixtures below supply what the browser would answer, from attributes on the element:
 * `data-css-hidden` (the element or an ancestor is display:none / visibility:hidden / opacity:0),
 * `data-rect="left,top,width,height"` (the box of the text inside it, viewport coordinates) and
 * `data-box="width,height"` (the element's own box). The real answers are the packaged gate's claim
 * (tests/e2e/packaged/agent-reads.spec.ts).
 */

const MARKER = "data-hallpass-indicator";

type Patchable = Record<string, unknown>;
const restores: Array<() => void> = [];

function patch(target: Patchable, key: string, value: unknown): void {
  const had = Object.prototype.hasOwnProperty.call(target, key);
  const before = target[key];
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  restores.push(() => {
    if (had) Object.defineProperty(target, key, { value: before, configurable: true, writable: true });
    else delete target[key];
  });
}

function numbers(raw: string | null | undefined, fallback: number[]): number[] {
  return raw ? raw.split(",").map(Number) : fallback;
}

/** The answers a browser with layout gives; a fixture element says what is special about it. */
function installLayout(): void {
  patch(Element.prototype as unknown as Patchable, "checkVisibility", function (this: Element) {
    // Chromium's answer, measured in the packaged gate: an element without a box of its own is "not visible".
    if (getComputedStyle(this).display === "contents") return false;
    return this.closest("[data-css-hidden]") === null;
  });
  patch(Element.prototype as unknown as Patchable, "getBoundingClientRect", function (this: Element) {
    const [width = 0, height = 0] = numbers(this.getAttribute("data-box"), [800, 600]);
    return { left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0 };
  });
  patch(Range.prototype as unknown as Patchable, "getBoundingClientRect", function (this: Range) {
    const node = this.startContainer;
    if (/^\s*$/u.test(node.textContent ?? "")) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    const owner = node.parentElement?.closest("[data-rect]") ?? null;
    const [left = 10, top = 10, width = 100, height = 20] = numbers(owner?.getAttribute("data-rect"), [10, 10, 100, 20]);
    return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top };
  });
}

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
  document.body.innerHTML = "";
});

describe("issue #37 visibleTextOf, the live walk", () => {
  it("returns what the owner can see and leaves out what a stylesheet or the geometry hides", () => {
    installLayout();
    document.body.innerHTML = [
      "<p>normalword</p>",
      "<p data-rect='10,3000,100,20'>belowfoldword</p>",
      "<div style='display:contents' data-box='0,0'><p>contentsword</p></div>",
      "<p data-css-hidden>nonedword</p>",
      "<p data-rect='-9999,10,100,20'>offscreenword</p>",
      "<p data-rect='10,-9999,100,20'>aboveword</p>",
      "<p data-rect='10,10,0,0'>emptyrectword</p>",
      "<p style='overflow-x:hidden;overflow-y:hidden' data-box='1,1'>clippedword</p>",
      "<p>alpha</p>\n<p>beta</p>",
    ].join("\n");

    const text = visibleTextOf(MARKER);

    expect(text).toContain("normalword");
    expect(text).toContain("belowfoldword");
    expect(text).toContain("contentsword");
    expect(text).not.toContain("nonedword");
    expect(text).not.toContain("offscreenword");
    expect(text).not.toContain("aboveword");
    expect(text).not.toContain("emptyrectword");
    expect(text).not.toContain("clippedword");
    expect(text).toMatch(/alpha\s+beta/u);
  });

  it("asks the nearest element with a box about text directly inside `display:contents`", () => {
    installLayout();
    document.body.innerHTML = [
      "<p style='display:contents' data-box='0,0'>directword</p>",
      "<div style='display:contents' data-box='0,0'><span style='display:contents' data-box='0,0'>nestedword</span></div>",
      "<p style='display:contents;overflow-x:hidden;overflow-y:hidden' data-box='0,0'>overflowword</p>",
      "<p style='display:contents;visibility:hidden' data-box='0,0'>invisibleword</p>",
      "<div data-css-hidden><p style='display:contents' data-box='0,0'>insidehiddenword</p></div>",
      "<div style='overflow-x:hidden;overflow-y:hidden' data-box='1,1'><p style='display:contents' data-box='0,0'>insideclippedword</p></div>",
    ].join("\n");

    const text = visibleTextOf(MARKER);

    expect(text).toContain("directword");
    expect(text).toContain("nestedword");
    expect(text).toContain("overflowword");
    expect(text).not.toContain("invisibleword");
    expect(text).not.toContain("insidehiddenword");
    expect(text).not.toContain("insideclippedword");
  });

  it("keeps the whitespace between visible parts, so words are not glued together", () => {
    installLayout();
    document.body.innerHTML = "<span>one</span> <span>two</span>";
    expect(visibleTextOf(MARKER)).toBe("one two");
  });

  it("leaves out controls, scripts, hidden and aria-hidden parts and the indicator layer", () => {
    installLayout();
    document.body.innerHTML = [
      "<p>keptword</p>",
      "<textarea>areaword</textarea>",
      "<select><option>optionword</option></select>",
      "<script>scriptword</script>",
      "<style>styleword{}</style>",
      "<template>templateword</template>",
      "<div hidden>hiddenword</div>",
      "<div aria-hidden='true'><b>ariaword</b></div>",
      `<div ${MARKER}>markerword</div>`,
    ].join("");
    expect(visibleTextOf(MARKER)).toBe("keptword");
  });

  it("keeps everything when the environment has no layout to ask", () => {
    document.body.innerHTML = "<p>plainword</p><p style='overflow-x:hidden;overflow-y:hidden'>clippedplainword</p>";
    expect(visibleTextOf(MARKER)).toBe("plainwordclippedplainword");
  });

  it("keeps everything when every box is empty, as in a document with no layout", () => {
    patch(Element.prototype as unknown as Patchable, "getBoundingClientRect", () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }));
    patch(Range.prototype as unknown as Patchable, "getBoundingClientRect", () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }));
    document.body.innerHTML = "<p>emptyword</p><p style='overflow-x:hidden;overflow-y:hidden'>emptyclippedword</p>";
    expect(visibleTextOf(MARKER)).toBe("emptywordemptyclippedword");
  });

  it("still takes a body that is a bare object, through the clone", () => {
    const clone = { textContent: " cloned ", querySelectorAll: () => [] as Array<{ remove?: () => void }> };
    expect(visibleTextOf(MARKER, { cloneNode: () => clone })).toBe("cloned");
    expect(visibleTextOf(MARKER, { innerText: " typed " })).toBe("typed");
  });
});
