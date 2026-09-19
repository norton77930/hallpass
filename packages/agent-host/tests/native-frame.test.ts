import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, NATIVE_FRAME_MAX_BYTES } from "../src/native-frame.js";

/**
 * 003/T007 — Chrome's native-messaging wire format: a 4-byte little-endian unsigned length followed
 * by that many bytes of UTF-8 JSON, with 1 MiB the most a host may send Chrome.
 *
 * The decoder is a stream reader, not a message parser: Chrome hands the host whatever bytes have
 * arrived, so one read can carry half a frame or three of them. Every case below is a shape a real
 * pipe produces, and getting any of them wrong desynchronises the channel permanently rather than
 * failing one call.
 */

function concat(...chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

describe("native messaging framing", () => {
  it("writes a 4-byte little-endian length and UTF-8 JSON, and reads it back", () => {
    const value = { callId: "call-1", tool: "tabs_context", args: {} };
    const frame = encodeFrame(value);
    const body = JSON.stringify(value);
    const bodyBytes = new TextEncoder().encode(body);

    expect(frame.length).toBe(4 + bodyBytes.length);
    const length = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, true);
    expect(length).toBe(bodyBytes.length);
    expect(new TextDecoder().decode(frame.subarray(4))).toBe(body);

    expect(new FrameDecoder().push(frame)).toEqual([value]);
  });

  it("measures the body in UTF-8 bytes, not in characters", () => {
    // A length in characters would under-count here and cut the next frame's prefix in half.
    const frame = encodeFrame({ text: "ünïcodé — 漢字" });
    const length = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, true);
    expect(length).toBeGreaterThan(JSON.stringify({ text: "ünïcodé — 漢字" }).length);
    expect(new FrameDecoder().push(frame)).toEqual([{ text: "ünïcodé — 漢字" }]);
  });

  it("yields nothing until a split frame is complete, including a split length prefix", () => {
    const frame = encodeFrame({ callId: "call-2", outcome: "ok" });
    const decoder = new FrameDecoder();
    // The prefix itself arrives in two reads.
    expect(decoder.push(frame.subarray(0, 2))).toEqual([]);
    expect(decoder.push(frame.subarray(2, 6))).toEqual([]);
    expect(decoder.push(frame.subarray(6, frame.length - 1))).toEqual([]);
    expect(decoder.push(frame.subarray(frame.length - 1))).toEqual([{ callId: "call-2", outcome: "ok" }]);
    // Nothing is replayed once it has been handed over.
    expect(decoder.push(new Uint8Array(0))).toEqual([]);
  });

  it("returns every complete frame in one read, in order, and keeps the remainder", () => {
    const first = encodeFrame({ n: 1 });
    const second = encodeFrame({ n: 2 });
    const third = encodeFrame({ n: 3 });
    const decoder = new FrameDecoder();

    expect(decoder.push(concat(first, second, third.subarray(0, 5)))).toEqual([{ n: 1 }, { n: 2 }]);
    expect(decoder.push(third.subarray(5))).toEqual([{ n: 3 }]);
  });

  it("refuses to encode a message above the 1 MiB Chrome accepts", () => {
    expect(NATIVE_FRAME_MAX_BYTES).toBe(1024 * 1024);
    const withinLimit = { text: "a".repeat(NATIVE_FRAME_MAX_BYTES - 100) };
    expect(encodeFrame(withinLimit).length).toBeLessThanOrEqual(4 + NATIVE_FRAME_MAX_BYTES);
    expect(() => encodeFrame({ text: "a".repeat(NATIVE_FRAME_MAX_BYTES) })).toThrow("frame-too-large");
  });

  it("refuses a declared length above the limit instead of buffering it", () => {
    // The prefix is the only thing read before the body is allocated, so an absurd length has to be
    // refused on sight; buffering towards it is how a peer makes the host hold memory it never uses.
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, NATIVE_FRAME_MAX_BYTES + 1, true);
    expect(() => new FrameDecoder().push(prefix)).toThrow("frame-invalid");
  });

  it("refuses a complete frame whose body is not JSON", () => {
    const body = new TextEncoder().encode("{not json");
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, body.length, true);
    expect(() => new FrameDecoder().push(concat(prefix, body))).toThrow("frame-invalid");
  });
});
