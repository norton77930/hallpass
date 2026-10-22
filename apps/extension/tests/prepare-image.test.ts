import { describe, expect, it } from "vitest";
import { CONVERSATION_IMAGE_MAX_CHARS, CONVERSATION_THUMBNAIL_MAX_CHARS } from "@hallpass/contracts";
import {
  prepareImage,
  type ImageApis,
} from "../src/side-panel/agent/conversation/attachments/prepare-image.js";

/**
 * 022 T622, R-341, FR-327: the panel's own image preparation, with the browser's decoder and canvas
 * replaced by fakes. The fake canvas "encodes" to a blob whose byte count a test chooses from the
 * size, type and quality asked for, so each step of the ladder (PNG kept, JPEG 0.85 down to 0.35,
 * then half the size) can be forced.
 */

type Encoded = { width: number; height: number; type: string; quality: number | undefined };

/** Bytes that become exactly `chars` base64 characters (a multiple of 4). */
const bytesFor = (chars: number): number => (chars / 4) * 3;

function fakeApis(options: {
  width: number;
  height: number;
  /** How many bytes an encoding of this size, type and quality takes. */
  bytes: (encoded: Encoded) => number;
  undecodable?: boolean;
}): ImageApis & { encoded: Encoded[]; drawn: Array<[number, number]>; decoded: number } {
  const record = {
    encoded: [] as Encoded[],
    drawn: [] as Array<[number, number]>,
    decoded: 0,
  };
  return Object.assign(record, {
    createImageBitmap: async () => {
      record.decoded += 1;
      if (options.undecodable === true) throw new DOMException("The source image could not be decoded.", "InvalidStateError");
      return { width: options.width, height: options.height, close: () => undefined };
    },
    createCanvas: (width: number, height: number) => ({
      getContext: () => ({
        fillStyle: "",
        fillRect: () => undefined,
        drawImage: (_image: unknown, _x: number, _y: number, w: number, h: number) => {
          record.drawn.push([w, h]);
        },
      }),
      convertToBlob: async (target: { type?: string; quality?: number }) => {
        const encoded = { width, height, type: target.type ?? "image/png", quality: target.quality };
        record.encoded.push(encoded);
        return new Blob([new Uint8Array(options.bytes(encoded))], { type: encoded.type });
      },
    }),
  });
}

const png = (bytes = 10) => new Blob([new Uint8Array(bytes)], { type: "image/png" });

describe("022 R-341 prepareImage", () => {
  it("scales a 6000 x 4000 photo to a long edge of 2000 and keeps PNG when it fits", async () => {
    const apis = fakeApis({ width: 6000, height: 4000, bytes: (e) => (e.width <= 160 ? 2000 : 300_000) });
    const outcome = await prepareImage(png(), apis);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.image.mimeType).toBe("image/png");
    expect([outcome.image.width, outcome.image.height]).toEqual([2000, 1333]);
    expect(outcome.image.data.length).toBeLessThanOrEqual(CONVERSATION_IMAGE_MAX_CHARS);
    expect(outcome.image.size).toBe(300_000);
  });

  it("does not enlarge a small picture", async () => {
    const apis = fakeApis({ width: 640, height: 480, bytes: () => 1000 });
    const outcome = await prepareImage(png(), apis);
    expect(outcome.ok && [outcome.image.width, outcome.image.height]).toEqual([640, 480]);
  });

  it("goes to JPEG at 0.85 when the PNG does not fit", async () => {
    const apis = fakeApis({
      width: 3000,
      height: 1000,
      bytes: (e) => (e.type === "image/png" ? bytesFor(CONVERSATION_IMAGE_MAX_CHARS) + 3 : 400_000),
    });
    const outcome = await prepareImage(png(), apis);
    expect(outcome.ok && outcome.image.mimeType).toBe("image/jpeg");
    const big = apis.encoded.filter((e) => e.width > 160);
    expect(big.map((e) => [e.type, e.quality])).toEqual([
      ["image/png", undefined],
      ["image/jpeg", 0.85],
    ]);
  });

  it("steps the JPEG quality down by 0.1 until it fits", async () => {
    const apis = fakeApis({
      width: 2000,
      height: 2000,
      bytes: (e) => (e.width <= 160 ? 1000 : e.type === "image/jpeg" && (e.quality ?? 1) < 0.6 ? 500_000 : 900_000),
    });
    const outcome = await prepareImage(new Blob([new Uint8Array(5)], { type: "image/jpeg" }), apis);
    expect(outcome.ok && outcome.image.mimeType).toBe("image/jpeg");
    const qualities = apis.encoded.filter((e) => e.width > 160).map((e) => e.quality);
    // A JPEG original never tries PNG; 0.85, 0.75, 0.65, 0.55.
    expect(qualities.map((q) => Math.round((q ?? 0) * 100))).toEqual([85, 75, 65, 55]);
  });

  it("halves the size once 0.35 still does not fit", async () => {
    const apis = fakeApis({
      width: 2000,
      height: 1000,
      bytes: (e) => (e.width <= 160 ? 1000 : e.width > 1000 ? 900_000 : 200_000),
    });
    const outcome = await prepareImage(new Blob([new Uint8Array(5)], { type: "image/jpeg" }), apis);
    expect(outcome.ok && [outcome.image.width, outcome.image.height]).toEqual([1000, 500]);
    const full = apis.encoded.filter((e) => e.width === 2000).map((e) => Math.round((e.quality ?? 0) * 100));
    expect(full).toEqual([85, 75, 65, 55, 45, 35]);
  });

  it.each(["image/gif", "image/webp"])("sends a %s as one frame, re-encoded", async (type) => {
    const apis = fakeApis({ width: 400, height: 300, bytes: () => 1000 });
    const outcome = await prepareImage(new Blob([new Uint8Array(5)], { type }), apis);
    expect(apis.decoded).toBe(1);
    expect(outcome.ok && outcome.image.mimeType).toBe("image/jpeg");
  });

  it("refuses a file that does not decode as a picture", async () => {
    const apis = fakeApis({ width: 1, height: 1, bytes: () => 1, undecodable: true });
    expect(await prepareImage(png(), apis)).toEqual({ ok: false, reason: "not-image" });
  });

  it("makes a 160 px JPEG thumbnail within the thumbnail bound", async () => {
    const apis = fakeApis({ width: 1600, height: 800, bytes: (e) => (e.width <= 160 ? 4000 : 1000) });
    const outcome = await prepareImage(png(), apis);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const thumb = apis.encoded.find((e) => e.width <= 160);
    expect(thumb).toMatchObject({ width: 160, height: 80, type: "image/jpeg" });
    expect(outcome.image.thumbnail?.length).toBeLessThanOrEqual(CONVERSATION_THUMBNAIL_MAX_CHARS);
  });

  it("leaves the thumbnail out rather than send one over the bound", async () => {
    const apis = fakeApis({ width: 1600, height: 800, bytes: (e) => (e.width <= 160 ? 50_000 : 1000) });
    const outcome = await prepareImage(png(), apis);
    expect(outcome.ok && outcome.image.thumbnail).toBeUndefined();
  });

  it("returns the encoded bytes as standard base64", async () => {
    const apis = fakeApis({ width: 10, height: 10, bytes: () => 4 });
    const outcome = await prepareImage(png(), apis);
    // Four zero bytes.
    expect(outcome.ok && outcome.image.data).toBe("AAAAAA==");
  });

  it("refuses when the browser offers no decoder (none in this node environment)", async () => {
    expect(await prepareImage(png())).toEqual({ ok: false, reason: "not-image" });
  });
});
