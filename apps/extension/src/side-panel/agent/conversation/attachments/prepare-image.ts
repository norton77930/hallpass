import { CONVERSATION_IMAGE_MAX_CHARS, CONVERSATION_THUMBNAIL_MAX_CHARS } from "@hallpass/contracts";
import { blobToBase64 } from "./bytes.js";

/**
 * 022 R-341, FR-327: a picture made ready for one message to the helper, with the browser's own
 * decoder and canvas (no dependency, D-022-9).
 *
 * The long edge is brought to at most 2000 px (never enlarged). A PNG stays PNG when its encoding
 * fits the image bound (700 000 base64 characters); anything else - and a PNG that does not fit -
 * becomes JPEG at quality 0.85, stepping down by 0.1 to 0.35, then at half the size, and so on. A
 * GIF or WebP is decoded once, which is its first frame, and goes as JPEG. A file the browser cannot
 * decode is refused as "not an image". The thumbnail for the owner's bubble is a 160 px JPEG within
 * 12 000 characters, or none.
 *
 * The decoder and the canvas are injected (`ImageApis`) so the ladder is tested without a browser.
 */

export type BitmapLike = { width: number; height: number; close?: () => void };
type ContextLike = {
  fillStyle: unknown;
  fillRect: (x: number, y: number, width: number, height: number) => void;
  drawImage: (image: never, x: number, y: number, width: number, height: number) => void;
};
export type CanvasLike = {
  getContext: (kind: "2d") => unknown;
  convertToBlob: (options: { type: string; quality?: number }) => Promise<Blob>;
};
export type ImageApis = {
  createImageBitmap: (blob: Blob) => Promise<BitmapLike>;
  createCanvas: (width: number, height: number) => CanvasLike;
};

export type PreparedImage = {
  mimeType: "image/png" | "image/jpeg";
  /** Standard base64 of the encoded picture, within `CONVERSATION_IMAGE_MAX_CHARS`. */
  data: string;
  /** Encoded size in bytes. */
  size: number;
  width: number;
  height: number;
  thumbnail?: string;
};
export type PrepareOutcome = { ok: true; image: PreparedImage } | { ok: false; reason: "not-image" | "too-large" };

/** The picture types the panel takes as images (D-022-1); any other file is a file attachment. */
export const IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const isImageType = (type: string): boolean => IMAGE_TYPES.includes(type.toLowerCase());

/** The long edge a picture is brought to (R-341). */
export const LONG_EDGE = 2000;
const THUMB_EDGE = 160;
const JPEG_START = 0.85;
const JPEG_FLOOR = 0.35;
const JPEG_STEP = 0.1;
const THUMB_QUALITIES = [0.7, 0.5];

/** The browser's decoder and canvas, when the page has them (a side panel does). */
export function browserImageApis(): ImageApis | undefined {
  const scope = globalThis as {
    createImageBitmap?: (blob: Blob) => Promise<BitmapLike>;
    OffscreenCanvas?: new (width: number, height: number) => CanvasLike;
  };
  const decode = scope.createImageBitmap;
  const Canvas = scope.OffscreenCanvas;
  if (typeof decode !== "function" || typeof Canvas !== "function") return undefined;
  return {
    createImageBitmap: (blob) => decode.call(globalThis, blob),
    createCanvas: (width, height) => new Canvas(width, height),
  };
}

const fit = (width: number, height: number, edge: number): [number, number] => {
  const scale = Math.min(1, edge / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
};

async function encode(
  apis: ImageApis,
  bitmap: BitmapLike,
  width: number,
  height: number,
  type: "image/png" | "image/jpeg",
  quality?: number,
): Promise<Blob> {
  const canvas = apis.createCanvas(width, height);
  const context = canvas.getContext("2d") as ContextLike | null;
  if (context === null) throw new Error("no 2d context");
  if (type === "image/jpeg") {
    // JPEG has no transparency: a transparent picture is put on white, not on black.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(bitmap as never, 0, 0, width, height);
  return canvas.convertToBlob(quality === undefined ? { type } : { type, quality });
}

async function thumbnailOf(apis: ImageApis, bitmap: BitmapLike): Promise<string | undefined> {
  const [width, height] = fit(bitmap.width, bitmap.height, THUMB_EDGE);
  for (const quality of THUMB_QUALITIES) {
    const data = await blobToBase64(await encode(apis, bitmap, width, height, "image/jpeg", quality));
    if (data.length <= CONVERSATION_THUMBNAIL_MAX_CHARS) return data;
  }
  return undefined;
}

/**
 * T633: only the bubble's thumbnail, for a picture that is already within the bounds (a worker
 * screenshot) and goes as it is. None when the picture cannot be decoded here.
 */
export async function thumbnailFor(source: Blob, apis: ImageApis | undefined = browserImageApis()): Promise<string | undefined> {
  if (apis === undefined) return undefined;
  let bitmap: BitmapLike;
  try {
    bitmap = await apis.createImageBitmap(source);
  } catch {
    return undefined;
  }
  try {
    return bitmap.width > 0 && bitmap.height > 0 ? await thumbnailOf(apis, bitmap) : undefined;
  } catch {
    return undefined;
  } finally {
    bitmap.close?.();
  }
}

export async function prepareImage(source: Blob, apis: ImageApis | undefined = browserImageApis()): Promise<PrepareOutcome> {
  if (apis === undefined) return { ok: false, reason: "not-image" };
  let bitmap: BitmapLike;
  try {
    bitmap = await apis.createImageBitmap(source);
  } catch {
    return { ok: false, reason: "not-image" };
  }
  try {
    if (!(bitmap.width > 0 && bitmap.height > 0)) return { ok: false, reason: "not-image" };
    let [width, height] = fit(bitmap.width, bitmap.height, LONG_EDGE);
    let chosen: { blob: Blob; data: string; type: "image/png" | "image/jpeg" } | undefined;
    if (source.type.toLowerCase() === "image/png") {
      const blob = await encode(apis, bitmap, width, height, "image/png");
      const data = await blobToBase64(blob);
      if (data.length <= CONVERSATION_IMAGE_MAX_CHARS) chosen = { blob, data, type: "image/png" };
    }
    while (chosen === undefined) {
      for (let step = 0; JPEG_START - step * JPEG_STEP >= JPEG_FLOOR - 1e-9; step += 1) {
        const quality = Math.round((JPEG_START - step * JPEG_STEP) * 100) / 100;
        const blob = await encode(apis, bitmap, width, height, "image/jpeg", quality);
        const data = await blobToBase64(blob);
        if (data.length <= CONVERSATION_IMAGE_MAX_CHARS) {
          chosen = { blob, data, type: "image/jpeg" };
          break;
        }
      }
      if (chosen !== undefined) break;
      if (width <= 1 && height <= 1) return { ok: false, reason: "too-large" };
      width = Math.max(1, Math.round(width / 2));
      height = Math.max(1, Math.round(height / 2));
    }
    const thumbnail = await thumbnailOf(apis, bitmap);
    return {
      ok: true,
      image: {
        mimeType: chosen.type,
        data: chosen.data,
        size: chosen.blob.size,
        width,
        height,
        ...(thumbnail === undefined ? {} : { thumbnail }),
      },
    };
  } catch {
    return { ok: false, reason: "not-image" };
  } finally {
    bitmap.close?.();
  }
}
