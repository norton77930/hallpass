/// <reference path="../../../types/gif-libraries.d.ts" />

/**
 * Reading an exported recording back (008/T211, R-135).
 *
 * The gate's claim about a GIF is not "a file was written" but "frame 5 shows a ring where the click
 * was, and it stayed on screen for 800 ms". That needs a decoder, and it belongs in the test kit
 * rather than in the extension: nothing the product ships reads a GIF.
 *
 * Two conversions happen here so no test has to remember them:
 *
 *  - **Delay.** A GIF stores it in hundredths of a second; the encoder is given milliseconds. This
 *    hands back milliseconds, so a test asserts the number the recorder asked for.
 *  - **Compositing.** A GIF frame is a rectangle placed on the canvas over whatever the previous
 *    frame left there, not a picture of its own. Each frame is blitted into one running buffer and
 *    copied out, so every frame here is the full canvas as a viewer would see it.
 *
 * `textVisible` is deliberately absent: reading text off a raster is OCR, and a test that needs one
 * is a test that will be flaky. `nonBackgroundPixelsIn` is the honest substitute - it answers "did
 * something get drawn in this rectangle", which is the question the overlay assertions actually ask.
 */

import { GifReader } from "omggif";

export type DecodedFrame = {
  /** Milliseconds, as the encoder was asked for. */
  delayMs: number;
  /** The whole canvas, RGBA, `width * height * 4` bytes. */
  rgba: Uint8ClampedArray;
};

export type DecodedGif = {
  width: number;
  height: number;
  /** 0 means forever; `null` when the file carries no Netscape looping block at all. */
  loopCount: number | null;
  frames: DecodedFrame[];
};

export type PixelRect = { x: number; y: number; width: number; height: number };

export type SampledColor = [red: number, green: number, blue: number, alpha: number];

/**
 * How far a channel may drift from the named background before a pixel counts as drawn on.
 *
 * Quantizing to 256 colours moves flat areas by a point or two, so an exact comparison would count
 * the background itself. Eight is wide enough to absorb that and far narrower than any colour the
 * overlays draw with.
 */
const CHANNEL_TOLERANCE = 8;

export function decodeGif(bytes: Uint8Array): DecodedGif {
  const reader = new GifReader(bytes);
  const { width, height } = reader;
  const canvas = new Uint8ClampedArray(width * height * 4);
  const frames: DecodedFrame[] = [];
  for (let index = 0; index < reader.numFrames(); index += 1) {
    // Blitted into the buffer the previous frame left behind: a partial frame only carries the part
    // that changed, and its own x/y is where omggif puts it.
    reader.decodeAndBlitFrameRGBA(index, canvas);
    frames.push({
      delayMs: reader.frameInfo(index).delay * 10,
      rgba: new Uint8ClampedArray(canvas),
    });
  }
  return { width, height, loopCount: reader.loopCount(), frames };
}

/** The RGBA of one pixel, or transparent black when the point is off the canvas. */
export function sampleColorAt(
  frame: DecodedFrame,
  width: number,
  x: number,
  y: number,
): SampledColor {
  const at = (y * width + x) * 4;
  if (x < 0 || y < 0 || x >= width || at < 0 || at + 3 >= frame.rgba.length) {
    return [0, 0, 0, 0];
  }
  return [frame.rgba[at] ?? 0, frame.rgba[at + 1] ?? 0, frame.rgba[at + 2] ?? 0, frame.rgba[at + 3] ?? 0];
}

/**
 * How many pixels inside `rect` differ from `background`.
 *
 * A rectangle that reaches past the canvas is clamped rather than refused: an overlay box near an
 * edge is exactly the case worth asserting, and the part of it that exists is the true answer.
 */
export function nonBackgroundPixelsIn(
  frame: DecodedFrame,
  width: number,
  rect: PixelRect,
  background: [number, number, number] = [255, 255, 255],
): number {
  const height = frame.rgba.length / 4 / width;
  const fromX = Math.max(0, Math.floor(rect.x));
  const fromY = Math.max(0, Math.floor(rect.y));
  const toX = Math.min(width, Math.floor(rect.x + rect.width));
  const toY = Math.min(height, Math.floor(rect.y + rect.height));
  let count = 0;
  for (let y = fromY; y < toY; y += 1) {
    for (let x = fromX; x < toX; x += 1) {
      const [red, green, blue] = sampleColorAt(frame, width, x, y);
      const drifted =
        Math.abs(red - background[0]) > CHANNEL_TOLERANCE ||
        Math.abs(green - background[1]) > CHANNEL_TOLERANCE ||
        Math.abs(blue - background[2]) > CHANNEL_TOLERANCE;
      if (drifted) {
        count += 1;
      }
    }
  }
  return count;
}
