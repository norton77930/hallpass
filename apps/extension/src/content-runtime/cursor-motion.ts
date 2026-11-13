/**
 * The pointer's planned path (033/R-496, FR-506, FR-507).
 *
 * Pure arithmetic with no document in it: given where the pointer is and where it is going, how
 * long the move takes and where 12 sample frames lie. The page plays the plan with the Web
 * Animations API (`cursor.ts`), so there is no frame loop of ours and no clock in here. The
 * numbers are Hallpass's own and may be tuned at the owner's live look.
 *
 * Shape of a move, with `t` the share of the duration that has passed:
 *
 * - **Along the line**, an ease that starts and ends at rest: the first 75 % carries the pointer
 *   a little past the target, the last 25 % lets it settle back onto it. No bounce, one pass.
 * - **Sideways**, a sine profile `sin(pi * t)`: zero at both ends, widest in the middle. The side
 *   is the left-hand normal of the travel direction, so going there and coming back bows opposite
 *   ways instead of every move sagging the same way.
 * - **Tilt**, the arrow leans into the motion in proportion to its speed along the line, so it is
 *   upright when it starts and when it stops.
 */

export type TravelPoint = { x: number; y: number };

/** One sample: where the tip is, how far through the move, and how far the arrow is turned. */
export type TravelFrame = {
  /** 0..1 position of this sample in the animation. */
  offset: number;
  x: number;
  y: number;
  /** `translate3d(...)` for the pointer element; the same spelling `cursor.ts` writes at rest. */
  transform: string;
  /** Degrees, clockwise positive; the arrow's inner element plays this as `rotate()`. */
  tiltDeg: number;
};

/** `durationMs` is 0 when there is nothing to watch; `frames` is then the target alone. */
export type TravelPlan = { durationMs: number; frames: TravelFrame[] };

const FRAME_COUNT = 12;
const MIN_DISTANCE_PX = 1;
const MIN_DURATION_MS = 140;
const MAX_DURATION_MS = 380;
const MAX_BEND_PX = 24;
const BEND_SHARE = 0.1;
const MAX_OVERSHOOT_PX = 3;
const OVERSHOOT_SHARE = 0.025;
/** The pass over the target happens at the end of this share of the move; the rest is the settle. */
const PASS_AT = 0.75;
const MAX_TILT_DEG = 8;
/** Speed (px per ms) at which the lean reaches about three quarters of its maximum. */
const TILT_SPEED_SCALE = 1.5;

/** `translate3d(x, y, 0)` - the one spelling of a placement, used at rest and in the frames. */
export function placementTransform(x: number, y: number): string {
  return `translate3d(${x}px, ${y}px, 0)`;
}

/** Three decimals are far below a device pixel and keep the generated CSS free of `1e-15`. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000 + 0;
}

/** Ease with zero speed at both ends. */
function easeInOut(share: number): number {
  return (1 - Math.cos(Math.PI * share)) / 2;
}

/** Derivative of `easeInOut`. */
function easeInOutSlope(share: number): number {
  return (Math.PI / 2) * Math.sin(Math.PI * share);
}

function targetOnly(to: TravelPoint): TravelPlan {
  return {
    durationMs: 0,
    frames: [{ offset: 1, x: to.x, y: to.y, transform: placementTransform(to.x, to.y), tiltDeg: 0 }],
  };
}

export function planTravel(from: TravelPoint, to: TravelPoint, reducedMotion: boolean): TravelPlan {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (reducedMotion || !(distance >= MIN_DISTANCE_PX)) return targetOnly(to);

  const durationMs = Math.min(
    MAX_DURATION_MS,
    Math.max(MIN_DURATION_MS, 90 + 60 * Math.log2(1 + distance / 20)),
  );
  const ux = dx / distance;
  const uy = dy / distance;
  // The left-hand normal of the travel: it turns with the direction, so there and back bow apart.
  const nx = -uy;
  const ny = ux;
  const bend = Math.min(BEND_SHARE * distance, MAX_BEND_PX);
  const overshoot = Math.min(OVERSHOOT_SHARE * distance, MAX_OVERSHOOT_PX) / distance;
  const lean = Math.sign(dx);

  // Share of the line covered (1 = on the target) and its slope with respect to `t`.
  const progress = (t: number): number =>
    t <= PASS_AT
      ? (1 + overshoot) * easeInOut(t / PASS_AT)
      : 1 + overshoot - overshoot * easeInOut((t - PASS_AT) / (1 - PASS_AT));
  const slope = (t: number): number =>
    t <= PASS_AT
      ? ((1 + overshoot) * easeInOutSlope(t / PASS_AT)) / PASS_AT
      : (-overshoot * easeInOutSlope((t - PASS_AT) / (1 - PASS_AT))) / (1 - PASS_AT);

  const frames: TravelFrame[] = [];
  for (let index = 0; index < FRAME_COUNT; index += 1) {
    const offset = index / (FRAME_COUNT - 1);
    if (index === 0 || index === FRAME_COUNT - 1) {
      // Both ends are exact and upright, whatever the arithmetic would round to.
      const end = index === 0 ? from : to;
      frames.push({ offset, x: end.x, y: end.y, transform: placementTransform(end.x, end.y), tiltDeg: 0 });
      continue;
    }
    const along = progress(offset) * distance;
    const aside = bend * Math.sin(Math.PI * offset);
    const x = round(from.x + ux * along + nx * aside);
    const y = round(from.y + uy * along + ny * aside);
    // Speed along the line in px per ms; negative while it settles back.
    const speed = (slope(offset) * distance) / durationMs;
    const tiltDeg = round(lean * MAX_TILT_DEG * Math.tanh(speed / TILT_SPEED_SCALE));
    frames.push({ offset, x, y, transform: placementTransform(x, y), tiltDeg });
  }
  return { durationMs, frames };
}
