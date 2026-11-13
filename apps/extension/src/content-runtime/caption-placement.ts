/**
 * Where the caption sits next to the pointer (033/R-495, FR-503).
 *
 * Pure arithmetic with no document in it. The page measures the caption once per change of words
 * (`offsetWidth`, `offsetHeight`) and asks here; the answer is an offset from the arrow's tip, which
 * is where the pointer element's own box begins, so the caption (a child of the pointer) is placed
 * with `left` and `top` set to the offset.
 *
 * Three sides, chosen by the room there is:
 *
 * - **below-right** by default, the caption's top-left corner pointed at the tip;
 * - **left** when the caption would pass the right edge, its top-right corner toward the tip;
 * - **above** when it would pass the bottom edge, its bottom-left corner toward the tip - or the
 *   bottom-right one when it would pass the right edge as well, so the corner near the tip is
 *   always the one the side promises.
 *
 * Whatever the side, the box is then pushed back to at least 8 px inside the viewport, and its
 * width is capped at the viewport's minus 16 px (the page cuts the text with an ellipsis there).
 * At the rest spot the pointer is already 16 px from the bottom, so the caption sits beside the
 * arrow instead of below it.
 */

export type CaptionSide = "below-right" | "left" | "above";

/** The caption's pointed (square) corner; the other three are rounded. */
export type CaptionCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type CaptionPlacement = {
  side: CaptionSide;
  corner: CaptionCorner;
  /** The caption's top-left corner, relative to the arrow's tip, in CSS pixels. */
  offset: { x: number; y: number };
  /** The width the caption will have: its measured width, cut to `maxWidth`. */
  width: number;
  /** `viewport.width - 16`; the page sets it as `max-width`. */
  maxWidth: number;
};

export type CaptionPlacementInput = {
  viewport: { width: number; height: number };
  /** The arrow's tip, in viewport coordinates. */
  point: { x: number; y: number };
  /** The caption as measured, before any cap. */
  caption: { width: number; height: number };
  /** The pointer is at the rest spot. */
  atRest: boolean;
};

/** Room the caption always keeps to the viewport's edge (FR-503). */
const SPARE_PX = 8;
/** Below-right: the caption's top-left corner, from the tip - clear of the arrow's body. */
const BELOW_RIGHT_X = 14;
const BELOW_RIGHT_Y = 22;
/** At rest: beside the arrow's right wing, centred on the arrow's height. */
const REST_X = 22;
const ARROW_HEIGHT = 24;
/** Left and above: the gap kept between the caption and the tip, and the drop of the left caption. */
const TIP_GAP_PX = 6;
const LEFT_DROP_Y = 4;

export function placeCaption(input: CaptionPlacementInput): CaptionPlacement {
  const { viewport, point, caption, atRest } = input;
  const maxWidth = Math.max(0, viewport.width - 2 * SPARE_PX);
  const width = Math.min(caption.width, maxWidth);
  const { height } = caption;

  const rightGap = atRest ? REST_X : BELOW_RIGHT_X;
  const passesRight = point.x + rightGap + width > viewport.width - SPARE_PX;
  const passesBottom = !atRest && point.y + BELOW_RIGHT_Y + height > viewport.height - SPARE_PX;

  let side: CaptionSide = "below-right";
  let corner: CaptionCorner = "top-left";
  let x = point.x + rightGap;
  let y = atRest ? point.y + (ARROW_HEIGHT - height) / 2 : point.y + BELOW_RIGHT_Y;
  if (passesBottom) {
    side = "above";
    y = point.y - TIP_GAP_PX - height;
    if (point.x + TIP_GAP_PX + width > viewport.width - SPARE_PX) {
      corner = "bottom-right";
      x = point.x - TIP_GAP_PX - width;
    } else {
      corner = "bottom-left";
      x = point.x + TIP_GAP_PX;
    }
  } else if (passesRight) {
    side = "left";
    corner = "top-right";
    x = point.x - TIP_GAP_PX - width;
    y = point.y + LEFT_DROP_Y;
  }

  // Push the box back inside; the later bound wins when the viewport is smaller than the caption.
  x = Math.max(SPARE_PX, Math.min(x, viewport.width - SPARE_PX - width));
  y = Math.max(SPARE_PX, Math.min(y, viewport.height - SPARE_PX - height));
  return { side, corner, offset: { x: x - point.x, y: y - point.y }, width, maxWidth };
}
