import type { CaptureFrame } from "../../chrome-adapters/capture.js";

/**
 * The pixels an agent's coordinates are in (012 change log 2026-10-17, R-280).
 *
 * An agent aims by reading a point off the latest whole-viewport picture of a tab. The page
 * resolves points in its own CSS pixels. Those two are the same only while the picture is at the
 * frame's own size, and a large viewport is handed back fitted under the size a model is shown
 * (`viewportPictureSize`), so the worker remembers, per tab, what the latest whole picture was a
 * picture of and how big it came out - and maps every point back through it, here and only here.
 *
 * No remembered picture is not a refusal: the point passes through unchanged, which is what every
 * point meant before this existed and is still right whenever the picture was not shrunk. A region
 * picture changes nothing: it is a close-up, not the picture the agent aims by.
 */

/** What the latest whole-viewport picture of a tab was of (`frame`, CSS) and its size (`image`). */
export type ScreenshotSpace = { frame: CaptureFrame; image: CaptureFrame };

export type ViewportPoint = { x: number; y: number };

/** The space a picture establishes, when both its size and its frame are known; otherwise none. */
export function spaceOfPicture(
  image: { width?: number | undefined; height?: number | undefined },
  frame: CaptureFrame | undefined,
): ScreenshotSpace | undefined {
  if (!frame || !(frame.width > 0) || !(frame.height > 0)) return undefined;
  if (typeof image.width !== "number" || typeof image.height !== "number") return undefined;
  if (!(image.width > 0) || !(image.height > 0)) return undefined;
  return { frame: { width: frame.width, height: frame.height }, image: { width: image.width, height: image.height } };
}

/** One point from the picture's pixels into the frame's, rounded per axis; none passes it through. */
export function toViewportPoint(point: ViewportPoint, space: ScreenshotSpace | undefined): ViewportPoint {
  if (!space) return { x: point.x, y: point.y };
  return {
    x: Math.round((point.x * space.frame.width) / space.image.width),
    y: Math.round((point.y * space.frame.height) / space.image.height),
  };
}

/**
 * A point the page reports (CSS) back into the picture's pixels: the inverse of `toViewportPoint`,
 * so an answer speaks the space the agent's own point was given in.
 */
export function toPicturePoint(point: ViewportPoint, space: ScreenshotSpace | undefined): ViewportPoint {
  if (!space) return { x: point.x, y: point.y };
  return {
    x: Math.round((point.x * space.image.width) / space.frame.width),
    y: Math.round((point.y * space.image.height) / space.frame.height),
  };
}

export type ViewportRegion = { x: number; y: number; width: number; height: number };

/**
 * A `screenshot` region read off the picture, in the frame's pixels (2026-10-17 follow-up, R-280).
 *
 * The far edge is mapped as a point and the size is what lies between, so a region that ends on the
 * picture's edge ends on the frame's - rounding each of x and width alone could step one pixel past
 * it and have the region refused as outside. Never under one pixel; no space leaves it as asked.
 */
export function toViewportRegion(region: ViewportRegion, space: ScreenshotSpace | undefined): ViewportRegion {
  if (!space) return { ...region };
  const start = toViewportPoint({ x: region.x, y: region.y }, space);
  const end = toViewportPoint({ x: region.x + region.width, y: region.y + region.height }, space);
  return {
    x: start.x,
    y: start.y,
    width: Math.max(end.x - start.x, 1),
    height: Math.max(end.y - start.y, 1),
  };
}

function isPoint(value: unknown): value is ViewportPoint {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.x === "number" && typeof candidate.y === "number" && !("ref" in candidate);
}

/** A target as the contracts spell it: a ref, a bare point, or `upload_image`'s `{ coordinate }`. */
function mapTarget(target: unknown, space: ScreenshotSpace | undefined): unknown {
  if (isPoint(target)) return { ...target, ...toViewportPoint(target, space) };
  if (typeof target === "object" && target !== null && isPoint((target as { coordinate?: unknown }).coordinate)) {
    const coordinate = (target as { coordinate: ViewportPoint }).coordinate;
    return { ...target, coordinate: { ...coordinate, ...toViewportPoint(coordinate, space) } };
  }
  return target;
}

/**
 * A call's arguments with every point the agent wrote mapped into the frame's pixels.
 *
 * The points are where the contracts put them: `computer`'s `x`/`y`, a `target` (the pointer tools,
 * `type`, `key`, `scroll`, `upload_image`'s `coordinate`), and `drag`'s `from`/`to`. A ref is left
 * alone - it names an element, not a place - and so is anything else.
 */
export function toViewportArgs(
  tool: string,
  args: Record<string, unknown>,
  space: ScreenshotSpace | undefined,
): Record<string, unknown> {
  if (!space) return args;
  const mapped: Record<string, unknown> = { ...args };
  if (tool === "computer" && typeof args.x === "number" && typeof args.y === "number") {
    Object.assign(mapped, toViewportPoint({ x: args.x, y: args.y }, space));
  }
  for (const key of ["target", "from", "to"] as const) {
    if (key in args) mapped[key] = mapTarget(args[key], space);
  }
  return mapped;
}

/**
 * Whether the call has a point in it to map: the same places `toViewportArgs` maps, so a call this
 * says nothing about is one whose meaning no stored space can change.
 */
export function carriesPoint(tool: string, args: Record<string, unknown>): boolean {
  if (tool === "computer" && typeof args.x === "number" && typeof args.y === "number") return true;
  return (["target", "from", "to"] as const).some((key) => {
    const value = args[key];
    return isPoint(value) || (typeof value === "object" && value !== null && isPoint((value as { coordinate?: unknown }).coordinate));
  });
}

/**
 * Why a point read off the latest picture may no longer be aimed with it, or nothing (012 change log
 * 2026-10-17, R-282).
 *
 * The owner can resize the window or zoom the page after the picture; the stored ratio would then
 * put the point somewhere the agent did not look. Only the width is compared - the debugging
 * infobar and bars like it change the height alone - and a pixel either way is rounding of the
 * frame's CSS width: it is the tab's DIP width divided by the zoom and rounded the same way every
 * time, so an unchanged tab reads the same width and is never refused. The tolerance is in CSS
 * pixels, not DIPs, so how much resize it admits follows the zoom: above 100 % one CSS pixel is more
 * than a DIP (1.25 at 125 %) and a one-DIP resize can pass - a shift smaller than a point can be
 * aimed; below 100 % one DIP is more than a CSS pixel (about 1.49 at 67 %), so a one-DIP resize moves
 * the rounded width by one or two and may be refused.
 * No picture, or a current width nobody could measure (a zoom nobody could read included), never
 * refuses: that is what every point meant before.
 */
export function viewportChangedReason(
  space: ScreenshotSpace | undefined,
  currentWidth: number | undefined,
): string | undefined {
  if (!space || currentWidth === undefined || Math.abs(currentWidth - space.frame.width) <= 1) return undefined;
  return (
    `viewport-changed (screenshot of a ${space.frame.width} px wide page, now ${currentWidth}); ` +
    "the window width or page zoom changed since the last screenshot - take a new screenshot first"
  );
}

/** The part of the per-tab store a runner needs: read the space, and set or clear it. */
export type ScreenshotSpaces = {
  get(tabId: number): Promise<ScreenshotSpace | undefined>;
  /** `undefined` forgets: a whole picture whose frame was unknown leaves nothing to map through. */
  remember(tabId: number, space: ScreenshotSpace | undefined): Promise<void>;
};
