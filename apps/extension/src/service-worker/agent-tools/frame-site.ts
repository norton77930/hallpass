import { canonicalOriginFromUrl } from "@hallpass/domain";

/**
 * Which site decides an action inside a frame (030 FR-450..FR-453, R-440, R-441).
 *
 * The worker asks the frame that claimed a reference to send it one message, and the browser
 * attaches the sender's origin, frame id and document id to it. Those three are the browser's own
 * data: neither the page nor the frame's content runtime can set them. Measured on 2026-11-07 (T886),
 * they are also the only data that names every frame by its true site - a `srcdoc` frame reports
 * `"null"` for itself while the browser gives it its holder's site, and a sandboxed frame reports
 * its holder's site while the browser gives it an opaque one. So the message body is carried but
 * never read here (D-030-5 as amended): a frame that lies about itself is decided by its true site.
 *
 * Every doubt answers `unknown`, which the gate always asks about (FR-464).
 */

/** The browser's attribution of the frame's message - the fields of `chrome.runtime.MessageSender` used. */
export type FrameSiteSender = {
  origin?: string | undefined;
  frameId?: number | undefined;
  documentId?: string | undefined;
};

/** The frame's reply: what the browser attached to it, and what the frame wrote into it (never read). */
export type FrameSiteReply = {
  sender: FrameSiteSender;
  body?: unknown;
};

/** The frame and document the claim addressed (R-440). */
export type FrameClaim = {
  frameId: number;
  documentId: string;
};

/**
 * The deciding site of one action (data-model DecidingSite). It never outlives the call.
 *
 * - `page`: the target is in the top frame or in a frame whose sender origin is the page's site;
 *   the page's site decides, exactly as before this feature (FR-465).
 * - `frame`: another site's frame; that site decides.
 * - `unknown`: the site could not be established; the gate gets `site: null` and prompts.
 *
 * `frameId` and `documentId` are the claimed ones, kept for the re-check right before the gesture
 * (R-446). They are optional on `page` and `unknown` because a top-frame or coordinate action may
 * decide without a claim.
 */
export type DecidingSite =
  | { kind: "page"; site: string; pageSite: string; frameId?: number; documentId?: string }
  | { kind: "frame"; site: string; pageSite: string; frameId: number; documentId: string }
  | { kind: "unknown"; pageSite: string; frameId?: number; documentId?: string };

/**
 * Decide the site of the claimed frame from the browser's attribution of its reply.
 *
 * `pageSite` is the tab's site as `site-mode-store` keys it. Pure: no browser call, no clock.
 */
export function decideFrameSite(reply: FrameSiteReply, claimed: FrameClaim, pageSite: string): DecidingSite {
  const unknown: DecidingSite = {
    kind: "unknown",
    pageSite,
    frameId: claimed.frameId,
    documentId: claimed.documentId,
  };
  const { origin, frameId, documentId } = reply.sender;
  // A reply from another frame or document - or one the browser did not attribute - says nothing
  // about the frame the claim found, however its origin reads.
  if (typeof frameId !== "number" || frameId !== claimed.frameId) return unknown;
  if (typeof documentId !== "string" || documentId === "" || documentId !== claimed.documentId) return unknown;
  // `"null"` (a sandboxed frame's opaque origin) does not parse, and anything that is not http or
  // https has no site a mode can be stored under, so both are unknown.
  const site = typeof origin === "string" ? canonicalOriginFromUrl(origin) : undefined;
  if (site === undefined || site === "null") return unknown;
  // Full origin (FR-453): scheme, host and port - another port or subdomain is another site.
  if (site === pageSite) {
    return { kind: "page", site, pageSite, frameId: claimed.frameId, documentId: claimed.documentId };
  }
  return { kind: "frame", site, pageSite, frameId: claimed.frameId, documentId: claimed.documentId };
}

/**
 * Whether two decisions name the same site, frame and document (030 FR-460, R-446).
 *
 * The re-check right before the gesture asks the browser again and compares with the decision the
 * gate made: another site, another frame or another document in the same frame is a frame that
 * moved, and so is a change of kind. Pure.
 */
export function sameDecidingSite(decided: DecidingSite, now: DecidingSite): boolean {
  if (decided.kind !== now.kind) return false;
  if (decided.kind !== "unknown" && decided.site !== (now as { site?: string }).site) return false;
  return decided.frameId === now.frameId && decided.documentId === now.documentId;
}

/** A point in the top-level viewport, in CSS pixels - where a coordinate gesture is delivered. */
export type ViewportPoint = { x: number; y: number };

/** One frame's answer to the read-back: what the browser ran it in, and the value it found. */
export type FrameMark = { frameId?: number; documentId?: string; result?: unknown };

/**
 * What the coordinate walk needs from the browser (030 R-442 as settled by T886). Injected, so the
 * walk is a pure function of the answers.
 */
export type PointSitePorts = {
  /** One protocol command on the tab's input attachment, or on an out-of-process frame's session. */
  send(method: string, params: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  /** The tab's out-of-process frame sessions, as auto-attach reported them; a target id is a frame id. */
  sessions(): ReadonlyArray<{ targetId: string; sessionId: string }>;
  /** Every frame's main-world value under `key`, with the browser's frame and document ids. */
  readMarks(key: string): Promise<ReadonlyArray<FrameMark>>;
  /** The browser's sender for one message from frame `frameId` (`probeFrameSender`). */
  probeSender(frameId: number): Promise<{ documentId?: string; sender?: FrameSiteSender }>;
  /** A fresh one-time value; random by default. */
  newNonce?: () => string;
  /** The whole walk's bound; past it the site is unknown. Absent is unbounded. */
  boundMs?: number;
};

/** The main-world global the walk's nonce is written under, and removed from, in one frame. */
export const POINT_SITE_MARK_KEY = "__hallpassPointSiteMark";

/** How many processes deep the walk follows frames; deeper is unknown. */
const POINT_WALK_MAX_SESSIONS = 8;

/** Runs in the frame's main world, on the node found: the nonce goes on that node's window. */
const WRITE_MARK = "function (key, value) { this.ownerDocument.defaultView[key] = value; return true; }";
/** Its counterpart, run on the same node however the read-back went. */
const CLEAR_MARK = "function (key) { delete this.ownerDocument.defaultView[key]; return true; }";

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The content box of a holder, in its session's viewport, from a `DOM.getBoxModel` answer. */
function contentBox(answer: Record<string, unknown>): { x: number; y: number; right: number; bottom: number } | undefined {
  const quad = (answer as { model?: { content?: unknown } }).model?.content;
  if (!Array.isArray(quad) || quad.length !== 8 || !quad.every((value) => typeof value === "number")) return undefined;
  const xs = [quad[0], quad[2], quad[4], quad[6]] as number[];
  const ys = [quad[1], quad[3], quad[5], quad[7]] as number[];
  return { x: Math.min(...xs), y: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

/**
 * The site under a point in the top-level viewport (030 FR-455, R-442 as settled by T886).
 *
 * The debugger finds **which** frame is under the point, and nothing else:
 * 1. `DOM.getNodeForLocation` in the tab's session. Over a frame in the same process the browser
 *    already answers the node inside it, with that frame's id.
 * 2. Over a frame in its own process it answers the holder `IFRAME`. When the point is inside the
 *    holder's content box, the walk continues in that frame's own session - the holder's child
 *    frame id is the frame's target id - at the point shifted by the content box's origin.
 * 3. A node in the top document is the page: its site decides, with no nonce and no probe.
 *
 * Otherwise the frame found is named to the extension by a one-time nonce: written through the
 * debugger on the node found (so into that frame's main world), read back across all frames with
 * the browser's frame and document ids, and removed again however the read-back went. Exactly one
 * frame must hold it. Its site is then the browser's sender origin for that frame and document
 * (`decideFrameSite`), never the debugger's `securityOrigin`, which names a sandboxed frame by its
 * holder's site.
 *
 * Every failed or doubtful step answers `unknown`, which the gate always asks about (FR-464).
 */
export async function resolvePointSite(
  point: ViewportPoint,
  pageSite: string,
  ports: PointSitePorts,
): Promise<DecidingSite> {
  return bounded(walkToPointSite(point, pageSite, ports), pageSite, ports.boundMs);
}

/** A walk that throws, or that has not answered within `boundMs`, is unknown (FR-464). */
async function bounded(walk: Promise<DecidingSite>, pageSite: string, boundMs: number | undefined): Promise<DecidingSite> {
  const unknown: DecidingSite = { kind: "unknown", pageSite };
  const answered = walk.catch((): DecidingSite => unknown);
  if (boundMs === undefined) return answered;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<DecidingSite>((resolve) => {
    timer = setTimeout(() => resolve(unknown), boundMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([answered, bound]);
  } finally {
    clearTimeout(timer);
  }
}

async function walkToPointSite(point: ViewportPoint, pageSite: string, ports: PointSitePorts): Promise<DecidingSite> {
  const unknown: DecidingSite = { kind: "unknown", pageSite };
  const tree = await ports.send("Page.getFrameTree", {});
  const topFrameId = (tree as { frameTree?: { frame?: { id?: unknown } } }).frameTree?.frame?.id;
  if (typeof topFrameId !== "string" || topFrameId === "") return unknown;

  let sessionId: string | undefined;
  let at = point;
  for (let depth = 0; depth < POINT_WALK_MAX_SESSIONS; depth += 1) {
    // The DOM agent answers nothing before it is enabled (`frames.ts`); it is not a diagnostics
    // domain, and nothing here listens to its events.
    await ports.send("DOM.enable", {}, sessionId);
    // The hit-test takes whole pixels only (measured, 030 T905): an element's centre and a point
    // shifted by a holder at a fractional offset are both refused. Rounding down keeps a shifted
    // point inside the frame's own viewport.
    const hit = await ports.send("DOM.getNodeForLocation", { x: Math.floor(at.x), y: Math.floor(at.y) }, sessionId);
    const backendNodeId = (hit as { backendNodeId?: unknown }).backendNodeId;
    const hitFrameId = (hit as { frameId?: unknown }).frameId;
    if (typeof backendNodeId !== "number" || typeof hitFrameId !== "string" || hitFrameId === "") return unknown;
    const described = await ports.send("DOM.describeNode", { backendNodeId }, sessionId);
    const node = (described as { node?: unknown }).node;
    if (node === undefined || node === null || typeof node !== "object") return unknown;
    const childFrameId = (node as { frameId?: unknown }).frameId;

    if (typeof childFrameId === "string" && childFrameId !== "") {
      // A frame holder: the point is either on its border or padding - the holder's own document
      // - or over the frame's content, which another process paints.
      const box = contentBox(await ports.send("DOM.getBoxModel", { backendNodeId }, sessionId));
      if (box === undefined) return unknown;
      const inside = at.x >= box.x && at.x < box.right && at.y >= box.y && at.y < box.bottom;
      if (inside) {
        const child = ports.sessions().find((session) => session.targetId === childFrameId);
        // A frame whose own session is not known cannot be looked into, so its site is unknown.
        if (child === undefined) return unknown;
        sessionId = child.sessionId;
        at = { x: at.x - box.x, y: at.y - box.y };
        continue;
      }
    }

    // The innermost document under the point. The top document is the page, as before 030.
    if (sessionId === undefined && hitFrameId === topFrameId) return { kind: "page", site: pageSite, pageSite };
    return identifyFrame(backendNodeId, sessionId, pageSite, ports);
  }
  return unknown;
}

/** Names the frame holding `backendNodeId` to the extension by a one-time nonce, then decides it. */
async function identifyFrame(
  backendNodeId: number,
  sessionId: string | undefined,
  pageSite: string,
  ports: PointSitePorts,
): Promise<DecidingSite> {
  const unknown: DecidingSite = { kind: "unknown", pageSite };
  const resolved = await ports.send("DOM.resolveNode", { backendNodeId }, sessionId);
  const objectId = (resolved as { object?: { objectId?: unknown } }).object?.objectId;
  if (typeof objectId !== "string" || objectId === "") return unknown;
  const nonce = (ports.newNonce ?? randomNonce)();
  let marks: ReadonlyArray<FrameMark>;
  try {
    await ports.send(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: WRITE_MARK,
        arguments: [{ value: POINT_SITE_MARK_KEY }, { value: nonce }],
        returnByValue: true,
      },
      sessionId,
    );
    marks = await ports.readMarks(POINT_SITE_MARK_KEY);
  } finally {
    // Win or lose (004/T149): left in place, the value is a stable tell that the tab is driven.
    await ports
      .send(
        "Runtime.callFunctionOn",
        { objectId, functionDeclaration: CLEAR_MARK, arguments: [{ value: POINT_SITE_MARK_KEY }], returnByValue: true },
        sessionId,
      )
      .catch(() => undefined);
    await ports.send("Runtime.releaseObject", { objectId }, sessionId).catch(() => undefined);
  }
  const holders = marks.filter((mark) => mark.result === nonce);
  // None means the frame could not be read back; more than one means a page copied the value.
  if (holders.length !== 1) return unknown;
  const { frameId, documentId } = holders[0]!;
  if (typeof frameId !== "number" || typeof documentId !== "string" || documentId === "") return unknown;
  const named: DecidingSite = { kind: "unknown", pageSite, frameId, documentId };
  let probed: { documentId?: string; sender?: FrameSiteSender };
  try {
    probed = await ports.probeSender(frameId);
  } catch {
    probed = {};
  }
  // The probe must have run in the document that held the nonce: a frame that navigated in between
  // is another document, whatever its sender says.
  if (probed.sender === undefined || probed.documentId !== documentId) return named;
  return decideFrameSite({ sender: probed.sender }, { frameId, documentId }, pageSite);
}

/**
 * One frame's answer to the focus read (030 T908): the browser's frame and document ids, and what
 * the frame said about focus. `result` is `{ path, focusedChild }` - the frame's index path from the
 * top document, and which of its own child frames holds its focus (`-1`: none, the focus is in this
 * document; anything that is not an index: a holder whose frame could not be named).
 */
export type FrameFocusAnswer = { frameId?: number; documentId?: string; result?: unknown };

/** What the focus walk needs from the browser (030 T908). Injected, so the walk is a pure function of the answers. */
export type FocusSitePorts = {
  /** Every frame's focus answer, read in one round trip across all frames (`readFrameFocus`). */
  readFocus(): Promise<ReadonlyArray<FrameFocusAnswer>>;
  /** The browser's sender for one message from frame `frameId` (`probeFrameSender`). */
  probeSender(frameId: number): Promise<{ documentId?: string; sender?: FrameSiteSender }>;
  /** The whole walk's bound; past it the site is unknown. Absent is unbounded. */
  boundMs?: number;
};

/**
 * How many frames deep the focus chain is followed, and how many shadow levels a frame follows its
 * own focus (`focusOfFrame` gets it through `executeScript` args); deeper is unknown.
 */
export const FOCUS_WALK_MAX_DEPTH = 32;

type FocusEntry = { frameId: number; documentId: string; path: number[]; focusedChild: unknown };

/** A focus answer as the walk reads it, or `undefined` when it is not one. */
function focusEntry(answer: FrameFocusAnswer): FocusEntry | undefined {
  const { frameId, documentId, result } = answer;
  if (typeof frameId !== "number" || typeof documentId !== "string" || documentId === "") return undefined;
  if (result === null || typeof result !== "object") return undefined;
  const { path, focusedChild } = result as { path?: unknown; focusedChild?: unknown };
  if (!Array.isArray(path) || !path.every((index) => Number.isInteger(index) && (index as number) >= 0)) return undefined;
  return { frameId, documentId, path: path as number[], focusedChild };
}

/**
 * The site of the frame that holds the tab's focus - where keys sent to "whatever has focus" land
 * (030 T908, FR-450, FR-464).
 *
 * Every frame is asked, in one round trip, where it sits (its index path from the top) and which of
 * its own child frames, if any, holds its focus. The chain is followed from the top document down
 * to the document whose focus is its own, which is the one keys reach. Whether the window has the
 * system's focus does not matter: a document keeps its focused element either way.
 *
 * The frame found is named by the browser's own frame and document ids on its answer, never by
 * anything it said about itself, and its site is the browser's sender origin for that frame and
 * document (`decideFrameSite`). Focus in the top document is the page, as before 030.
 *
 * Every doubt answers `unknown`, which the gate always asks about: a link of the chain that did not
 * answer, two frames at one place, a holder whose frame could not be named, a probe answered from
 * another document, a read that failed, or one past the bound.
 */
export async function resolveFocusSite(pageSite: string, ports: FocusSitePorts): Promise<DecidingSite> {
  return bounded(walkToFocusSite(pageSite, ports), pageSite, ports.boundMs);
}

async function walkToFocusSite(pageSite: string, ports: FocusSitePorts): Promise<DecidingSite> {
  const unknown: DecidingSite = { kind: "unknown", pageSite };
  const byPath = new Map<string, FocusEntry | "ambiguous">();
  for (const answer of await ports.readFocus()) {
    const entry = focusEntry(answer);
    if (entry === undefined) continue;
    const key = entry.path.join(".");
    byPath.set(key, byPath.has(key) ? "ambiguous" : entry);
  }

  let path: number[] = [];
  for (let depth = 0; depth <= FOCUS_WALK_MAX_DEPTH; depth += 1) {
    const entry = byPath.get(path.join("."));
    // A link that did not answer, or two frames claiming one place: the frame keys reach is unknown.
    if (entry === undefined || entry === "ambiguous") return unknown;
    // The top document is frame 0 in the browser's own numbering; any other answer there is not it.
    if (path.length === 0 && entry.frameId !== 0) return unknown;
    const child = entry.focusedChild;
    if (child === -1) {
      if (path.length === 0) return { kind: "page", site: pageSite, pageSite };
      return identifyFocusedFrame(entry.frameId, entry.documentId, pageSite, ports);
    }
    if (typeof child !== "number" || !Number.isInteger(child) || child < 0) return unknown;
    path = [...path, child];
  }
  return unknown;
}

/** The focused child frame's site, from the browser's sender for the document that answered (R-440). */
async function identifyFocusedFrame(
  frameId: number,
  documentId: string,
  pageSite: string,
  ports: FocusSitePorts,
): Promise<DecidingSite> {
  const named: DecidingSite = { kind: "unknown", pageSite, frameId, documentId };
  let probed: { documentId?: string; sender?: FrameSiteSender };
  try {
    probed = await ports.probeSender(frameId);
  } catch {
    probed = {};
  }
  // The probe must have run in the document that answered the focus read.
  if (probed.sender === undefined || probed.documentId !== documentId) return named;
  return decideFrameSite({ sender: probed.sender }, { frameId, documentId }, pageSite);
}
