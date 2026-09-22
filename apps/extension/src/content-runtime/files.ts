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

/**
 * The constructors a delivery needs, and where they come from.
 *
 * `setFilesOnTarget` reads them from this runtime's own scope, which is where they have always come
 * from. `deliverImage` reads them from the *target document's* view instead, because it may be
 * delivering into a child frame: a `File` built by one document and dropped on another is a file
 * from a foreign realm, and a page's own handler is entitled to refuse it. Each is taken from this
 * scope when the view does not name it, so a view that exposes nothing behaves as it did before.
 */
type DeliveryRealm = {
  DataTransfer?: new () => { items: { add(file: unknown): void }; files: unknown };
  File?: new (parts: unknown[], name: string, options?: { type?: string }) => unknown;
  Event?: new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }) => object;
  DragEvent?: new (type: string, init?: Record<string, unknown>) => object;
  screenX?: number;
  screenY?: number;
};

function ownScope(): DeliveryRealm {
  return globalThis as unknown as DeliveryRealm;
}

function realmOf(element: unknown): DeliveryRealm {
  const view = (element as { ownerDocument?: { defaultView?: DeliveryRealm | null } } | null | undefined)
    ?.ownerDocument?.defaultView;
  const scope = ownScope();
  if (!view) return scope;
  const pick = <T,>(own: T | undefined, fallback: T | undefined): T | undefined => own ?? fallback;
  const DataTransferCtor = pick(view.DataTransfer, scope.DataTransfer);
  const FileCtor = pick(view.File, scope.File);
  const EventCtor = pick(view.Event, scope.Event);
  const DragEventCtor = pick(view.DragEvent, scope.DragEvent);
  return {
    ...(DataTransferCtor ? { DataTransfer: DataTransferCtor } : {}),
    ...(FileCtor ? { File: FileCtor } : {}),
    ...(EventCtor ? { Event: EventCtor } : {}),
    ...(DragEventCtor ? { DragEvent: DragEventCtor } : {}),
    ...(typeof view.screenX === "number" ? { screenX: view.screenX } : {}),
    ...(typeof view.screenY === "number" ? { screenY: view.screenY } : {}),
  };
}

/** Whether this element is a control a file can be placed on at all. */
function isFileInput(element: FileInputLike | undefined): boolean {
  const tagName = (element?.tagName ?? "").toUpperCase();
  const type = (element?.type ?? "").toLowerCase();
  return tagName === "INPUT" && type === "file" && typeof element?.dispatchEvent === "function";
}

type PlaceReply =
  | { ok: true; files: Array<{ name: string; size: number }> }
  | { ok: false; reason: "unsupported" | "too-many-files" | "accept-mismatch" };

/**
 * The files onto the input, the page told, and what it is holding read back (003/T061, 013/T333).
 *
 * Shared by the two callers that put a file on a control, and the `accept` check is the one thing
 * they disagree about. `file_upload` consults it: the agent named a file of the owner's and a form
 * that has said it will not take that kind would reject it the moment it looked, so setting it and
 * answering `ok` would report an upload the page disagrees with. `upload_image` does not: a
 * programmatic assignment is not filtered by `accept` in a browser either, the answer is read from
 * the input afterwards, and what the page then does with a picture is the page's own validation to
 * run (013/R-178).
 */
function placeIntoInput(
  element: FileInputLike,
  files: ReadonlyArray<{ name: string; type: string; bytesBase64: string }>,
  options: { checkAccept: boolean; realm: DeliveryRealm },
): PlaceReply {
  // C4: what the input itself says it takes. Both checks come before anything is built, because
  // the alternative is setting files a form has already declared it will not accept and calling
  // that an upload.
  const multiple =
    element.multiple === true || (element.getAttribute?.("multiple") ?? null) !== null;
  if (files.length > 1 && !multiple) {
    return { ok: false, reason: "too-many-files" };
  }
  if (options.checkAccept) {
    const accept = element.accept ?? element.getAttribute?.("accept") ?? "";
    if (accept.length > 0 && !files.every((file) => acceptsFile(accept, file))) {
      return { ok: false, reason: "accept-mismatch" };
    }
  }
  const scope = options.realm;
  if (!scope.DataTransfer || !scope.File) {
    // A `FileList` cannot be constructed any other way, so an engine without these cannot do this
    // at all. Said out loud rather than answered as an empty success.
    return { ok: false, reason: "unsupported" };
  }
  const transfer = new scope.DataTransfer();
  for (const file of files) {
    transfer.items.add(new scope.File([decode(file.bytesBase64)], file.name, { type: file.type }));
  }
  (element as { files?: unknown }).files = transfer.files;
  const EventCtor = scope.Event;
  const dispatch = element.dispatchEvent;
  if (EventCtor && typeof dispatch === "function") {
    // Both, in the order a browser sends them, for the same reason `setValue` does: a page that
    // listens for one or the other has to learn about the file it is about to be asked to send.
    dispatch.call(element, new EventCtor("input", { bubbles: true }));
    dispatch.call(element, new EventCtor("change", { bubbles: true }));
  }
  const held = element.files;
  const read: Array<{ name: string; size: number }> = [];
  for (let index = 0; index < (held?.length ?? 0); index += 1) {
    const file = held?.[index];
    read.push({
      name: typeof file?.name === "string" ? file.name : "",
      size: typeof file?.size === "number" ? file.size : 0,
    });
  }
  return { ok: true, files: read };
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
  if (!isFileInput(element) || !element) {
    // Not a refusal about policy: there is simply nowhere on this element for a file to go, and
    // pretending otherwise would answer `ok` for an upload that never happened.
    return { ok: false, reason: "not-a-file-input" };
  }
  return placeIntoInput(element, input.files, { checkAccept: true, realm: ownScope() });
}

/**
 * A picture this session took, delivered into the page (013/T333, US2, FR-170, FR-171).
 *
 * The bytes arrive the way `setFilesOnTarget`'s do - read by the host, which is the only end that
 * ever held the picture - and the id the agent quoted does not exist on this side at all. What is
 * new is *where* a file may go. A file input takes it the way an upload does; anything else is
 * dropped on, because that is the only way a page that accepts dragged files can be handed one.
 *
 * The answer says which of the two happened and what the page has, read from the input where there
 * is an input to read and echoed from the delivered file where there is not - a drop leaves nothing
 * to read back, and inventing a reading would be the claim FR-040 forbids.
 */
export type ContentDeliverImageReply =
  | {
      ok: true;
      delivery: "input" | "drop";
      file: { name: string; size: number };
      point?: { x: number; y: number };
    }
  | { ok: false; reason: "stale-target" | "not-a-drop-target" | "not-reachable" | "unsupported" }
  | { ok: false; reason: "point-outside-viewport"; frame: { width: number; height: number } };

type DocumentLike = { elementFromPoint?: (x: number, y: number) => unknown };

type FrameLike = {
  tagName?: string;
  contentDocument?: DocumentLike | null;
  clientLeft?: number;
  clientTop?: number;
  getBoundingClientRect?: () => { left: number; top: number; width: number; height: number };
};

function isFrameElement(element: unknown): boolean {
  const tagName = ((element as { tagName?: string } | null | undefined)?.tagName ?? "").toUpperCase();
  return tagName === "IFRAME" || tagName === "FRAME";
}

/** The frame's document when this document may read it, and nothing when it may not. */
function readableFrameDocument(frame: FrameLike): DocumentLike | undefined {
  try {
    // A cross-origin frame answers `null` here rather than throwing, but a browser is entitled to
    // do either, and a delivery is not the place to find out which.
    return frame.contentDocument ?? undefined;
  } catch {
    return undefined;
  }
}

function centreOf(element: unknown): { x: number; y: number } {
  const rect = (element as { getBoundingClientRect?: () => { left: number; top: number; width: number; height: number } })
    .getBoundingClientRect?.();
  if (!rect) return { x: 0, y: 0 };
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

type PointResolution =
  | { ok: true; element: unknown; localPoint: { x: number; y: number } }
  | Extract<ContentDeliverImageReply, { ok: false }>;

/**
 * What is at a point, and how far down this delivery is willing to look (013/R-178).
 *
 * The viewport bound comes first because a point outside it names no place on this page at all, and
 * the answer says how big the page's own frame is so the agent can pick one that does. Below the
 * top document exactly one frame is entered, and only one this document can read: a deeper frame is
 * a document this call did not name, and a foreign one is a document nothing here may touch. Both
 * are refused by name rather than delivered to whatever happened to be reachable.
 */
function resolveByPoint(point: { x: number; y: number }): PointResolution {
  const scope = globalThis as {
    innerWidth?: number;
    innerHeight?: number;
    document?: DocumentLike;
    getComputedStyle?: (element: unknown) => { paddingLeft?: string; paddingTop?: string };
  };
  const width = typeof scope.innerWidth === "number" ? scope.innerWidth : 0;
  const height = typeof scope.innerHeight === "number" ? scope.innerHeight : 0;
  if (point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) {
    return { ok: false, reason: "point-outside-viewport", frame: { width, height } };
  }
  const found = scope.document?.elementFromPoint?.(point.x, point.y) ?? undefined;
  if (found === undefined || found === null) return { ok: false, reason: "not-a-drop-target" };
  if (!isFrameElement(found)) return { ok: true, element: found, localPoint: point };
  const frame = found as FrameLike;
  const childDocument = readableFrameDocument(frame);
  if (!childDocument) return { ok: false, reason: "not-reachable" };
  const rect = frame.getBoundingClientRect?.();
  // The child document starts inside the frame's border *and* its padding (S2c review F2): a
  // translation that took only the rectangle and the border would land the agent's coordinate
  // `padding` pixels short inside the child, and arriving where it was aimed is the whole point of
  // the descent. A realm that names no `getComputedStyle`, or a style that resolves to no number,
  // contributes nothing rather than a `NaN` that would carry the point away entirely.
  const style = scope.getComputedStyle?.(frame);
  const padding = (value: string | undefined): number => {
    const parsed = Number.parseFloat(value ?? "");
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const local = {
    x: point.x - (rect?.left ?? 0) - (frame.clientLeft ?? 0) - padding(style?.paddingLeft),
    y: point.y - (rect?.top ?? 0) - (frame.clientTop ?? 0) - padding(style?.paddingTop),
  };
  const inner = childDocument.elementFromPoint?.(local.x, local.y) ?? undefined;
  if (inner === undefined || inner === null) return { ok: false, reason: "not-a-drop-target" };
  if (isFrameElement(inner)) return { ok: false, reason: "not-reachable" };
  return { ok: true, element: inner, localPoint: local };
}

/**
 * One event of the drop sequence, built where the element lives.
 *
 * `DragEvent` is what a browser sends and what a page's handler reads `dataTransfer` off, so it is
 * tried first. A realm that names no `DragEvent` - or cannot construct one - gets a plain event
 * carrying the same fields, for `dragLikeEvent`'s reason: a page listening for the sequence still
 * hears it, and a page reading the file still finds it.
 */
function dropEvent(
  realm: DeliveryRealm,
  type: string,
  dataTransfer: unknown,
  at: { x: number; y: number },
): object | undefined {
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: at.x,
    clientY: at.y,
    // What a real drop carries: the same place, in the screen's coordinates, where the window knows
    // where it is on the screen at all.
    screenX: at.x + (typeof realm.screenX === "number" ? realm.screenX : 0),
    screenY: at.y + (typeof realm.screenY === "number" ? realm.screenY : 0),
    dataTransfer,
  };
  if (realm.DragEvent) {
    try {
      return new realm.DragEvent(type, init);
    } catch {
      // An environment that names `DragEvent` but cannot construct it: fall through to a plain one.
    }
  }
  const Ctor = realm.Event;
  if (!Ctor) return undefined;
  const event = new Ctor(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(init)) {
    if (key === "bubbles" || key === "cancelable" || key === "composed") continue;
    Object.defineProperty(event, key, { value, configurable: true, enumerable: true });
  }
  return event;
}

export function deliverImage(
  registry: TargetRegistry,
  input: {
    documentEpoch: string;
    target: { handle: string } | { point: { x: number; y: number } };
    file: { name: string; type: string; bytesBase64: string };
  },
): ContentDeliverImageReply {
  let element: unknown;
  /** The point the agent named, when it named one: what the answer echoes. */
  let named: { x: number; y: number } | undefined;
  /** Where the events land, in the coordinates of the document the element belongs to. */
  let local: { x: number; y: number } | undefined;
  if ("handle" in input.target) {
    const record = registry.resolve(input.target.handle, input.documentEpoch);
    if (!record) return { ok: false, reason: "stale-target" };
    element = record.element;
  } else {
    const resolved = resolveByPoint(input.target.point);
    if (!resolved.ok) return resolved;
    element = resolved.element;
    named = input.target.point;
    local = resolved.localPoint;
  }
  const realm = realmOf(element);
  if (isFileInput(element as FileInputLike)) {
    const placed = placeIntoInput(element as FileInputLike, [input.file], { checkAccept: false, realm });
    if (!placed.ok) {
      // One file and no `accept` check leaves exactly one way this can refuse: a realm that cannot
      // build a `FileList` at all.
      return { ok: false, reason: "unsupported" };
    }
    const held = placed.files[0];
    return {
      ok: true,
      delivery: "input",
      // Read from the input, never echoed: that is the evidence FR-040 asks for.
      file: { name: held?.name ?? "", size: held?.size ?? 0 },
    };
  }
  if (typeof (element as { dispatchEvent?: unknown })?.dispatchEvent !== "function") {
    return { ok: false, reason: "not-a-drop-target" };
  }
  if (!realm.DataTransfer || !realm.File || !(realm.DragEvent || realm.Event)) {
    return { ok: false, reason: "unsupported" };
  }
  const bytes = decode(input.file.bytesBase64);
  const at = local ?? centreOf(element);
  const transfer = new realm.DataTransfer();
  transfer.items.add(new realm.File([bytes], input.file.name, { type: input.file.type }));
  const target = element as { dispatchEvent(event: object): boolean };
  // The three a real drop sends, in order, sharing one `DataTransfer`. No `dragleave` after the
  // drop: a browser sends none, and a page that highlighted on `dragenter` is meant to keep the
  // file it was just given. A page that never cancels `dragover` still receives the `drop` - what
  // is reported is delivery, not acceptance, and a page that ignores it simply shows nothing.
  for (const type of ["dragenter", "dragover", "drop"]) {
    const event = dropEvent(realm, type, transfer, at);
    if (event) target.dispatchEvent(event);
  }
  return {
    ok: true,
    delivery: "drop",
    // Nothing to read back from a drop, so the file is echoed - and its size is the bytes' own,
    // decoded here, rather than a number the page could have chosen.
    file: { name: input.file.name, size: bytes.length },
    point: named ?? at,
  };
}
