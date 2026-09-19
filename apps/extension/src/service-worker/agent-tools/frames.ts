import {
  AGENT_READ_PAGE_MAX_CHARS,
  AGENT_READ_PAGE_MAX_NODES,
  DEFAULT_BOUNDS,
  type AgentReadPageResult,
} from "@hallpass/contracts";

/**
 * One page out of every frame it is made of (004/T113, US4 read half, R-114, FR-063).
 *
 * A page whose content lives in an embedded frame is the owner's largest capability gap: 003 asked
 * the top document and nothing else, so the artifact body of a claude.ai page - the whole reason
 * the page was open - was simply absent from the answer, with nothing in the answer saying so. This
 * module is the merge: enumerate the tab's frames, ask each one for its own document, and put the
 * pieces back together as the one tree a person sees.
 *
 * Three things it will not do, each because the alternative lies to the agent:
 *
 * - **It does not fail because a frame was quiet.** A frame that answers nothing is listed
 *   `readable: false, reason: "no-answer"` and the read still succeeds with everything else. "This
 *   page has a part I cannot read" and "this page is unreadable" send an agent to two different
 *   next moves, and only one of them is true here. S2 already established that the declared content
 *   script is in every frame from `document_start` and that a frame with no receiver is
 *   indistinguishable from a frame that stayed silent (the T107a lesson) - so silence is decided by
 *   a real bounded wait, never by matching what an error said.
 * - **It does not hand out browser frame ids.** Labels are `0` for the top document and `f1`,
 *   `f2`… in tree order, minted per answer. Chrome's frame id is a browser-wide handle an agent
 *   could keep and re-use after the document it named is gone; the label cannot outlive the answer
 *   it came in.
 * - **It does not bound each frame separately.** The node and character ceilings are what an
 *   *unasked-for read* may cost the agent's context (FR-064), so they are ceilings on the page. Ten
 *   frames each spending the whole budget would be ten times the read the agent asked for. The wait
 *   is bounded the same way and for the same reason: the frames are asked together against one
 *   deadline, so a page of quiet frames costs one bound rather than one per frame.
 */

/**
 * A frame as the browser enumerates it, in the shape Chrome's own frame enumeration reports.
 *
 * The enumeration itself is injected (`enumerateFrames`) rather than called here: which browser API
 * supplies it is the wiring slice's decision, and this module only needs the three facts every one
 * of them reports - the frame, its parent, and the url the browser has for it.
 */
export type BrowserFrame = {
  frameId: number;
  /** `-1` for the top document, which is how the browser says "this one has no parent". */
  parentFrameId: number;
  url: string;
};

/**
 * One node of a single frame's own document, before it is part of a page.
 *
 * `depth` is frame-local - each frame collects from its own root and has no way to know how deep
 * it sits - so the merge is what turns it into a depth in the page. `frameOwner` marks the element
 * that *holds* a child frame, which is what lets a child's nodes land under it rather than after
 * everything the parent had.
 */
export type FrameSubtreeNode = Omit<AgentReadPageResult["nodes"][number], "frame"> & {
  frameOwner?: boolean;
};

/** The four field-state members a node or a match may carry (005/FR-072..FR-074). */
export type CarriedFieldState = Pick<
  AgentReadPageResult["nodes"][number],
  "value" | "checked" | "redacted" | "valueTruncated"
>;

/**
 * What a collected node says its control holds, as the answer carries it (005/T173, R-122).
 *
 * One reader for both tools, because scenario 8 of US1 is that `find` says exactly what
 * `read_page` does. The page decided everything - what is a value, what is redacted, where the
 * bound fell - so the worker only checks each member is the type the contract promises; it never
 * reads a value into a node the page marked redacted, because the page never sent one.
 */
export function carriedFieldState(node: unknown): CarriedFieldState {
  const fields = node as { value?: unknown; checked?: unknown; redacted?: unknown; valueTruncated?: unknown };
  return {
    ...(typeof fields.value === "string" ? { value: fields.value } : {}),
    ...(typeof fields.checked === "boolean" ? { checked: fields.checked } : {}),
    ...(fields.redacted === true ? { redacted: true } : {}),
    ...(fields.valueTruncated === true ? { valueTruncated: true } : {}),
  };
}

export type FrameSubtreeReader = (input: { tabId: number; frameId: number }) => Promise<{
  nodes: FrameSubtreeNode[];
}>;

export type FrameEnumerator = (tabId: number) => Promise<BrowserFrame[]>;

/**
 * How long the whole page has to answer, in milliseconds.
 *
 * It is a termination bound, not a latency target: what it buys is that a read of a page holding a
 * frame nobody is listening in still *ends*, with that frame named. Two seconds is well past what a
 * loaded document takes to walk itself and short enough that an agent is not left waiting on a
 * frame that was never going to speak.
 */
export const FRAME_ANSWER_BOUND_MS = 2_000;

export type MergePageFramesDeps = {
  enumerateFrames: FrameEnumerator;
  readSubtree: FrameSubtreeReader;
  /** The whole page's answer bound; `FRAME_ANSWER_BOUND_MS` unless a caller tightens it. */
  boundMs?: number;
  maxNodes?: number;
  maxChars?: number;
};

/** Which ceiling ran out, so the answer can say what was cut rather than that something was. */
export type PageTruncationLimit = "nodes" | "chars";

export type MergedPage = {
  frames: NonNullable<AgentReadPageResult["frames"]>;
  nodes: AgentReadPageResult["nodes"];
  truncated: boolean;
  truncatedBy?: PageTruncationLimit;
};

/** The one value that means "the page's bound came first"; not an error, and never page content. */
const EXPIRED = Symbol("frame-answer-bound-reached");

/** The top document's label. Fixed, because there is exactly one and every parent chain ends at it. */
const TOP_FRAME_LABEL = "0";

/**
 * The schemes a content script may not run in, whatever the extension's host permissions say.
 *
 * This is the browser's refusal, known before anything is asked, which is why such a frame is
 * `not-allowed` rather than `no-answer`: waiting out the bound on a frame that could never have
 * answered would spend the page's whole budget to learn what the url already said.
 */
const FORBIDDEN_FRAME_SCHEMES = new Set([
  "chrome:",
  "chrome-untrusted:",
  "chrome-extension:",
  "chrome-search:",
  "devtools:",
  "edge:",
  "view-source:",
]);

function isForbiddenFrame(url: string): boolean {
  const scheme = url.slice(0, url.indexOf(":") + 1).toLowerCase();
  return scheme !== "" && FORBIDDEN_FRAME_SCHEMES.has(scheme);
}

/** What a node costs against the character ceiling: the only text a structural read carries. */
function nodeChars(node: { name?: string | undefined }): number {
  return node.name === undefined ? 0 : node.name.length;
}

type PendingFrame<T> = {
  frame: BrowserFrame;
  label: string;
  parentLabel: string;
  children: PendingFrame<T>[];
  /** Filled once the frame answers; left undefined when it did not, or was never asked. */
  answer?: T;
  readable: boolean;
  reason?: "not-allowed" | "no-answer";
};

/**
 * Tree order: the top document, then each frame's children in the order the browser enumerated
 * them, depth first. It is the order a person would read the page in, and the order the labels are
 * minted in, so `f1` is always the first frame of the page rather than the first frame to answer.
 */
function buildTree<T>(frames: BrowserFrame[]): { root?: PendingFrame<T>; inOrder: PendingFrame<T>[] } {
  const top = frames.find((frame) => frame.parentFrameId < 0) ?? frames[0];
  if (!top) return { inOrder: [] };
  const byParent = new Map<number, BrowserFrame[]>();
  for (const frame of frames) {
    if (frame.frameId === top.frameId) continue;
    const siblings = byParent.get(frame.parentFrameId);
    if (siblings) siblings.push(frame);
    else byParent.set(frame.parentFrameId, [frame]);
  }
  const inOrder: PendingFrame<T>[] = [];
  let nextLabel = 1;
  const visit = (frame: BrowserFrame, label: string, parentLabel: string): PendingFrame<T> => {
    const pending: PendingFrame<T> = { frame, label, parentLabel, children: [], readable: true };
    inOrder.push(pending);
    for (const child of byParent.get(frame.frameId) ?? []) {
      pending.children.push(visit(child, `f${nextLabel++}`, label));
    }
    return pending;
  };
  const root = visit(top, TOP_FRAME_LABEL, TOP_FRAME_LABEL);
  return { root, inOrder };
}

/**
 * Flattens the answered frames into one node list.
 *
 * A child frame's block is spliced in directly after the node that owns it, at one level deeper, so
 * the merged depth describes the page rather than the document the node happened to be collected
 * from. Owners are paired with children *by order* - the i-th frame-owning node of a document holds
 * the i-th child frame the browser listed under it - because that is the only pairing that holds
 * for the frames with no distinguishing url (`srcdoc`, `about:blank`), and a url match would
 * silently put a frame's content under the wrong element on exactly those pages. A child left
 * unpaired (its owner was inside a part that was cut, or its parent never answered) still appears,
 * after its parent's nodes, so no readable frame's content is dropped for want of an owner.
 */
function flatten(
  pending: PendingFrame<{ nodes: FrameSubtreeNode[] }>,
  baseDepth: number,
  out: AgentReadPageResult["nodes"],
): void {
  const children = [...pending.children];
  for (const node of pending.answer?.nodes ?? []) {
    const depth = baseDepth + node.depth;
    const { frameOwner, ...carried } = node;
    out.push({ ...carried, depth, frame: pending.label });
    if (frameOwner === true) {
      const child = children.shift();
      if (child) flatten(child, depth + 1, out);
    }
  }
  for (const child of children) {
    flatten(child, baseDepth, out);
  }
}

/**
 * Asks every frame of the page the same question, in parallel, against **one** deadline.
 *
 * The shape all three read tools share, and the one place the two facts that make a framed read
 * honest live: a frame the browser would never let a script into is refused from its url before any
 * of the budget is spent on it, and a frame that loses the race is *listed* as having said nothing
 * rather than turning the page's answer into a failure. The wait is per page, not per frame, for
 * the same reason the node and character ceilings are.
 */
async function askEveryFrame<T>(
  tabId: number,
  frames: BrowserFrame[],
  ask: (input: { tabId: number; frameId: number }) => Promise<T>,
  boundMs: number,
): Promise<{ root?: PendingFrame<T>; inOrder: PendingFrame<T>[] }> {
  const { root, inOrder } = buildTree<T>(frames);
  if (!root) return { inOrder };

  /**
   * One deadline for the page, started before the first frame is asked and shared by all of them.
   * It is a real wait: the losing frame is one that has not answered *yet*, which is the same fact
   * as a frame with nobody listening, and the only honest way to tell them apart is to have waited.
   */
  let expire: (() => void) | undefined;
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    const timer = setTimeout(() => resolve(EXPIRED), boundMs);
    expire = () => {
      clearTimeout(timer);
      resolve(EXPIRED);
    };
  });

  await Promise.all(
    inOrder.map(async (pending) => {
      if (isForbiddenFrame(pending.frame.url)) {
        pending.readable = false;
        pending.reason = "not-allowed";
        return;
      }
      let answer: T | typeof EXPIRED;
      try {
        answer = await Promise.race([ask({ tabId, frameId: pending.frame.frameId }), expired]);
      } catch {
        // A frame whose ask threw said nothing, which is the one fact available about it. It is
        // reported with the word for that and not with a second one meaning "it failed loudly".
        answer = EXPIRED;
      }
      if (answer === EXPIRED) {
        pending.readable = false;
        pending.reason = "no-answer";
        return;
      }
      pending.answer = answer;
    }),
  );
  // Nothing is waiting on the deadline any more; leaving the timer armed would keep the worker
  // alive for the rest of the bound after the page has been answered.
  expire?.();
  return { root, inOrder };
}

/**
 * Which documents a tab is made of, and the one answer that is always true about it.
 *
 * A tab has a top document whatever the enumeration says, so an enumeration that fails or comes
 * back empty leaves a read as the read it was before frames: the top document, alone. The
 * alternative - an empty page - would report the tab as containing nothing, which is the one answer
 * that is certainly wrong.
 */
export async function tabFrames(
  tabId: number,
  fallbackUrl: string,
  enumerate: FrameEnumerator,
): Promise<BrowserFrame[]> {
  try {
    const frames = await enumerate(tabId);
    if (frames.length > 0) return frames;
  } catch {
    // Falls through to the top document, which is there whether or not it was enumerated.
  }
  return [{ frameId: 0, parentFrameId: -1, url: fallbackUrl }];
}

/** How a frame is listed once it has been asked: the label, where it sits, and whether it spoke. */
function listFrames<T>(inOrder: PendingFrame<T>[]): NonNullable<AgentReadPageResult["frames"]> {
  return inOrder.map((pending) => ({
    frame: pending.label,
    parent: pending.parentLabel,
    url: pending.frame.url,
    readable: pending.readable,
    ...(pending.reason === undefined ? {} : { reason: pending.reason }),
  }));
}

export async function mergePageFrames(tabId: number, deps: MergePageFramesDeps): Promise<MergedPage> {
  const maxNodes = deps.maxNodes ?? AGENT_READ_PAGE_MAX_NODES;
  const maxChars = deps.maxChars ?? AGENT_READ_PAGE_MAX_CHARS;

  const { root, inOrder } = await askEveryFrame(
    tabId,
    await deps.enumerateFrames(tabId),
    deps.readSubtree,
    deps.boundMs ?? FRAME_ANSWER_BOUND_MS,
  );
  if (!root) return { frames: [], nodes: [], truncated: false };

  const merged: AgentReadPageResult["nodes"] = [];
  flatten(root, 0, merged);

  const capped = capPageNodes(merged, { maxNodes, maxChars });
  return {
    frames: listFrames(inOrder),
    nodes: capped.nodes,
    truncated: capped.truncatedBy !== undefined,
    ...(capped.truncatedBy === undefined ? {} : { truncatedBy: capped.truncatedBy }),
  };
}

/**
 * The page's ceilings, applied once (004/FR-064, R-116).
 *
 * They live here, beside the merge, because they are page-wide: how many nodes and how many
 * characters one read may cost the agent's context is a question about the answer, not about any
 * document that contributed to it. A page of one document goes through the same function rather
 * than a bound of its own - a second ceiling would mean a page read a different size depending on
 * whether it happened to hold a frame.
 */
export function capPageNodes(
  merged: AgentReadPageResult["nodes"],
  limits: { maxNodes?: number; maxChars?: number } = {},
): { nodes: AgentReadPageResult["nodes"]; truncatedBy?: PageTruncationLimit } {
  const maxNodes = limits.maxNodes ?? AGENT_READ_PAGE_MAX_NODES;
  const maxChars = limits.maxChars ?? AGENT_READ_PAGE_MAX_CHARS;
  const nodes: AgentReadPageResult["nodes"] = [];
  let chars = 0;
  for (const node of merged) {
    if (nodes.length >= maxNodes) return { nodes, truncatedBy: "nodes" };
    const cost = nodeChars(node);
    if (chars + cost > maxChars) return { nodes, truncatedBy: "chars" };
    chars += cost;
    nodes.push(node);
  }
  return { nodes };
}

/** One frame's own readable text, and whether the collector's bound cut it there. */
export type FrameTextReader = (input: { tabId: number; frameId: number }) => Promise<{
  text: string;
  truncated: boolean;
}>;

export type MergePageTextDeps = {
  enumerateFrames: FrameEnumerator;
  readText: FrameTextReader;
  boundMs?: number;
  maxChars?: number;
};

/**
 * What separates one frame's text from the next.
 *
 * A newline, because that is what the frames are to a reader: separate blocks of the same page.
 * Running them together would invent words at every seam, and any richer separator would be the
 * worker narrating the document rather than reporting it.
 */
const FRAME_TEXT_SEPARATOR = "\n";

/**
 * The page's text out of every frame it is made of (004/T115, US4 read half, FR-036).
 *
 * The answer keeps the shape it always had - a string and whether it was cut - because the
 * structured read is where frame accounting belongs and a text read gains no frame list. That has
 * one consequence worth naming: with no list to say which part is missing, `truncated` is the only
 * channel this answer has for "you have not been shown all of the page", so a frame that could not
 * be read sets it, exactly as the character ceiling does. Saying `false` there would hand an agent
 * a part of a page under the word for the whole of it.
 */
export async function mergePageText(
  tabId: number,
  deps: MergePageTextDeps,
): Promise<{ text: string; truncated: boolean; truncatedBy?: "chars" }> {
  const maxChars = deps.maxChars ?? DEFAULT_BOUNDS.maxVisibleTextChars;
  const { root, inOrder } = await askEveryFrame(
    tabId,
    await deps.enumerateFrames(tabId),
    deps.readText,
    deps.boundMs ?? FRAME_ANSWER_BOUND_MS,
  );
  if (!root) return { text: "", truncated: false };

  const parts: string[] = [];
  let truncated = false;
  // Which limit ran out, when one did (004/T135a). A frame's own cut is the character bound too -
  // it is the only bound a text collection has - so it names the same limit the merge would.
  let byChars = false;
  for (const pending of inOrder) {
    if (!pending.readable || pending.answer === undefined) {
      // A frame that did not answer contributes nothing - not an empty line, and not a sentence
      // about itself: prose describing the failure would be text an agent could read as page
      // content, and the answer already has a field for "this is not all of it".
      truncated = true;
      continue;
    }
    if (pending.answer.truncated) {
      truncated = true;
      byChars = true;
    }
    if (pending.answer.text.length > 0) parts.push(pending.answer.text);
  }
  const text = parts.join(FRAME_TEXT_SEPARATOR);
  if (text.length > maxChars) return { text: text.slice(0, maxChars), truncated: true, truncatedBy: "chars" };
  return { text, truncated, ...(byChars ? { truncatedBy: "chars" as const } : {}) };
}

/**
 * Every frame of the page with one answer each, listed as the structured read lists them.
 *
 * The shape `find` needs: it builds no tree - a match is an element, not a place in a document -
 * but it needs the same labels, the same order and the same one-deadline wait, so that a ref found
 * in a frame is named the way `read_page` would have named it.
 */
export type FrameAnswer<T> = NonNullable<AgentReadPageResult["frames"]>[number] & { answer?: T };

export async function askPageFrames<T>(
  tabId: number,
  deps: {
    enumerateFrames: FrameEnumerator;
    ask: (input: { tabId: number; frameId: number }) => Promise<T>;
    boundMs?: number;
  },
): Promise<FrameAnswer<T>[]> {
  const { inOrder } = await askEveryFrame(
    tabId,
    await deps.enumerateFrames(tabId),
    deps.ask,
    deps.boundMs ?? FRAME_ANSWER_BOUND_MS,
  );
  return listFrames(inOrder).map((frame, index) => {
    const answer = inOrder[index]?.answer;
    return { ...frame, ...(answer === undefined ? {} : { answer }) };
  });
}

/**
 * Where a frame's own (0, 0) is on the page (004/T125, T125a, US4, R-114, FR-064).
 *
 * Input is delivered to the tab in **top-level viewport** coordinates, and a frame's runtime
 * reports its elements in **its own** viewport. Nothing in the browser reconciles the two, and the
 * mismatch is silent - the click is delivered, it simply lands somewhere else - so the worker
 * measures the difference and adds it before an effect is addressed. That is also why an effect on
 * a reference carries no frame id (G5): the frame is already in the coordinates.
 *
 * The measurement is the debugger's, not the page's: a cross-origin child cannot be asked where
 * its own `<iframe>` sits, and matching iframes by url is exactly wrong on the frames that have no
 * distinguishing url (`srcdoc`, `about:blank`). `DOM.getFrameOwner` names the element that holds a
 * frame and `DOM.getBoxModel` gives that element's **content** box - the box the child document's
 * origin is flush with, which is the offset itself, borders and padding already excluded.
 *
 * Three rules keep it honest:
 *
 * - **Measured for the effect that uses it (004/T125a).** The page moves without saying so - a
 *   frame reloads at the url it already had, a banner opens above it and every frame below shifts
 *   - and neither shows up anywhere a caller could key a cache on. So the chain is walked when a
 *   delivery needs it and the answer is not kept past that delivery; the two protocol calls per
 *   hop are a small price beside an effect that already probes, collects, settles and re-probes,
 *   and the thing they buy is that a click never lands where the frame *used to* be.
 * - **Chained, never one hop.** A frame's offset is its owner's box in the parent's viewport plus
 *   the parent's own offset, all the way to the top document. A page whose content is a frame
 *   inside a frame is the case this feature exists for, and one hop is wrong there by exactly the
 *   grandparent's offset.
 * - **Nothing is guessed.** A frame whose owner cannot be measured has no offset, and an effect on
 *   it says it could not locate the target. Treating it as flush with the top document would put a
 *   real click on whatever is painted at those coordinates.
 */
export type FrameOffset = { x: number; y: number };

/** One protocol command over the tab's shared debugger attachment (`AgentInputAttachments.send`). */
export type FrameDebuggerSend = (
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export type FrameOffsets = {
  /**
   * Opens the measurement for **one delivery** on this tab (004/T125a).
   *
   * Everything an effect needs to know about where the page's frames sit is measured through the
   * returned handle, and lives exactly as long as the handle does: a chain is walked once however
   * many refs of that one delivery are inside it, and the next delivery measures again. There is
   * no key that would make an older measurement re-usable, because there is no fact a caller could
   * key on - a frame reloading at the same url and a parent laid out again without navigating both
   * move the page while everything the enumeration reports stays identical, and a kept offset is
   * then a real click on whatever is painted there now.
   */
  forDelivery(tabId: number): FrameOffsetMeasurement;
};

export type FrameOffsetMeasurement = {
  /**
   * The offset for `frameId` in the enumeration the caller just made, or `undefined` when any hop
   * of its owner chain could not be measured.
   *
   * The enumeration is passed in rather than fetched because it is what the caller already has,
   * and it is what names the chain: the frame's parent, its parent's parent, up to the top.
   */
  offsetFor(frames: BrowserFrame[], frameId: number): Promise<FrameOffset | undefined>;
};

/** What `Page.getFrameTree` answers, in the shape this module reads it. */
type CdpFrameNode = {
  frame?: { id?: unknown; url?: unknown };
  childFrames?: CdpFrameNode[];
};

/** What one delivery has measured so far: re-used inside it, and gone when it ends. */
type DeliveryState = {
  /** Numeric frame id (the scripting API's) to the debugger's frame token, asked for once. */
  tokens: Map<number, string> | undefined;
  domEnabled: boolean;
  /** Frame id to its accumulated offset from the top document. */
  measured: Map<number, FrameOffset>;
};

/**
 * Pairs the enumeration's numeric frame ids with the debugger's frame tokens.
 *
 * The two describe the same tree, and siblings are paired **in order** for the same reason the
 * structural merge pairs owners in order: a url is not a key - `srcdoc` and `about:blank` frames
 * share theirs - and a mis-key here would offset an element by another frame's box.
 */
function pairFrameTokens(frames: BrowserFrame[], root: CdpFrameNode): Map<number, string> {
  const tokens = new Map<number, string>();
  const top = frames.find((frame) => frame.parentFrameId < 0) ?? frames[0];
  if (!top) return tokens;
  const childrenOf = (frameId: number): BrowserFrame[] =>
    frames.filter((frame) => frame.parentFrameId === frameId && frame.frameId !== frameId);
  const visit = (frameId: number, node: CdpFrameNode): void => {
    const token = node.frame?.id;
    if (typeof token !== "string") return;
    tokens.set(frameId, token);
    const enumerated = childrenOf(frameId);
    const reported = node.childFrames ?? [];
    for (let index = 0; index < enumerated.length && index < reported.length; index += 1) {
      const child = enumerated[index];
      const reportedChild = reported[index];
      if (child && reportedChild) visit(child.frameId, reportedChild);
    }
  };
  visit(top.frameId, root);
  return tokens;
}

/** The content quad's top-left corner: where the child document's own (0, 0) is in its parent. */
function contentOrigin(model: unknown): FrameOffset | undefined {
  const quad = (model as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(quad) || quad.length < 2) return undefined;
  const [x, y] = quad as unknown[];
  return typeof x === "number" && typeof y === "number" ? { x, y } : undefined;
}

/** One page's worth of in-page-measured offsets, keyed by the native frame id (004/T128, B67). */
export type InPageFrameOffsetMeasurer = (tabId: number) => Promise<Map<number, FrameOffset>>;

/**
 * Prefers a same-origin chain's own in-page measurement over the debugger's frame-token chain, and
 * falls back to the debugger only for a frame the in-page walk could not reach the top from (004/
 * T128, B67 - see `frameOffsetToTop`/`enumerateFrameOffsets`, `chrome-adapters/scripting.ts`).
 *
 * The debugger's chain pairs the enumeration's frame ids with `Page.getFrameTree`'s tokens **by
 * order**, which two structurally parallel branches - `frames.html`'s two same-shaped child
 * sections - can mis-key ("would offset an element by another frame's box", `pairFrameTokens`'s own
 * warning). A same-origin frame does not need that pairing at all: it can read its own place on the
 * page directly, in one round trip covering every frame of the tab. Only a cross-origin hop still
 * needs the debugger, because `window.frameElement` is exactly the property the same-origin policy
 * hides across that boundary - which is also why the in-page walk can *tell* it has hit one
 * (`complete: false`) rather than silently answering something wrong.
 */
export function createHybridFrameOffsets(deps: {
  measureInPage: InPageFrameOffsetMeasurer;
  cdp: FrameOffsets;
}): FrameOffsets {
  return {
    forDelivery(tabId) {
      // Both measurements share this delivery's lifetime, exactly as the plain CDP chain's memo
      // does: one in-page round trip and one CDP chain, however many refs this delivery locates.
      let inPage: Promise<Map<number, FrameOffset>> | undefined;
      let cdpMeasurement: FrameOffsetMeasurement | undefined;
      return {
        async offsetFor(frames, frameId) {
          inPage ??= deps.measureInPage(tabId).catch(() => new Map<number, FrameOffset>());
          const measured = (await inPage).get(frameId);
          if (measured) return measured;
          cdpMeasurement ??= deps.cdp.forDelivery(tabId);
          return cdpMeasurement.offsetFor(frames, frameId);
        },
      };
    },
  };
}

export function createFrameOffsets(deps: { send: FrameDebuggerSend }): FrameOffsets {
  async function tokensFor(
    tabId: number,
    state: DeliveryState,
    frames: BrowserFrame[],
  ): Promise<Map<number, string>> {
    if (state.tokens) return state.tokens;
    const answer = await deps.send(tabId, "Page.getFrameTree");
    const root = (answer as { frameTree?: CdpFrameNode }).frameTree;
    const tokens = root ? pairFrameTokens(frames, root) : new Map<number, string>();
    state.tokens = tokens;
    return tokens;
  }

  /**
   * The owner's content box, in the parent's viewport.
   *
   * `DOM.enable` is sent once per delivery because the DOM agent answers nothing before it. It is
   * not one of the diagnostics domains and is not treated as one: nothing here subscribes to an
   * event or reads a value out of the page - two geometry queries go out and two boxes come back
   * (the invariant `input.ts` states).
   */
  async function ownerOrigin(
    tabId: number,
    state: DeliveryState,
    token: string,
  ): Promise<FrameOffset | undefined> {
    if (!state.domEnabled) {
      await deps.send(tabId, "DOM.enable");
      state.domEnabled = true;
    }
    const owner = await deps.send(tabId, "DOM.getFrameOwner", { frameId: token });
    const backendNodeId = (owner as { backendNodeId?: unknown }).backendNodeId;
    if (typeof backendNodeId !== "number") return undefined;
    const box = await deps.send(tabId, "DOM.getBoxModel", { backendNodeId });
    return contentOrigin((box as { model?: unknown }).model);
  }

  return {
    forDelivery(tabId) {
      // The memo, and the whole of this measurement's memory: it is created with the delivery and
      // there is no reference to it anywhere else, so it ends when the delivery does.
      const state: DeliveryState = { tokens: undefined, domEnabled: false, measured: new Map() };
      return {
        async offsetFor(frames, frameId) {
          const byId = new Map(frames.map((frame) => [frame.frameId, frame]));
          /** The chain from the top document down to the asked-for frame; the top is not in it. */
          const chain: BrowserFrame[] = [];
          let current = byId.get(frameId);
          while (current && current.parentFrameId >= 0 && chain.length <= 64) {
            chain.unshift(current);
            const parent = byId.get(current.parentFrameId);
            if (!parent || parent.frameId === current.frameId) {
              // 004/T153 (S4 review): the parent this frame claims could not be found, or names
              // itself - it was never enumerated (`scripting.ts`'s honest-unknown marker for a
              // frame whose own parent could not be scripted) rather than genuinely absent. The
              // chain above `current` is unknown, not "the top document" - frames.ts:473-475's
              // rule ("nothing is guessed") applies exactly here: a chain this walk cannot finish
              // is not this frame's offset with the missing hops assumed to be zero.
              return undefined;
            }
            current = parent;
          }
          // The top document, or a frame the enumeration does not place under one: nothing to add.
          if (chain.length === 0) return { x: 0, y: 0 };

          let offset: FrameOffset = { x: 0, y: 0 };
          for (const frame of chain) {
            const memo = state.measured.get(frame.frameId);
            if (memo) {
              offset = memo;
              continue;
            }
            let origin: FrameOffset | undefined;
            try {
              const tokens = await tokensFor(tabId, state, frames);
              const token = tokens.get(frame.frameId);
              origin = token === undefined ? undefined : await ownerOrigin(tabId, state, token);
            } catch {
              // The debugger could not answer for this frame. There is no second measurement to
              // fall back to, and a frame with no offset has no coordinates rather than the top's.
              origin = undefined;
            }
            if (!origin) return undefined;
            offset = { x: offset.x + origin.x, y: offset.y + origin.y };
            state.measured.set(frame.frameId, offset);
          }
          return offset;
        },
      };
    },
  };
}
