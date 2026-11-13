import { describe, expect, it } from "vitest";
import { planTravel, type TravelPoint } from "../src/content-runtime/cursor-motion.js";

/**
 * 033/T987 - the planned path of the pointer (R-496, FR-506, FR-507).
 *
 * Pure arithmetic: how long a move takes, where the 12 sample frames lie, how the arrow leans.
 * The page plays the plan with the Web Animations API; nothing here touches a document.
 */

const ORIGIN = { x: 0, y: 0 };

function at(distance: number): TravelPoint {
  return { x: distance, y: 0 };
}

function expectedDuration(distance: number): number {
  return Math.min(380, Math.max(140, 90 + 60 * Math.log2(1 + distance / 20)));
}

describe("033/T987 planTravel duration", () => {
  it("follows 90 + 60*log2(1 + d/20) between 140 and 380 ms", () => {
    for (const distance of [20, 40, 100, 300, 1000]) {
      expect(planTravel(ORIGIN, at(distance), false).durationMs, `d = ${distance}`).toBeCloseTo(
        expectedDuration(distance),
        2,
      );
    }
  });

  it("grows with the distance and stays inside its bounds", () => {
    const near = planTravel(ORIGIN, at(40), false).durationMs;
    const far = planTravel(ORIGIN, at(1000), false).durationMs;
    expect(far).toBeGreaterThan(near);
    for (const distance of [1, 2, 5, 40, 200, 1000, 100_000]) {
      const { durationMs } = planTravel(ORIGIN, at(distance), false);
      expect(durationMs).toBeGreaterThanOrEqual(140);
      expect(durationMs).toBeLessThanOrEqual(380);
    }
    expect(planTravel(ORIGIN, at(100_000), false).durationMs).toBe(380);
    expect(planTravel(ORIGIN, at(1), false).durationMs).toBe(140);
  });

  it("is 0 below one pixel and under reduced motion, and the plan is just the target", () => {
    for (const plan of [
      planTravel({ x: 5, y: 5 }, { x: 5.5, y: 5.5 }, false),
      planTravel({ x: 5, y: 5 }, { x: 5, y: 5 }, false),
      planTravel(ORIGIN, at(500), true),
    ]) {
      expect(plan.durationMs).toBe(0);
      expect(plan.frames).toHaveLength(1);
    }
    const jump = planTravel(ORIGIN, { x: 300, y: 200 }, true);
    expect(jump.frames[0]).toMatchObject({ x: 300, y: 200, tiltDeg: 0, transform: "translate3d(300px, 200px, 0)" });
  });
});

describe("033/T987 planTravel path", () => {
  const cases: Array<[string, TravelPoint, TravelPoint]> = [
    ["rightwards", { x: 100, y: 100 }, { x: 500, y: 100 }],
    ["leftwards", { x: 500, y: 100 }, { x: 100, y: 100 }],
    ["downwards", { x: 50, y: 50 }, { x: 50, y: 700 }],
    ["diagonal", { x: 20, y: 700 }, { x: 900, y: 40 }],
    ["short", { x: 10, y: 10 }, { x: 40, y: 30 }],
  ];

  it("has 12 frames, evenly spaced from offset 0 to 1, as translate3d", () => {
    const { frames } = planTravel({ x: 100, y: 100 }, { x: 500, y: 300 }, false);
    expect(frames).toHaveLength(12);
    expect(frames[0]?.offset).toBe(0);
    expect(frames[11]?.offset).toBe(1);
    frames.forEach((frame, index) => {
      expect(frame.offset).toBeCloseTo(index / 11, 6);
      expect(frame.transform).toBe(`translate3d(${frame.x}px, ${frame.y}px, 0)`);
    });
  });

  it("starts exactly at `from` and ends exactly on the target", () => {
    for (const [name, from, to] of cases) {
      const { frames } = planTravel(from, to, false);
      expect(frames[0], name).toMatchObject({ x: from.x, y: from.y, tiltDeg: 0 });
      expect(frames[11], name).toMatchObject({ x: to.x, y: to.y, tiltDeg: 0 });
      expect(frames[11]?.transform, name).toBe(`translate3d(${to.x}px, ${to.y}px, 0)`);
    }
  });

  it("bends sideways by at most min(10% of d, 24 px), and does bend", () => {
    for (const [name, from, to] of cases) {
      const d = Math.hypot(to.x - from.x, to.y - from.y);
      const ux = (to.x - from.x) / d;
      const uy = (to.y - from.y) / d;
      const { frames } = planTravel(from, to, false);
      const sideways = frames.map((frame) => Math.abs((frame.x - from.x) * -uy + (frame.y - from.y) * ux));
      const widest = Math.max(...sideways);
      expect(widest, name).toBeLessThanOrEqual(Math.min(0.1 * d, 24) + 0.01);
      expect(widest, `${name} is not a straight line`).toBeGreaterThan(Math.min(0.1 * d, 24) * 0.5);
    }
  });

  it("bows opposite ways there and back, so successive moves do not all lean one way", () => {
    const there = planTravel({ x: 100, y: 100 }, { x: 500, y: 100 }, false).frames;
    const back = planTravel({ x: 500, y: 100 }, { x: 100, y: 100 }, false).frames;
    const sideThere = Math.sign((there[5]?.y ?? 100) - 100);
    const sideBack = Math.sign((back[5]?.y ?? 100) - 100);
    expect(sideThere).not.toBe(0);
    expect(sideBack).toBe(-sideThere);
  });

  it("passes the target by at most min(2.5% of d, 3 px) late in the move and settles onto it", () => {
    for (const [name, from, to] of cases) {
      const d = Math.hypot(to.x - from.x, to.y - from.y);
      const ux = (to.x - from.x) / d;
      const uy = (to.y - from.y) / d;
      const { frames } = planTravel(from, to, false);
      const along = frames.map((frame) => (frame.x - to.x) * ux + (frame.y - to.y) * uy);
      const overshoot = Math.max(...along);
      expect(overshoot, name).toBeLessThanOrEqual(Math.min(0.025 * d, 3) + 0.01);
      expect(overshoot, `${name} overshoots`).toBeGreaterThan(0);
      // The pass happens in the last quarter, not before.
      frames.forEach((frame, index) => {
        if (frame.offset < 0.7) expect(along[index], `${name} frame ${index}`).toBeLessThan(0);
      });
      expect(along[11], name).toBe(0);
    }
  });
});

describe("033/T987 planTravel tilt", () => {
  it("leans at most 8 degrees, upright at both ends, and does lean", () => {
    for (const [from, to] of [
      [{ x: 0, y: 0 }, { x: 900, y: 40 }],
      [{ x: 900, y: 40 }, { x: 0, y: 0 }],
      [{ x: 0, y: 0 }, { x: 60, y: 10 }],
    ] as const) {
      const { frames } = planTravel(from, to, false);
      expect(frames[0]?.tiltDeg).toBe(0);
      expect(frames[11]?.tiltDeg).toBe(0);
      for (const frame of frames) expect(Math.abs(frame.tiltDeg)).toBeLessThanOrEqual(8);
      expect(Math.max(...frames.map((frame) => Math.abs(frame.tiltDeg)))).toBeGreaterThan(0.5);
    }
  });

  it("leans the way it is going: clockwise for rightwards, anticlockwise for leftwards", () => {
    const right = planTravel({ x: 0, y: 0 }, { x: 800, y: 0 }, false).frames[4]?.tiltDeg ?? 0;
    const left = planTravel({ x: 800, y: 0 }, { x: 0, y: 0 }, false).frames[4]?.tiltDeg ?? 0;
    expect(right).toBeGreaterThan(0);
    expect(left).toBeLessThan(0);
  });
});
