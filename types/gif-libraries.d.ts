/**
 * Types for the two GIF libraries 008 brought in (R-135), neither of which ships declarations.
 *
 * One file, referenced by `/// <reference path>` from the two sources that import them
 * (`apps/extension/src/offscreen/encode.ts`, `packages/test-kit/src/gif-decode.ts`), rather than one
 * declaration per package: `tsc -p apps/extension` and `tsconfig.tests.json` both end up compiling
 * *both* of those sources, and two ambient declarations of the same module name in one program is an
 * error. A reference from the importer is also what keeps the declarations reachable at all - an
 * ambient `.d.ts` only enters a program through an `include` glob or a reference, never through the
 * import graph.
 *
 * Every signature below was read from the installed packages on 2026-09-19:
 * `node_modules/gifenc/src/index.js` and `README.md`, `node_modules/omggif/omggif.js`. The two units
 * that are easy to get wrong are written down where they are declared: gifenc takes a delay in
 * **milliseconds** (it divides by 10 itself), omggif reports one in **hundredths of a second**.
 */

declare module "gifenc" {
  /** RGB (or RGBA, with an alpha format) colour table, at most `maxColors` entries. */
  export type GifPalette = number[][];

  export type GifPixelFormat = "rgb565" | "rgb444" | "rgba4444";

  export type GifFrameOptions = {
    /** Required on the first frame (global colour table); a local table on any later frame. */
    palette?: GifPalette;
    /** Only consulted when the encoder was created with `{ auto: false }`. */
    first?: boolean;
    transparent?: boolean;
    transparentIndex?: number;
    /** Milliseconds. gifenc rounds `delay / 10` into the GIF's hundredths-of-a-second field. */
    delay?: number;
    /** Written once, with the first frame: -1 once, 0 forever, n repeats. */
    repeat?: number;
    colorDepth?: number;
    dispose?: number;
  };

  export type GifEncoderStream = {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: GifFrameOptions,
    ): void;
    writeHeader(): void;
    finish(): void;
    reset(): void;
    /** A copy of the stream, over a buffer gifenc allocated and nobody else holds. */
    bytes(): Uint8Array<ArrayBuffer>;
    bytesView(): Uint8Array<ArrayBuffer>;
  };

  export function GIFEncoder(options?: {
    auto?: boolean;
    initialCapacity?: number;
  }): GifEncoderStream;

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: {
      format?: GifPixelFormat;
      oneBitAlpha?: boolean | number;
      clearAlpha?: boolean;
      clearAlphaThreshold?: number;
      clearAlphaColor?: number;
    },
  ): GifPalette;

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: GifPalette,
    format?: GifPixelFormat,
  ): Uint8Array;
}

declare module "omggif" {
  export type GifFrameInfo = {
    x: number;
    y: number;
    width: number;
    height: number;
    has_local_palette: boolean;
    palette_offset: number | null;
    palette_size: number;
    data_offset: number;
    data_length: number;
    transparent_index: number | null;
    interlaced: boolean;
    /** Hundredths of a second, straight out of the graphic control extension. */
    delay: number;
    disposal: number;
  };

  export class GifReader {
    constructor(buffer: Uint8Array);
    readonly width: number;
    readonly height: number;
    numFrames(): number;
    /** The Netscape loop count: 0 means forever, `null` when the block is absent. */
    loopCount(): number | null;
    frameInfo(index: number): GifFrameInfo;
    /** Blits one frame into a full-canvas RGBA buffer, at that frame's own x/y. */
    decodeAndBlitFrameRGBA(index: number, pixels: Uint8ClampedArray | Uint8Array): void;
    decodeAndBlitFrameBGRA(index: number, pixels: Uint8ClampedArray | Uint8Array): void;
  }
}
