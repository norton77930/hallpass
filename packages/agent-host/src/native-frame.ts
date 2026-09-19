/**
 * Chrome's native-messaging wire format, both directions.
 *
 * One message is a 4-byte little-endian unsigned length followed by that many bytes of UTF-8 JSON.
 * Chrome accepts at most 1 MiB from a host, so a message above that is refused here rather than
 * written and rejected at the far end - a half-written frame would desynchronise the pipe for every
 * message after it, not just the one that was too big.
 *
 * Nothing in this file knows what a frame means. It is pure Node with no Chrome types, so the same
 * code is exercised by the host's own tests without a browser.
 */

/** The most Chrome accepts in one message from a host. */
export const NATIVE_FRAME_MAX_BYTES = 1024 * 1024;

/** The length prefix: 4 bytes, little-endian, unsigned. */
const PREFIX_BYTES = 4;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeFrame(value: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(value));
  if (body.length > NATIVE_FRAME_MAX_BYTES) {
    throw new Error("frame-too-large");
  }
  const frame = new Uint8Array(PREFIX_BYTES + body.length);
  new DataView(frame.buffer).setUint32(0, body.length, true);
  frame.set(body, PREFIX_BYTES);
  return frame;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

/**
 * Reads frames out of a byte stream.
 *
 * A read from the pipe is a number of bytes, not a number of messages: it can carry a fragment of a
 * length prefix, several whole frames, or a whole frame plus the start of the next. The decoder
 * therefore holds what it cannot yet interpret and hands back only the values it has read in full,
 * in arrival order. One instance belongs to one stream, because the leftover bytes are that
 * stream's position.
 */
export class FrameDecoder {
  /** Annotated, not inferred: a chunk read from a stream may be backed by any kind of buffer. */
  private buffer: Uint8Array = new Uint8Array(0);

  /** The complete values this chunk finished, oldest first; the remainder stays buffered. */
  push(chunk: Uint8Array): unknown[] {
    if (chunk.length > 0) {
      this.buffer = concat(this.buffer, chunk);
    }
    const values: unknown[] = [];
    for (;;) {
      if (this.buffer.length < PREFIX_BYTES) {
        break;
      }
      const length = new DataView(this.buffer.buffer, this.buffer.byteOffset, PREFIX_BYTES).getUint32(0, true);
      if (length > NATIVE_FRAME_MAX_BYTES) {
        // The prefix is read before any body is buffered, so a length no sender could legitimately
        // write is refused on sight rather than waited for - waiting is how a peer makes this
        // process hold memory for a message that never arrives.
        throw new Error("frame-invalid");
      }
      if (this.buffer.length < PREFIX_BYTES + length) {
        break;
      }
      const body = decoder.decode(this.buffer.subarray(PREFIX_BYTES, PREFIX_BYTES + length));
      // `slice` copies, so a small remainder does not keep a megabyte-sized backing buffer alive.
      this.buffer = this.buffer.slice(PREFIX_BYTES + length);
      try {
        values.push(JSON.parse(body) as unknown);
      } catch {
        // The frame was well formed and its content was not. Saying so here keeps a malformed body
        // from being handed on as a value the reader would have to guess about.
        throw new Error("frame-invalid");
      }
    }
    return values;
  }
}
