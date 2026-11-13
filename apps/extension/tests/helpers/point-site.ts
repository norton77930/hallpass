/**
 * A page as the debugger and the browser see it, for the 030 coordinate walk (R-442 as settled by
 * T886, `resolvePointSite`).
 *
 * The model follows what was measured on 2026-11-07:
 * - `DOM.getNodeForLocation` in a session answers the node under a point in that session's own
 *   *document* coordinates - its viewport point plus its own scroll (measured 2026-11-14, #67) - while
 *   `DOM.getBoxModel` and every box here are viewport coordinates. Over a frame in the same process it answers the node *inside* that frame, with the
 *   frame's id; over a frame in its own process it answers the holder `IFRAME`, with the holder's
 *   document's frame id, and `DOM.describeNode` gives the holder's child frame id, which is that
 *   frame's target id.
 * - `securityOrigin` is carried in the frame tree but is never the site (a sandboxed frame reports
 *   its holder's); only the browser's sender origin is.
 * - `Runtime.callFunctionOn` runs the declared function for real, against a stand-in for the node
 *   whose `ownerDocument.defaultView` is that frame's main-world globals, so the walk's own write
 *   and clear are exercised rather than assumed.
 */

export type FakeFrame = {
  /** The CDP frame id; for a frame in its own process, also its target id. */
  cdpFrameId: string;
  /** The content box in its parent document's viewport. */
  box: { x: number; y: number; width: number; height: number };
  outOfProcess: boolean;
  /** The extension's frame id and the browser's document id for the frame's current document. */
  frameId: number;
  documentId: string;
  /** The origin the browser gives the frame as a message sender (`"null"` when sandboxed). */
  sender: string;
  /** What the debugger calls its origin - present to show it is never read. */
  securityOrigin?: string;
  children?: FakeFrame[];
};

export type FakePointPageOptions = {
  pageSite: string;
  /** The top document's ids. */
  top?: { frameId: number; documentId: string };
  /** Out-of-process frames whose session the auto-attach table does not hold. */
  missingSessions?: string[];
  /** Frames `executeScript` does not reach (no result for them). */
  unscriptable?: number[];
  /** Methods that reject, as a detached or refusing debugger would. */
  failing?: string[];
  /**
   * How far each session's document is scrolled (#67), keyed by the CDP frame id of the session's
   * root (`TOP_CDP_FRAME_ID` for the tab's own session). Unscrolled when absent.
   */
  scroll?: Record<string, { x: number; y: number }>;
};

export const TOP_CDP_FRAME_ID = "top-frame";

type DocNode = { kind: "body"; doc: string } | { kind: "holder"; frame: FakeFrame; doc: string };

export function fakePointPage(frames: FakeFrame[], options: FakePointPageOptions) {
  const top = options.top ?? { frameId: 0, documentId: "bdoc-top" };
  const calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  const probed: number[] = [];
  const marksRead: string[] = [];
  /** Each document's main-world globals, keyed by CDP frame id. */
  const globals = new Map<string, Record<string, unknown>>([[TOP_CDP_FRAME_ID, {}]]);
  /** CDP frame id → the frame, its parent document, and its process root. */
  const byCdp = new Map<string, { frame: FakeFrame; parent: string }>();
  const walk = (list: FakeFrame[], parent: string): void => {
    for (const frame of list) {
      byCdp.set(frame.cdpFrameId, { frame, parent });
      globals.set(frame.cdpFrameId, {});
      walk(frame.children ?? [], frame.cdpFrameId);
    }
  };
  walk(frames, TOP_CDP_FRAME_ID);

  const sessionOf = (cdpFrameId: string): string => `session-${cdpFrameId}`;
  const childrenOf = (doc: string): FakeFrame[] =>
    doc === TOP_CDP_FRAME_ID ? frames : (byCdp.get(doc)?.frame.children ?? []);
  /** The document a session's viewport belongs to. */
  const rootOf = (sessionId: string | undefined): string | undefined => {
    if (sessionId === undefined) return TOP_CDP_FRAME_ID;
    for (const [cdp, entry] of byCdp) {
      if (entry.frame.outOfProcess && sessionOf(cdp) === sessionId) return cdp;
    }
    return undefined;
  };
  /** Where a document's (0, 0) is in its process root's viewport. */
  const offsetInRoot = (doc: string): { x: number; y: number } => {
    let x = 0;
    let y = 0;
    let current = doc;
    while (current !== TOP_CDP_FRAME_ID) {
      const entry = byCdp.get(current)!;
      if (entry.frame.outOfProcess) break;
      x += entry.frame.box.x;
      y += entry.frame.box.y;
      current = entry.parent;
    }
    return { x, y };
  };

  let nextId = 100;
  const nodes = new Map<number, DocNode>();
  const idOf = (node: DocNode): number => {
    for (const [id, existing] of nodes) {
      if (existing.kind === node.kind && existing.doc === node.doc && (existing.kind === "body" || existing.frame === (node as { frame: FakeFrame }).frame)) {
        return id;
      }
    }
    nextId += 1;
    nodes.set(nextId, node);
    return nextId;
  };
  const objects = new Map<string, string>();

  function hit(doc: string, point: { x: number; y: number }): { backendNodeId: number; frameId: string } {
    for (const child of childrenOf(doc)) {
      const inside =
        point.x >= child.box.x &&
        point.x < child.box.x + child.box.width &&
        point.y >= child.box.y &&
        point.y < child.box.y + child.box.height;
      if (!inside) continue;
      if (child.outOfProcess) return { backendNodeId: idOf({ kind: "holder", frame: child, doc }), frameId: doc };
      return hit(child.cdpFrameId, { x: point.x - child.box.x, y: point.y - child.box.y });
    }
    return { backendNodeId: idOf({ kind: "body", doc }), frameId: doc };
  }

  async function send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    calls.push({ method, params, ...(sessionId === undefined ? {} : { sessionId }) });
    if (options.failing?.includes(method)) throw new Error(`${method} failed`);
    const root = rootOf(sessionId);
    if (root === undefined) throw new Error("No session with given id");
    switch (method) {
      case "Page.getFrameTree": {
        const tree = (doc: string): Record<string, unknown> => ({
          frame: {
            id: doc,
            securityOrigin: doc === TOP_CDP_FRAME_ID ? options.pageSite : (byCdp.get(doc)?.frame.securityOrigin ?? "://"),
          },
          childFrames: childrenOf(doc)
            .filter((child) => !child.outOfProcess)
            .map((child) => tree(child.cdpFrameId)),
        });
        return { frameTree: tree(root) };
      }
      case "DOM.enable":
        return {};
      case "Page.getLayoutMetrics": {
        const scrolled = options.scroll?.[root] ?? { x: 0, y: 0 };
        return { cssLayoutViewport: { pageX: scrolled.x, pageY: scrolled.y, clientWidth: 1280, clientHeight: 720 } };
      }
      case "DOM.getNodeForLocation": {
        // As Chrome answers it (measured 030 T905): the point is two int32s, and a fractional one -
        // a box's centre, or a point shifted by a holder at a fractional offset - is refused.
        if (!Number.isInteger(params.x) || !Number.isInteger(params.y)) {
          throw new Error(
            '{"code":-32602,"data":"Failed to deserialize params.x - BINDINGS: int32 value expected","message":"Invalid parameters"}',
          );
        }
        // Document coordinates in, viewport coordinates for the model.
        const scrolled = options.scroll?.[root] ?? { x: 0, y: 0 };
        return hit(root, { x: Number(params.x) - scrolled.x, y: Number(params.y) - scrolled.y });
      }
      case "DOM.describeNode": {
        const node = nodes.get(Number(params.backendNodeId));
        if (!node) throw new Error("No node with given id found");
        return node.kind === "body"
          ? { node: { backendNodeId: params.backendNodeId, nodeName: "BODY" } }
          : { node: { backendNodeId: params.backendNodeId, nodeName: "IFRAME", frameId: node.frame.cdpFrameId } };
      }
      case "DOM.getBoxModel": {
        const node = nodes.get(Number(params.backendNodeId));
        if (!node || node.kind !== "holder") throw new Error("Could not compute box model.");
        const base = offsetInRoot(node.doc);
        const { x, y, width, height } = node.frame.box;
        const left = base.x + x;
        const topY = base.y + y;
        // Border and padding around the content box, so a walk using the border quad is wrong.
        return {
          model: {
            content: [left, topY, left + width, topY, left + width, topY + height, left, topY + height],
            border: [left - 2, topY - 2, left + width + 2, topY - 2, left + width + 2, topY + height + 2, left - 2, topY + height + 2],
            width: width + 4,
            height: height + 4,
          },
        };
      }
      case "DOM.resolveNode": {
        const node = nodes.get(Number(params.backendNodeId));
        if (!node) throw new Error("No node with given id found");
        const objectId = `obj-${params.backendNodeId}`;
        objects.set(objectId, node.doc);
        return { object: { type: "object", objectId } };
      }
      case "Runtime.callFunctionOn": {
        const doc = objects.get(String(params.objectId));
        if (doc === undefined) throw new Error("Could not find object with given id");
        const declared = String(params.functionDeclaration);
        const fn = new Function(`return (${declared});`)() as (...args: unknown[]) => unknown;
        const self = { ownerDocument: { defaultView: globals.get(doc)! } };
        const args = ((params.arguments as Array<{ value?: unknown }> | undefined) ?? []).map((arg) => arg.value);
        return { result: { value: fn.apply(self, args) } };
      }
      case "Runtime.releaseObject":
        objects.delete(String(params.objectId));
        return {};
      default:
        return {};
    }
  }

  function sessions(): Array<{ targetId: string; sessionId: string; url: string }> {
    return [...byCdp.values()]
      .filter((entry) => entry.frame.outOfProcess && !options.missingSessions?.includes(entry.frame.cdpFrameId))
      .map((entry) => ({ targetId: entry.frame.cdpFrameId, sessionId: sessionOf(entry.frame.cdpFrameId), url: "" }));
  }

  /** `executeScript({allFrames: true, world: "MAIN"})` reading one global in every frame. */
  async function readMarks(key: string): Promise<Array<{ frameId: number; documentId: string; result: unknown }>> {
    marksRead.push(key);
    const all = [
      { frameId: top.frameId, documentId: top.documentId, cdp: TOP_CDP_FRAME_ID },
      ...[...byCdp.values()].map((entry) => ({
        frameId: entry.frame.frameId,
        documentId: entry.frame.documentId,
        cdp: entry.frame.cdpFrameId,
      })),
    ];
    return all
      .filter((entry) => !options.unscriptable?.includes(entry.frameId))
      .map((entry) => {
        const value = globals.get(entry.cdp)?.[key];
        return { frameId: entry.frameId, documentId: entry.documentId, result: typeof value === "string" ? value : null };
      });
  }

  /** `probeFrameSender`: what the browser attaches to one message from the frame. */
  async function probeSender(frameId: number): Promise<{ documentId?: string; sender?: { origin?: string; frameId?: number; documentId?: string } }> {
    probed.push(frameId);
    if (frameId === top.frameId) {
      return { documentId: top.documentId, sender: { origin: options.pageSite, frameId, documentId: top.documentId } };
    }
    const entry = [...byCdp.values()].find((candidate) => candidate.frame.frameId === frameId);
    if (!entry) return {};
    const { documentId, sender } = entry.frame;
    return { documentId, sender: { origin: sender, frameId, documentId } };
  }

  /** Every main-world global the walk left behind, across all frames. */
  function leftovers(): Array<{ frame: string; key: string }> {
    return [...globals.entries()].flatMap(([frame, values]) => Object.keys(values).map((key) => ({ frame, key })));
  }

  /** Put a value into a frame's main world, as a page script would. */
  function plant(cdpFrameId: string, key: string, value: unknown): void {
    globals.get(cdpFrameId)![key] = value;
  }

  return { send, sessions, readMarks, probeSender, calls, probed, marksRead, leftovers, plant, globals };
}

/**
 * A page of one document, in the debugger's words: the few answers the walk needs to find that a
 * point is in the top document (an unscrolled one, #67). For the suites whose fake debugger answers
 * `{}` to everything else.
 */
export function oneDocumentAnswer(method: string): Record<string, unknown> | undefined {
  if (method === "Page.getFrameTree") return { frameTree: { frame: { id: TOP_CDP_FRAME_ID } } };
  if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { pageX: 0, pageY: 0 } };
  if (method === "DOM.getNodeForLocation") return { backendNodeId: 1, frameId: TOP_CDP_FRAME_ID };
  if (method === "DOM.describeNode") return { node: { backendNodeId: 1, nodeName: "BODY" } };
  return undefined;
}

/**
 * A page of one document, as the focus read sees it (030 T908): the top document answers, and its
 * focus is its own. For the suites that send keys with no target to a page with no frames.
 */
export async function oneDocumentFocus(): Promise<Array<{ frameId: number; documentId: string; result: unknown }>> {
  return [{ frameId: 0, documentId: "bdoc-top", result: { path: [], focusedChild: -1 } }];
}

/**
 * A debugger attachment that answers only the coordinate walk: from `page` when a test models one,
 * otherwise as a page of one document. Everything else answers `{}`. For runners that ask which
 * frame is under a point and deliver nothing over the debugger themselves (`upload_image`'s drop).
 */
export function pointSiteAttachments(page?: ReturnType<typeof fakePointPage>) {
  const commands: Array<{ tabId: number; method: string; sessionId?: string }> = [];
  const acquired: Array<{ tabId: number; holder: string }> = [];
  /** 031/T945: each call's hold, and whether its `done` has run. */
  const holds: Array<{ tabId: number; done: boolean }> = [];
  async function acquire(tabId: number, holder: string) {
    acquired.push({ tabId, holder });
    return { ok: true as const };
  }
  const attachments = {
    acquire,
    async hold(tabId: number) {
      const entry = { tabId, done: false };
      holds.push(entry);
      return { outcome: await acquire(tabId, "input"), done: () => void (entry.done = true) };
    },
    holders: () => [],
    async drop() {},
    async release() {},
    async releaseAll() {},
    async send(tabId: number, method: string, params?: Record<string, unknown>, sessionId?: string) {
      commands.push({ tabId, method, ...(sessionId === undefined ? {} : { sessionId }) });
      if (page !== undefined) return page.send(method, params ?? {}, sessionId);
      return oneDocumentAnswer(method) ?? {};
    },
    oopifSessions: () => page?.sessions() ?? [],
    attached: () => [],
    state: () => undefined,
    onEvent() {},
    onDetach() {},
    onAttached() {},
  };
  return { attachments, commands, acquired, holds };
}
