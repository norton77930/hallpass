export function opaqueId(prefix: string): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
