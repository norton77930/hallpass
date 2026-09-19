/**
 * Turning one captured JPEG into pixels the overlays can be drawn on (008/T213, FR-104).
 *
 * The browser half of the export, kept in its own file so `encode.ts` stays importable where there
 * is no canvas - which is every vitest project this repo has. Nothing here is unit-tested for that
 * same reason; what it does is proved on the gate, by decoding the GIF it helped produce (T223).
 *
 * The long side is capped at 1568 px, the same bound a screenshot answer is held to in 005: a
 * recording is a picture of a run, not evidence for a lawsuit, and 200 frames at a retina viewport
 * would be a file nobody can open. A frame already inside the bound is left exactly as captured.
 */

/** The longest side any frame is allowed to keep. */
export const MAX_LONG_SIDE = 1_568;

export type FrameSize = { width: number; height: number };

export type RasterizedFrame = FrameSize & {
  /** Handed back so overlays can be drawn and the pixels read once, afterwards. */
  canvas: OffscreenCanvas;
  context: OffscreenCanvasRenderingContext2D;
};

/**
 * Decodes a base64 JPEG into a blob.
 *
 * `atob` rather than `fetch(dataUrl)`, for the reason `chrome-adapters/capture.ts` records: an
 * extension document's content security policy does not list `data:` in `connect-src`, so fetching
 * a capture's own data url fails silently. This document must not fetch anything at all (FR-121),
 * which makes the point moot and the rule easy to keep.
 */
export function jpegBlobFromBase64(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: "image/jpeg" });
}

/** The size a frame of this size will be kept at, once the cap is applied. */
export function scaledSize(
  width: number,
  height: number,
  maxLongSide: number = MAX_LONG_SIDE,
): FrameSize {
  const longSide = Math.max(width, height);
  const ratio = longSide > maxLongSide ? maxLongSide / longSide : 1;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/**
 * How big this frame will be, without keeping a pixel of it.
 *
 * The export's first pass (`router.ts`): the GIF canvas is the largest frame in the run, and asking
 * every frame for its size is the cheap way to learn that without decoding them all at once. The
 * bitmap is closed before this returns, so what the pass costs is one frame at a time.
 */
export async function measureFrame(
  jpeg: Blob | ArrayBuffer,
  maxLongSide: number = MAX_LONG_SIDE,
): Promise<FrameSize> {
  const bitmap = await createImageBitmap(asBlob(jpeg));
  try {
    return scaledSize(bitmap.width, bitmap.height, maxLongSide);
  } finally {
    bitmap.close();
  }
}

export async function rasterizeFrame(
  jpeg: Blob | ArrayBuffer,
  maxLongSide: number = MAX_LONG_SIDE,
): Promise<RasterizedFrame> {
  const bitmap = await createImageBitmap(asBlob(jpeg));
  try {
    const { width, height } = scaledSize(bitmap.width, bitmap.height, maxLongSide);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("the offscreen document has no 2d context");
    }
    context.drawImage(bitmap, 0, 0, width, height);
    // The pixels are deliberately not read here: the overlays go on next, and reading them twice
    // would double what the export costs for a picture nobody ever sees.
    return { width, height, canvas, context };
  } finally {
    bitmap.close();
  }
}

function asBlob(jpeg: Blob | ArrayBuffer): Blob {
  return jpeg instanceof Blob ? jpeg : new Blob([jpeg], { type: "image/jpeg" });
}

/** The canvas as it stands now - called once, after the overlays are drawn. */
export function readPixels(
  context: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
): Uint8ClampedArray {
  return context.getImageData(0, 0, width, height).data;
}
