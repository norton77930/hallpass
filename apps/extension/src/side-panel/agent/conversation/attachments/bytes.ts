/**
 * 022 R-337, R-341: bytes and base64 in the panel - a Blob's bytes (with a FileReader fallback for
 * engines whose Blob has no `arrayBuffer`), standard base64 in both directions, and the 512 KiB
 * pieces an attachment travels in.
 */

/** R-337: one piece is at most 512 KiB of raw bytes (699 052 base64 characters). */
export const PIECE_MAX_BYTES = 512 * 1024;

export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsArrayBuffer(blob);
  });
}

/** Standard base64 with padding; built in slices so a large buffer never overflows the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let at = 0; at < bytes.length; at += step) {
    binary += String.fromCharCode(...bytes.subarray(at, at + step));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(await blobBytes(blob));
}

/** The text's UTF-8 bytes (a tab's visible text travels as bytes, its size counted in bytes). */
export const utf8Bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
