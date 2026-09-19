import { applyPalette, GIFEncoder, quantize } from "gifenc";
import { describe, expect, it } from "vitest";
import { decodeGif, nonBackgroundPixelsIn, sampleColorAt } from "./gif-decode.js";

/**
 * 008/T211 — the decoder is proved against the encoder the product uses.
 *
 * A GIF written here by gifenc and read back by omggif closes the one question the gate later rests
 * on: that a frame count, a delay and a pixel colour survive the round trip and mean what the
 * assertion thinks they mean. The delay is the trap worth pinning - gifenc is given milliseconds
 * and the file stores hundredths of a second - so 800/2800 in must be 800/2800 out.
 */

const WIDTH = 10;
const HEIGHT = 8;
const RED: [number, number, number] = [220, 32, 32];
const BLUE: [number, number, number] = [32, 48, 220];
const WHITE: [number, number, number] = [255, 255, 255];

/** A solid canvas with one rectangle painted on it, so a frame has two colours to quantize. */
function paint(
  background: [number, number, number],
  block: { color: [number, number, number]; x: number; y: number; width: number; height: number },
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const inside =
        x >= block.x && x < block.x + block.width && y >= block.y && y < block.y + block.height;
      const [r, g, b] = inside ? block.color : background;
      const at = (y * WIDTH + x) * 4;
      rgba[at] = r;
      rgba[at + 1] = g;
      rgba[at + 2] = b;
      rgba[at + 3] = 255;
    }
  }
  return rgba;
}

function encode(frames: { rgba: Uint8ClampedArray; delayMs: number }[]): Uint8Array {
  const gif = GIFEncoder();
  for (const frame of frames) {
    const palette = quantize(frame.rgba, 256);
    const index = applyPalette(frame.rgba, palette);
    gif.writeFrame(index, WIDTH, HEIGHT, { palette, delay: frame.delayMs, repeat: 0 });
  }
  gif.finish();
  return gif.bytes();
}

describe("decoding a GIF back into frames (008/T211)", () => {
  const bytes = encode([
    { rgba: paint(RED, { color: WHITE, x: 0, y: 0, width: 2, height: 2 }), delayMs: 800 },
    { rgba: paint(WHITE, { color: BLUE, x: 3, y: 2, width: 4, height: 3 }), delayMs: 2_800 },
  ]);

  it("reads the canvas, the frame count and the loop count", () => {
    const decoded = decodeGif(bytes);
    expect(decoded.width).toBe(WIDTH);
    expect(decoded.height).toBe(HEIGHT);
    expect(decoded.frames).toHaveLength(2);
    // gifenc's `repeat: 0` is the Netscape "loop forever" count, and omggif hands back that same 0
    // rather than a sentinel. A GIF with no Netscape block at all reads back as `null`.
    expect(decoded.loopCount).toBe(0);
  });

  it("reports each frame's delay in milliseconds, not hundredths", () => {
    expect(decodeGif(bytes).frames.map((frame) => frame.delayMs)).toEqual([800, 2_800]);
  });

  it("hands back full-canvas pixels, each frame composited over the one before it", () => {
    const [first, second] = decodeGif(bytes).frames;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(sampleColorAt(first!, WIDTH, 5, 5).slice(0, 3)).toEqual(RED);
    expect(sampleColorAt(first!, WIDTH, 0, 0).slice(0, 3)).toEqual(WHITE);
    expect(sampleColorAt(first!, WIDTH, 0, 0)[3]).toBe(255);
    expect(sampleColorAt(second!, WIDTH, 4, 3).slice(0, 3)).toEqual(BLUE);
    expect(sampleColorAt(second!, WIDTH, 9, 7).slice(0, 3)).toEqual(WHITE);
    expect(second!.rgba).toHaveLength(WIDTH * HEIGHT * 4);
  });

  it("counts the pixels in a rectangle that are not the background", () => {
    const [, second] = decodeGif(bytes).frames;
    // This is how a test says "the label box was drawn here" without reading any text off it.
    expect(
      nonBackgroundPixelsIn(second!, WIDTH, { x: 3, y: 2, width: 4, height: 3 }),
    ).toBe(12);
    expect(nonBackgroundPixelsIn(second!, WIDTH, { x: 0, y: 0, width: 3, height: 8 })).toBe(0);
    // A rectangle reaching past the canvas counts the part of it that exists.
    expect(nonBackgroundPixelsIn(second!, WIDTH, { x: 8, y: 6, width: 40, height: 40 })).toBe(0);
    // The background is the caller's to name: against blue, everything else counts instead.
    expect(
      nonBackgroundPixelsIn(second!, WIDTH, { x: 3, y: 2, width: 4, height: 3 }, BLUE),
    ).toBe(0);
  });
});
