import type { TargetRegistry } from "./targets.js";

/**
 * Putting the owner's files on a file input (003/T061, US7, FR-051).
 *
 * What arrives here is bytes and a name. The path they came from was resolved, checked against the
 * roots the owner allowed, and read by the *host* - the owner's own process - so this side has no
 * idea a file system exists and no way to reach one. That is the whole point of the split: the page
 * gets a `File` built from bytes it was handed, never a reference to anything on the machine.
 *
 * The element is named the way every other target is, by a handle this document minted, and it must
 * still *be* a file input when the bytes arrive - re-read live, like every effect-time check in this
 * runtime, because the handle was minted at collection time and the page has had its say since.
 *
 * What goes back is what the input is holding afterwards, read from the element. Echoing the request
 * would report an upload for a page that rejected it, which is exactly the claim FR-040 forbids.
 */

export type ContentSetFilesReply =
  | { ok: true; files: Array<{ name: string; size: number }> }
  | {
      ok: false;
      reason: "stale-target" | "not-a-file-input" | "unsupported" | "too-many-files" | "accept-mismatch";
    };

type FileLike = { name?: unknown; size?: unknown };

type FileInputLike = {
  tagName?: string;
  type?: string;
  multiple?: boolean;
  accept?: string;
  files?: ArrayLike<FileLike> | null;
  dispatchEvent?: (event: object) => boolean;
  getAttribute?: (name: string) => string | null;
};

/**
 * Whether the input says it takes this file (003/C4).
 *
 * `accept` is the page's own statement about what it will do something with, in the three forms
 * HTML gives it: an extension, a mime type, and a type wildcard. An input with no `accept` takes
 * anything. Matching it here is not an extra policy - it is refusing to hand a form something it
 * has already said it would reject, which would otherwise be reported as a successful upload.
 */
function acceptsFile(accept: string, file: { name: string; type: string }): boolean {
  const tokens = accept
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return tokens.some((token) => {
    if (token.startsWith(".")) return name.endsWith(token);
    if (token.endsWith("/*")) return type.startsWith(token.slice(0, -1));
    return token === type;
  });
}

/** The base64 the frame carried, as the bytes a `File` is built from. */
function decode(bytesBase64: string): Uint8Array {
  const binary = (globalThis as { atob?: (value: string) => string }).atob?.(bytesBase64) ?? "";
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function setFilesOnTarget(
  registry: TargetRegistry,
  input: {
    documentEpoch: string;
    targetHandle: string;
    files: ReadonlyArray<{ name: string; type: string; bytesBase64: string }>;
  },
): ContentSetFilesReply {
  const record = registry.resolve(input.targetHandle, input.documentEpoch);
  if (!record) return { ok: false, reason: "stale-target" };
  const element = record.element as FileInputLike | undefined;
  const tagName = (element?.tagName ?? "").toUpperCase();
  const type = (element?.type ?? "").toLowerCase();
  if (tagName !== "INPUT" || type !== "file" || typeof element?.dispatchEvent !== "function") {
    // Not a refusal about policy: there is simply nowhere on this element for a file to go, and
    // pretending otherwise would answer `ok` for an upload that never happened.
    return { ok: false, reason: "not-a-file-input" };
  }
  // C4: what the input itself says it takes. Both checks come before anything is built, because
  // the alternative is setting files a form has already declared it will not accept and calling
  // that an upload.
  const multiple =
    element.multiple === true || (element.getAttribute?.("multiple") ?? null) !== null;
  if (input.files.length > 1 && !multiple) {
    return { ok: false, reason: "too-many-files" };
  }
  const accept = element.accept ?? element.getAttribute?.("accept") ?? "";
  if (accept.length > 0 && !input.files.every((file) => acceptsFile(accept, file))) {
    return { ok: false, reason: "accept-mismatch" };
  }
  const scope = globalThis as {
    DataTransfer?: new () => { items: { add(file: unknown): void }; files: unknown };
    File?: new (parts: unknown[], name: string, options?: { type?: string }) => unknown;
  };
  if (!scope.DataTransfer || !scope.File) {
    // A `FileList` cannot be constructed any other way, so an engine without these cannot do this
    // at all. Said out loud rather than answered as an empty success.
    return { ok: false, reason: "unsupported" };
  }
  const transfer = new scope.DataTransfer();
  for (const file of input.files) {
    transfer.items.add(new scope.File([decode(file.bytesBase64)], file.name, { type: file.type }));
  }
  (element as { files?: unknown }).files = transfer.files;
  const EventCtor = (globalThis as { Event?: new (type: string, init?: { bubbles?: boolean }) => object }).Event;
  if (EventCtor) {
    // Both, in the order a browser sends them, for the same reason `setValue` does: a page that
    // listens for one or the other has to learn about the file it is about to be asked to send.
    element.dispatchEvent(new EventCtor("input", { bubbles: true }));
    element.dispatchEvent(new EventCtor("change", { bubbles: true }));
  }
  const held = element.files;
  const files: Array<{ name: string; size: number }> = [];
  for (let index = 0; index < (held?.length ?? 0); index += 1) {
    const file = held?.[index];
    files.push({
      name: typeof file?.name === "string" ? file.name : "",
      size: typeof file?.size === "number" ? file.size : 0,
    });
  }
  return { ok: true, files };
}
