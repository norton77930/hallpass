import { describe, expect, it } from "vitest";
import {
  decodeGif,
  sampleColorAt,
  type DecodedFrame,
} from "../../../packages/test-kit/src/gif-decode.js";
import { composeGif, type ComposableFrame } from "../src/offscreen/encode.js";

/**
 * 008/T213 — the encoding arithmetic, decoded back rather than eyeballed.
 *
 * `composeGif` is split out from the rasterising half of the export precisely so it can be run here:
 * it takes pixels and answers bytes, with no canvas anywhere in it. What it has to get right is
 * FR-104 — one canvas at the largest frame's size, the smaller frames padded right and bottom with
 * white, 800 ms a frame and 2000 ms more on the last one, looping forever — and every one of those
 * is a number this file reads back out of the file it wrote.
 *
 * It also has to get right *when* it holds a frame (S2 review): the frames arrive one at a time and
 * the encoder may not keep them, which the last test here pins with a source that counts how many
 * frames are alive at once.
 */

const BIG = { width: 20, height: 16 };
const SMALL = { width: 12, height: 10 };
const TEAL: [number, number, number] = [31, 111, 120];
const RUST: [number, number, number] = [179, 38, 30];
const INK: [number, number, number] = [27, 36, 48];
const WHITE: [number, number, number] = [255, 255, 255];

function solid(
  size: { width: number; height: number },
  color: [number, number, number],
  corner: [number, number, number],
): ComposableFrame {
  const rgba = new Uint8ClampedArray(size.width * size.height * 4);
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      // A second colour in one corner: a frame of a single flat colour is not what a screenshot
      // looks like, and quantizing one is not the case worth pinning.
      const [r, g, b] = x < 3 && y < 3 ? corner : color;
      const at = (y * size.width + x) * 4;
      rgba[at] = r;
      rgba[at + 1] = g;
      rgba[at + 2] = b;
      rgba[at + 3] = 255;
    }
  }
  return { rgba, width: size.width, height: size.height };
}

function near(
  frame: DecodedFrame,
  width: number,
  x: number,
  y: number,
  expected: [number, number, number],
  tolerance = 12,
): void {
  const [red, green, blue] = sampleColorAt(frame, width, x, y);
  expect(Math.abs(red - expected[0]), `red at ${x},${y}`).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(green - expected[1]), `green at ${x},${y}`).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(blue - expected[2]), `blue at ${x},${y}`).toBeLessThanOrEqual(tolerance);
}

/** The canvas the worker's first pass would have measured: the largest frame in the run. */
function gifOf(
  frames: readonly ComposableFrame[],
  options?: Parameters<typeof composeGif>[2],
): Promise<Uint8Array> {
  return composeGif(
    { width: BIG.width, height: BIG.height, frameCount: frames.length },
    frames,
    options,
  );
}

const frames = [solid(BIG, TEAL, INK), solid(SMALL, RUST, INK), solid(BIG, INK, TEAL)];
const decoded = decodeGif(await gifOf(frames));

describe("composing the recorded frames into one GIF (008/T213)", () => {

  it("holds every frame at the largest one's size", () => {
    expect(decoded.width).toBe(BIG.width);
    expect(decoded.height).toBe(BIG.height);
    expect(decoded.frames).toHaveLength(3);
  });

  it("holds each frame for 800 ms and the last one for 2000 ms longer", () => {
    expect(decoded.frames.map((frame) => frame.delayMs)).toEqual([800, 800, 2_800]);
  });

  it("loops forever", () => {
    expect(decoded.loopCount).toBe(0);
  });

  it("pads a smaller frame right and bottom with white rather than with the frame before it", () => {
    const [, second] = decoded.frames;
    expect(second).toBeDefined();
    near(second!, BIG.width, 5, 5, RUST);
    // Outside the small frame, on both axes and in the corner the two overlap.
    near(second!, BIG.width, 15, 5, WHITE);
    near(second!, BIG.width, 5, 12, WHITE);
    near(second!, BIG.width, 18, 14, WHITE);
  });

  it("keeps the colours it was given, within what 256 of them can hold", () => {
    const [first] = decoded.frames;
    expect(first).toBeDefined();
    near(first!, BIG.width, 10, 8, TEAL);
    near(first!, BIG.width, 1, 1, INK);
  });

  it("takes the delays it is told to take", async () => {
    const slow = decodeGif(await gifOf(frames, { delayMs: 500, lastExtraMs: 0 }));
    expect(slow.frames.map((frame) => frame.delayMs)).toEqual([500, 500, 500]);
  });

  it("refuses to write a GIF with no frames in it", async () => {
    await expect(gifOf([])).rejects.toThrow(/no frames/i);
  });

  it("holds one frame at a time and lets it go before pulling the next", async () => {
    let live = 0;
    let peak = 0;
    // A source that makes each frame only when it is asked for, and says so.
    async function* oneAtATime(): AsyncGenerator<ComposableFrame> {
      for (let index = 0; index < 4; index += 1) {
        live += 1;
        peak = Math.max(peak, live);
        yield {
          ...solid(BIG, index % 2 === 0 ? TEAL : RUST, INK),
          release: () => {
            live -= 1;
          },
        };
      }
    }

    const bytes = await composeGif(
      { width: BIG.width, height: BIG.height, frameCount: 4 },
      oneAtATime(),
    );

    expect(decodeGif(bytes).frames).toHaveLength(4);
    expect(peak, "the encoder held more than one frame's pixels at once").toBe(1);
    expect(live, "the last frame was never released").toBe(0);
  });
});
