/// <reference path="../../../../types/gif-libraries.d.ts" />

/**
 * Turning the frames of one recording into GIF bytes (008/T213, FR-104, R-135, design-notes §2).
 *
 * This half of the export is pixels in, bytes out, and nothing else: no canvas, no `chrome.*`, no
 * `Blob`. That is what lets the arithmetic FR-104 actually specifies - one canvas at the largest
 * frame's size, white padding on the right and bottom of anything smaller, 800 ms a frame with
 * 2000 ms more on the last, looping - be decoded back and asserted in a node test. The half that
 * needs a browser lives next door in `rasterize.ts`, so importing this one never drags a canvas in.
 *
 * **Frames arrive one at a time** (S2 review). A recording is up to 200 frames and a frame is up to
 * 1568 px on its long side, so a list of decoded RGBA buffers is hundreds of megabytes the document
 * would hold all at once - FR-109 bounds what a recording costs in memory, not only on disk. The
 * caller therefore measures the canvas in a cheap first pass (decode, read the size, close) and
 * hands this function a source it pulls from: one frame is quantized, written and released before
 * the next is asked for. The canvas size and the number of frames are known up front for that
 * reason - the last frame's longer delay cannot be decided by looking ahead at a frame that has not
 * been made yet.
 *
 * Padding is white rather than transparent or black because a browser screenshot's own background is
 * white; a frame that is narrower than the rest then reads as a smaller window, not as a hole.
 *
 * Each frame gets its own 256-colour palette. A global palette would be smaller on disk, but the
 * overlays are drawn in one accent and the pages underneath are not, and a palette shared across a
 * whole run is where a screenshot starts to band.
 */

import { applyPalette, GIFEncoder, quantize } from "gifenc";

/** One frame's pixels, already rasterised and already drawn on. */
export type ComposableFrame = {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /**
   * Called once the frame is inside the stream and its pixels are no longer needed, so whoever made
   * it can drop the canvas behind it rather than wait for the whole export to finish.
   */
  release?: () => void;
};

/** The canvas every frame is written onto, measured by the caller's first pass. */
export type GifCanvas = {
  width: number;
  height: number;
  /** How many frames the source will yield; the last of them is the one with the longer delay. */
  frameCount: number;
};

/** Frames in order, made on demand: an array works, and so does an async generator. */
export type ComposableFrames = Iterable<ComposableFrame> | AsyncIterable<ComposableFrame>;

export type ComposeOptions = {
  /** How long each frame is held, in milliseconds. */
  delayMs?: number;
  /** Added to the last frame only, so a viewer can read the end before it loops. */
  lastExtraMs?: number;
};

export const DEFAULT_FRAME_DELAY_MS = 800;
export const DEFAULT_LAST_EXTRA_MS = 2_000;
/** The most a GIF colour table can hold. */
const MAX_COLORS = 256;

/** White, opaque: the background a padded frame sits on. */
const PAD = [255, 255, 255, 255] as const;

/**
 * Copies a frame into a canvas-sized RGBA buffer, leaving the rest white.
 *
 * The frame keeps the top-left corner, so a window that got narrower during the run does not appear
 * to drift across the picture.
 */
function padToCanvas(frame: ComposableFrame, width: number, height: number): Uint8ClampedArray {
  if (frame.width === width && frame.height === height) {
    return frame.rgba;
  }
  const padded = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < padded.length; index += 4) {
    padded[index] = PAD[0];
    padded[index + 1] = PAD[1];
    padded[index + 2] = PAD[2];
    padded[index + 3] = PAD[3];
  }
  const rows = Math.min(frame.height, height);
  const columns = Math.min(frame.width, width);
  for (let y = 0; y < rows; y += 1) {
    const from = y * frame.width * 4;
    const to = y * width * 4;
    padded.set(frame.rgba.subarray(from, from + columns * 4), to);
  }
  return padded;
}

/**
 * Encodes the frames of one recording, in order, holding one of them at a time.
 *
 * Throws on an empty recording rather than writing a zero-frame file: the worker answers
 * `empty-recording` before it ever gets here (FR-100), and a GIF with no frames would be a file the
 * tester cannot open and cannot explain. It throws again when the source runs out early, because a
 * short source means the frame that was promised the closing delay never arrived - a silently
 * truncated recording is the one failure a tester would read as a successful export.
 */
export async function composeGif(
  canvas: GifCanvas,
  frames: ComposableFrames,
  options: ComposeOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  if (canvas.frameCount <= 0) {
    throw new Error("cannot encode a recording with no frames");
  }
  const delayMs = options.delayMs ?? DEFAULT_FRAME_DELAY_MS;
  const lastExtraMs = options.lastExtraMs ?? DEFAULT_LAST_EXTRA_MS;

  const gif = GIFEncoder();
  let written = 0;
  for await (const frame of frames) {
    const rgba = padToCanvas(frame, canvas.width, canvas.height);
    const palette = quantize(rgba, MAX_COLORS);
    const indexed = applyPalette(rgba, palette);
    gif.writeFrame(indexed, canvas.width, canvas.height, {
      palette,
      // gifenc takes milliseconds and writes hundredths of a second itself.
      delay: written === canvas.frameCount - 1 ? delayMs + lastExtraMs : delayMs,
      // Only read on the first frame, where it becomes the Netscape loop block. 0 is forever.
      repeat: 0,
    });
    written += 1;
    // The pixels are in the stream now: whoever made them may drop them before the next pull.
    frame.release?.();
  }
  if (written !== canvas.frameCount) {
    throw new Error(`the recording ended after ${written} of ${canvas.frameCount} frames`);
  }
  gif.finish();
  return gif.bytes();
}
