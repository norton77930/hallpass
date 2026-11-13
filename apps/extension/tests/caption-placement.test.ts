import { describe, expect, it } from "vitest";
import { placeCaption, type CaptionCorner } from "../src/content-runtime/caption-placement.js";

/**
 * 033/T989 - where the caption sits next to the pointer (R-495, FR-503, SC-220).
 *
 * Pure arithmetic: the page measures the caption once per change of words and asks here. The
 * rules are the whole of "never leaves the viewport", so they are proved on numbers.
 */

const SPARE = 8;
/** How far right of the tip the default caption starts (R-495's `gap`). */
const GAP_X = 14;
const CAPTION = { width: 160, height: 26 };

type Box = { left: number; top: number; right: number; bottom: number };

function boxOf(
  point: { x: number; y: number },
  result: ReturnType<typeof placeCaption>,
  height = CAPTION.height,
): Box {
  const left = point.x + result.offset.x;
  const top = point.y + result.offset.y;
  return { left, top, right: left + result.width, bottom: top + height };
}

function cornerPoint(box: Box, corner: CaptionCorner): { x: number; y: number } {
  return {
    x: corner.endsWith("left") ? box.left : box.right,
    y: corner.startsWith("top") ? box.top : box.bottom,
  };
}

function nearestCorner(box: Box, tip: { x: number; y: number }): CaptionCorner {
  const corners: CaptionCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
  return corners.reduce((best, corner) => {
    const a = cornerPoint(box, corner);
    const b = cornerPoint(box, best);
    return Math.hypot(a.x - tip.x, a.y - tip.y) < Math.hypot(b.x - tip.x, b.y - tip.y) ? corner : best;
  });
}

describe("033/T989 placeCaption sides", () => {
  const viewport = { width: 1280, height: 800 };

  it("sits below-right of the tip by default, its pointed corner toward the tip", () => {
    const point = { x: 400, y: 300 };
    const result = placeCaption({ viewport, point, caption: CAPTION, atRest: false });
    expect(result.side).toBe("below-right");
    expect(result.corner).toBe("top-left");
    expect(result.offset.x).toBeGreaterThan(0);
    expect(result.offset.y).toBeGreaterThan(0);
    expect(result.width).toBe(CAPTION.width);
    expect(nearestCorner(boxOf(point, result), point)).toBe("top-left");
  });

  it("moves to the left of the pointer when it would pass the right edge", () => {
    const point = { x: 1270, y: 300 };
    const result = placeCaption({ viewport, point, caption: CAPTION, atRest: false });
    expect(result.side).toBe("left");
    expect(result.corner).toBe("top-right");
    const box = boxOf(point, result);
    expect(box.right).toBeLessThanOrEqual(point.x);
    expect(nearestCorner(box, point)).toBe("top-right");
  });

  it("moves above the pointer when it would pass the bottom edge", () => {
    const point = { x: 400, y: 790 };
    const result = placeCaption({ viewport, point, caption: CAPTION, atRest: false });
    expect(result.side).toBe("above");
    expect(result.corner).toBe("bottom-left");
    const box = boxOf(point, result);
    expect(box.bottom).toBeLessThanOrEqual(point.y);
    expect(nearestCorner(box, point)).toBe("bottom-left");
  });

  it("goes above and to the left near the bottom-right corner, pointed corner still toward the tip", () => {
    const point = { x: 1275, y: 795 };
    const result = placeCaption({ viewport, point, caption: CAPTION, atRest: false });
    expect(result.side).toBe("above");
    expect(result.corner).toBe("bottom-right");
    expect(nearestCorner(boxOf(point, result), point)).toBe("bottom-right");
  });

  it("switches exactly where the caption would stop being 8 px inside", () => {
    const inside = placeCaption({
      viewport,
      point: { x: 1280 - SPARE - 160 - GAP_X, y: 300 },
      caption: CAPTION,
      atRest: false,
    });
    const past = placeCaption({
      viewport,
      point: { x: 1280 - SPARE - 160 - GAP_X + 1, y: 300 },
      caption: CAPTION,
      atRest: false,
    });
    expect(inside.side).toBe("below-right");
    expect(past.side).toBe("left");
  });

  it("at the rest spot it sits beside the arrow instead of dropping below the screen", () => {
    const point = { x: 16, y: 800 - 16 - 24 };
    const result = placeCaption({ viewport, point, caption: CAPTION, atRest: true });
    expect(result.side).toBe("below-right");
    const box = boxOf(point, result);
    expect(box.left).toBeGreaterThan(point.x);
    expect(box.bottom).toBeLessThanOrEqual(800 - SPARE);
  });
});

describe("033/T989 placeCaption SC-220: the 16 placements", () => {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 400, height: 700 },
  ]) {
    const xs = [0, viewport.width / 2, viewport.width];
    const ys = [0, viewport.height / 2, viewport.height];
    const points = xs.flatMap((x) => ys.map((y) => ({ x, y }))).filter((p) => !(p.x === xs[1] && p.y === ys[1]));
    it(`keeps the caption at least 8 px inside at the corners and edge midpoints of ${viewport.width}x${viewport.height}`, () => {
      expect(points).toHaveLength(8);
      for (const point of points) {
        const result = placeCaption({ viewport, point, caption: CAPTION, atRest: false });
        const box = boxOf(point, result);
        const where = `${viewport.width}x${viewport.height} at (${point.x}, ${point.y}) -> ${result.side}`;
        expect(box.left, where).toBeGreaterThanOrEqual(SPARE);
        expect(box.top, where).toBeGreaterThanOrEqual(SPARE);
        expect(box.right, where).toBeLessThanOrEqual(viewport.width - SPARE);
        expect(box.bottom, where).toBeLessThanOrEqual(viewport.height - SPARE);
      }
    });
  }
});

describe("033/T989 placeCaption narrow viewports", () => {
  it("caps the width at the viewport minus 16 and keeps even a long caption inside", () => {
    const viewport = { width: 300, height: 500 };
    for (const point of [
      { x: 0, y: 0 },
      { x: 150, y: 250 },
      { x: 300, y: 500 },
    ]) {
      const result = placeCaption({ viewport, point, caption: { width: 600, height: 26 }, atRest: false });
      expect(result.maxWidth).toBe(284);
      expect(result.width).toBe(284);
      const box = boxOf(point, result);
      expect(box.left).toBeGreaterThanOrEqual(SPARE);
      expect(box.right).toBeLessThanOrEqual(300 - SPARE);
      expect(box.top).toBeGreaterThanOrEqual(SPARE);
      expect(box.bottom).toBeLessThanOrEqual(500 - SPARE);
    }
  });
});
