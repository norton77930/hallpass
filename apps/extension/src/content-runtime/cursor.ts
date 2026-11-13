import { placeCaption } from "./caption-placement.js";
import { placementTransform, planTravel, type TravelPoint } from "./cursor-motion.js";
import { INDICATOR_MARKER_ATTRIBUTE } from "./indicator-marker.js";
import { adoptMark } from "./marks.js";

/**
 * The phantom cursor (004/T127, FR-064, R-119), and what it says (033, FR-499..FR-511).
 *
 * Browser-level input leaves no pointer on the screen: the page reacts exactly as it would under a
 * person's hand, and the owner watching the tab sees things happen with nothing moving. This is the
 * mark that answers "where is the agent pointing" at a glance, and - since 033 - "what is it doing".
 * It appears with the first gesture on a held tab (or with the first captioned step, at the rest
 * spot), travels from one target to the next along a short planned path (`cursor-motion.ts`, played
 * with the Web Animations API - no animation loop of ours), and stays on the page for as long as the
 * tab is the agent's. It leaves when the tab does: the indicator's `show: false` is that moment and
 * the entry takes the pointer down with the banner, and a navigation takes it with the document like
 * everything else drawn there. The worker sends the moves (T121) and the steps (033/R-491); it never
 * has to send a "hide" for the ordinary case, though the message still accepts one.
 *
 * The travel is why the worker waits. A press dispatched the instant the move was sent would land
 * while the pointer was still on its way, and the owner would watch the page react *before* the
 * arrow got there - the one thing that makes a drawn pointer read as a pointer is that the click
 * happens where it just stopped. So each move is answered when the animation ends (or a timer says
 * it must have), and the worker holds the `mouseMoved` until then, capped so a page that never
 * answers cannot hold a click. It never waits before a press or a release: those follow a move that
 * already arrived. The press ring (R-498) is the page's own reaction to that same arrival.
 *
 * The words (R-494). The pointer and the pill are plain light DOM, so a text node in them could be
 * found by the page's own text search, selected, or read back. The caption is therefore an *empty*
 * element whose words sit in an attribute and are drawn by one marked stylesheet rule
 * (`::before { content: attr(...) }`): generated content is not part of the document's text, and the
 * element wears the indicator's marker and `aria-hidden`, so the collectors skip it like the arrow.
 * The words are chosen and translated by the worker (FR-510); this module only draws what it is
 * given, in exactly one message shape, and never as markup.
 *
 * It is a marker, not a piece of interface, and every decision here follows from that:
 *
 * - **`pointer-events: none`.** The effect the mark is drawn for is delivered to those very
 *   coordinates a moment later. An element there that could take the press would make the marker
 *   the thing the agent clicked, which would be this extension standing in front of the page.
 * - **The top document only.** Coordinates are the top-level viewport's (R-113/R-114), so one page
 *   gets one mark; a copy in each frame would be several marks with all but one in the wrong place.
 *   Child frames still *receive* nothing - the worker addresses frame 0 - and this is the second
 *   guard for the case where they do.
 * - **The indicator's own marker attribute**, so the single exclusion the collector already has
 *   (`withinIndicator`, and the visible-text pass) covers the cursor too. A second mechanism would
 *   be a second thing to keep in step, and the failure it would allow - an agent reading its own
 *   pointer back out of `read_page` - is the same one either mechanism exists to prevent.
 */

/** How this element is found again to be moved or removed; the exclusion is the indicator's. */
export const CURSOR_MARKER_ATTRIBUTE = "data-hallpass-cursor";

/** The caption: an empty element; its words are this attribute, drawn by the stylesheet. */
const WORDS_ATTRIBUTE = "data-hallpass-words";
/** The element inside the pointer that is tilted, and only it. */
const ARROW_ATTRIBUTE = "data-hallpass-cursor-arrow";
const RING_ATTRIBUTE = "data-hallpass-ring";
const STYLE_ATTRIBUTE = "data-hallpass-cursor-style";

/** What the worker sends before each pointer gesture (`input.ts`); `hide` is kept for the protocol. */
export type CursorMessage = { type: "cursor"; x?: number; y?: number; hide?: true; press?: true };

/** What the worker sends when a tool call starts (033/R-491): the words and what the pointer does. */
export type PointerStepMode = "travel" | "stay" | "rest";
export type PointerStepMessage = { type: "pointer-step"; words: string; mode: PointerStepMode };

export type CursorHost = {
  doc: Document;
  /** Whether this document is the top one; only it draws. The entry asks the browser, not the page. */
  isTopFrame: boolean;
};

/** The arrow's box, in pixels; its tip is the box's top-left corner, which is the hot spot. */
const CURSOR_WIDTH = 18;
const CURSOR_HEIGHT = 24;

/** The arrival fallback: the planned duration plus this slack, for a page whose animation never ends. */
const ARRIVAL_SLACK_MS = 60;

/** The rest spot: this far in from the left and from the bottom (FR-502). */
const REST_MARGIN_PX = 16;

/** The caption fades this long after the pointer arrives at a pointing position (FR-501). */
const FADE_DELAY_MS = 1000;

/** Longest caption the page takes (FR-499's parameters are cut before this). */
const MAX_WORDS = 60;

/** The ring is taken away when `animationend` has not come by then (R-498). */
const RING_LIFETIME_MS = 700;

const CURSOR_FILL = "rgba(255, 59, 48, 0.9)";
const CURSOR_GLOW = "drop-shadow(0 0 6px rgba(255, 59, 48, 0.7)) drop-shadow(0 2px 3px rgba(0, 0, 0, 0.45))";

/** A classic tilted arrow with its tip at (0, 0); the box below is what the path fits in. */
const ARROW_PATH = "M0 0 L0 18 L4.8 13.6 L8 21 L11.4 19.5 L8.2 12.2 L14.6 12.2 Z";

/**
 * The only stylesheet: the caption's look and the generated content that is its words, and the
 * press ring. It is Hallpass's own, `all: initial` first so the page's rules for `div` do not
 * reach it, and it wears the marker so no collection reads it.
 */
const STYLESHEET = `
[${WORDS_ATTRIBUTE}] {
  all: initial;
  position: absolute;
  display: block;
  box-sizing: border-box;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 4px 10px;
  border-radius: 12px;
  background: rgba(24, 24, 27, 0.92);
  color: #ffffff;
  font: 600 12px/16px system-ui, -apple-system, "Segoe UI", sans-serif;
  letter-spacing: 0;
  direction: ltr;
  unicode-bidi: isolate;
  pointer-events: none;
  user-select: none;
  opacity: 1;
  transition: opacity 200ms ease;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
}
[${WORDS_ATTRIBUTE}]::before { content: attr(${WORDS_ATTRIBUTE}); }
[${WORDS_ATTRIBUTE}][${WORDS_ATTRIBUTE}=""] { display: none; }
[${WORDS_ATTRIBUTE}][data-faded] { opacity: 0; }
[${WORDS_ATTRIBUTE}][data-corner="top-left"] { border-top-left-radius: 3px; }
[${WORDS_ATTRIBUTE}][data-corner="top-right"] { border-top-right-radius: 3px; }
[${WORDS_ATTRIBUTE}][data-corner="bottom-left"] { border-bottom-left-radius: 3px; }
[${WORDS_ATTRIBUTE}][data-corner="bottom-right"] { border-bottom-right-radius: 3px; }
[${RING_ATTRIBUTE}] {
  all: initial;
  position: fixed;
  display: block;
  box-sizing: border-box;
  width: 6px;
  height: 6px;
  margin: -3px 0 0 -3px;
  border-radius: 50%;
  border: 2px solid rgba(255, 59, 48, 0.9);
  pointer-events: none;
  z-index: 2147483647;
  animation: hallpass-ring 520ms ease-out forwards;
}
[${RING_ATTRIBUTE}][data-reduced] { animation: hallpass-ring-fade 250ms ease-out forwards; }
@keyframes hallpass-ring { from { transform: scale(1); opacity: 0.9; } to { transform: scale(5.667); opacity: 0; } }
@keyframes hallpass-ring-fade { from { opacity: 0.9; } to { opacity: 0; } }
`;

/** True for a plain object with exactly these keys present (and no others). */
function hasOnlyKeys(candidate: object, allowed: readonly string[]): boolean {
  return Object.keys(candidate).every((key) => allowed.includes(key));
}

/** Accepts only the exact shapes of the contract; a page posting anything else is not answered. */
export function isCursorMessage(message: unknown): message is CursorMessage {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const candidate = message as Record<string, unknown>;
  if (candidate["type"] !== "cursor") return false;
  if (!hasOnlyKeys(candidate, ["type", "x", "y", "press", "hide"])) return false;
  if ("hide" in candidate) return candidate["hide"] === true && Object.keys(candidate).length === 2;
  if (typeof candidate["x"] !== "number" || !Number.isFinite(candidate["x"])) return false;
  if (typeof candidate["y"] !== "number" || !Number.isFinite(candidate["y"])) return false;
  return !("press" in candidate) || candidate["press"] === true;
}

/** Exactly `{ type, words, mode }`, `words` a string of at most 60 characters, `mode` one of three. */
export function isPointerStep(message: unknown): message is PointerStepMessage {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const candidate = message as Record<string, unknown>;
  if (candidate["type"] !== "pointer-step") return false;
  if (Object.keys(candidate).length !== 3 || !hasOnlyKeys(candidate, ["type", "words", "mode"])) return false;
  const { words, mode } = candidate;
  if (typeof words !== "string" || words.length > MAX_WORDS) return false;
  return mode === "travel" || mode === "stay" || mode === "rest";
}

function findCursor(doc: Document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(`[${CURSOR_MARKER_ATTRIBUTE}]`);
}

/** What the page remembers of one document's pointer. Nothing here survives the pointer's removal. */
type PointerState = {
  /** The pointer element this state belongs to; a state whose element the page removed is reset. */
  element: HTMLElement | null;
  /** The words to show: what is drawn once there is a pointer, what a `travel` step stored before. */
  words: string;
  /** The words as last written to the caption, so a measure happens once per change. */
  shownWords: string;
  /** The tip's target position (where the pointer is, or is going). */
  x: number;
  y: number;
  resting: boolean;
  /** Bumped by every step or move that sends the pointer somewhere; an older arrival does nothing. */
  generation: number;
  /** The animations in flight, and the promise a worker is waiting on. */
  animations: Animation[];
  arrival: Promise<void> | undefined;
  settle: (() => void) | undefined;
  fadeTimer: ReturnType<typeof setTimeout> | undefined;
  /** The caption as measured at its last change of words. */
  captionSize: { width: number; height: number };
  onResize: (() => void) | undefined;
};

const states = new WeakMap<Document, PointerState>();

function freshState(): PointerState {
  return {
    element: null,
    words: "",
    shownWords: "",
    x: 0,
    y: 0,
    resting: false,
    generation: 0,
    animations: [],
    arrival: undefined,
    settle: undefined,
    fadeTimer: undefined,
    captionSize: { width: 0, height: 0 },
    onResize: undefined,
  };
}

/** Drops the timers, listeners and animations tied to the element, keeping nothing of it. */
function releaseElement(doc: Document, state: PointerState): void {
  cancelAnimations(state);
  clearFadeTimer(state);
  if (state.onResize) doc.defaultView?.removeEventListener("resize", state.onResize);
  state.onResize = undefined;
  state.element = null;
  state.shownWords = "";
  state.resting = false;
  state.captionSize = { width: 0, height: 0 };
}

function stateOf(doc: Document): PointerState {
  let state = states.get(doc);
  if (!state) {
    state = freshState();
    states.set(doc, state);
  }
  // The page took the pointer out of its own document (or it was never drawn): what was bound to
  // that element is bound to nothing.
  if (state.element && findCursor(doc) !== state.element) releaseElement(doc, state);
  return state;
}

export function removeCursor(doc: Document): void {
  const state = stateOf(doc);
  findCursor(doc)?.remove();
  for (const ring of doc.querySelectorAll(`[${RING_ATTRIBUTE}]`)) ring.remove();
  doc.querySelector(`style[${STYLE_ATTRIBUTE}]`)?.remove();
  releaseElement(doc, state);
  state.words = "";
}

function viewportOf(doc: Document): { width: number; height: number } {
  const view = doc.defaultView;
  return {
    width: view?.innerWidth ?? doc.documentElement.clientWidth,
    height: view?.innerHeight ?? doc.documentElement.clientHeight,
  };
}

/** Near the bottom-left corner, clear of both edges by at least 16 px (FR-502). */
function restSpot(doc: Document): TravelPoint {
  return { x: REST_MARGIN_PX, y: viewportOf(doc).height - REST_MARGIN_PX - CURSOR_HEIGHT };
}

function prefersReducedMotion(doc: Document): boolean {
  try {
    return doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  } catch {
    return false;
  }
}

function ensureStyle(doc: Document): void {
  if (doc.querySelector(`style[${STYLE_ATTRIBUTE}]`)) return;
  const style = doc.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "");
  style.setAttribute(INDICATOR_MARKER_ATTRIBUTE, "");
  style.textContent = STYLESHEET;
  (doc.head ?? doc.documentElement).appendChild(style);
}

function createPointer(doc: Document): HTMLElement {
  const element = doc.createElement("div");
  element.setAttribute(CURSOR_MARKER_ATTRIBUTE, "");
  // The one attribute that keeps the extension's own furniture out of every collection and out
  // of the visible text; the collector reads it and walks past everything wearing it.
  element.setAttribute(INDICATOR_MARKER_ATTRIBUTE, "");
  element.setAttribute("aria-hidden", "true");
  Object.assign(element.style, {
    // Fixed at the origin and moved by transform alone, so the tip is exactly the (x, y) the input
    // is addressed to - no margins to keep in step with the drawing - and the browser can animate
    // the move without laying anything out.
    position: "fixed",
    left: "0px",
    top: "0px",
    width: `${CURSOR_WIDTH}px`,
    height: `${CURSOR_HEIGHT}px`,
    willChange: "transform",
    zIndex: "2147483647",
    // The press for this very point is next: nothing here may be what receives it.
    pointerEvents: "none",
  });

  // The arrow has its own box so that it, and not the caption, is what leans into the motion.
  const arrow = doc.createElement("div");
  arrow.setAttribute(ARROW_ATTRIBUTE, "");
  Object.assign(arrow.style, {
    width: `${CURSOR_WIDTH}px`,
    height: `${CURSOR_HEIGHT}px`,
    // The tip is the hot spot, so the arrow turns about it.
    transformOrigin: "0 0",
    filter: CURSOR_GLOW,
    pointerEvents: "none",
  });
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${CURSOR_WIDTH} ${CURSOR_HEIGHT}`);
  svg.setAttribute("width", String(CURSOR_WIDTH));
  svg.setAttribute("height", String(CURSOR_HEIGHT));
  svg.setAttribute("aria-hidden", "true");
  // The white edge is drawn outside the box at the tip; `overflow: visible` keeps it from clipping.
  Object.assign(svg.style, { display: "block", overflow: "visible", pointerEvents: "none" });
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ARROW_PATH);
  path.setAttribute("fill", CURSOR_FILL);
  path.setAttribute("stroke", "#ffffff");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  arrow.appendChild(svg);
  element.appendChild(arrow);

  // Empty on purpose: the words are an attribute, drawn by the stylesheet (R-494).
  const label = doc.createElement("div");
  label.setAttribute(WORDS_ATTRIBUTE, "");
  label.setAttribute(INDICATOR_MARKER_ATTRIBUTE, "");
  label.setAttribute("aria-hidden", "true");
  element.appendChild(label);
  // A pointer drawn while a capture has the marks hidden is hidden at birth (033/R-499).
  adoptMark(doc, element);
  adoptMark(doc, label);
  return element;
}

function captionOf(state: PointerState): HTMLElement | null {
  return state.element?.querySelector<HTMLElement>(`[${WORDS_ATTRIBUTE}]`) ?? null;
}

/** Writes the stored words into the caption and measures it - once per change of words. */
function showWords(doc: Document, state: PointerState): void {
  const label = captionOf(state);
  if (!label) return;
  if (state.words === state.shownWords) return;
  state.shownWords = state.words;
  label.setAttribute(WORDS_ATTRIBUTE, state.words);
  measureCaption(doc, state);
}

function measureCaption(doc: Document, state: PointerState): void {
  const label = captionOf(state);
  if (!label) return;
  label.style.maxWidth = `${Math.max(0, viewportOf(doc).width - 16)}px`;
  state.captionSize =
    state.shownWords === "" ? { width: 0, height: 0 } : { width: label.offsetWidth, height: label.offsetHeight };
}

/** Puts the caption where `placeCaption` says, for the pointer's target and whether it rests. */
function placeLabel(doc: Document, state: PointerState): void {
  const label = captionOf(state);
  if (!label) return;
  const placement = placeCaption({
    viewport: viewportOf(doc),
    point: { x: state.x, y: state.y },
    caption: state.captionSize,
    atRest: state.resting,
  });
  label.style.left = `${placement.offset.x}px`;
  label.style.top = `${placement.offset.y}px`;
  label.style.maxWidth = `${placement.maxWidth}px`;
  label.setAttribute("data-side", placement.side);
  label.setAttribute("data-corner", placement.corner);
}

function clearFadeTimer(state: PointerState): void {
  if (state.fadeTimer !== undefined) clearTimeout(state.fadeTimer);
  state.fadeTimer = undefined;
}

/** A new step or move shows its caption at full strength. */
function clearFade(state: PointerState): void {
  clearFadeTimer(state);
  captionOf(state)?.removeAttribute("data-faded");
}

/** The caption fades a second from now - unless the pointer is resting, where it stays (FR-501). */
function scheduleFade(state: PointerState): void {
  clearFadeTimer(state);
  if (state.resting || !state.element) return;
  state.fadeTimer = setTimeout(() => {
    state.fadeTimer = undefined;
    captionOf(state)?.setAttribute("data-faded", "");
  }, FADE_DELAY_MS);
}

function cancelAnimations(state: PointerState): void {
  for (const animation of state.animations) {
    try {
      animation.cancel();
    } catch {
      /* already over */
    }
  }
  state.animations = [];
  // Nobody keeps waiting on a move that was replaced; the replacing move has its own arrival.
  state.settle?.();
}

/** `matrix(a, b, c, d, e, f)`, `matrix3d(...)` or `translate3d(x, y, z)` to the tip it places. */
function parseTip(transform: string | undefined): TravelPoint | undefined {
  if (!transform) return undefined;
  const numbers = (text: string): number[] => text.split(",").map((part) => Number.parseFloat(part));
  const matrix3d = /^matrix3d\(([^)]*)\)$/u.exec(transform.trim());
  if (matrix3d) {
    const values = numbers(matrix3d[1] ?? "");
    const [x, y] = [values[12], values[13]];
    return x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
  }
  const matrix = /^matrix\(([^)]*)\)$/u.exec(transform.trim());
  if (matrix) {
    const values = numbers(matrix[1] ?? "");
    const [x, y] = [values[4], values[5]];
    return x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
  }
  const translate = /^translate3d\(([^)]*)\)$/u.exec(transform.trim());
  if (translate) {
    const values = numbers(translate[1] ?? "");
    const [x, y] = [values[0], values[1]];
    return x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
  }
  return undefined;
}

/** Where the tip is right now: the animated position when one is running, else where it was sent. */
function currentTip(doc: Document, state: PointerState, element: HTMLElement): TravelPoint {
  if (state.arrival !== undefined) {
    try {
      const computed = parseTip(doc.defaultView?.getComputedStyle(element).transform);
      if (computed) return computed;
    } catch {
      /* fall back to the last target */
    }
  }
  return { x: state.x, y: state.y };
}

/**
 * Sends the pointer to `to` and says when it will have arrived: `undefined` when there is nothing
 * to watch (the document is hidden, the browser cannot animate, the distance is under a pixel, the
 * owner asked for reduced motion, or it is already there), a promise otherwise. The final transform
 * is written first, so whatever the animation does or fails to do, the pointer ends on the target.
 */
function travelTo(doc: Document, state: PointerState, element: HTMLElement, to: TravelPoint): Promise<void> | undefined {
  if (state.x === to.x && state.y === to.y) return state.arrival;
  const from = currentTip(doc, state, element);
  cancelAnimations(state);
  element.style.transform = placementTransform(to.x, to.y);
  state.x = to.x;
  state.y = to.y;
  if (doc.hidden === true || typeof element.animate !== "function") return undefined;
  const plan = planTravel(from, to, prefersReducedMotion(doc));
  if (plan.durationMs <= 0) return undefined;

  const animations: Animation[] = [
    element.animate(
      plan.frames.map((frame) => ({ transform: frame.transform, offset: frame.offset })),
      plan.durationMs,
    ),
  ];
  const arrow = element.querySelector<HTMLElement>(`[${ARROW_ATTRIBUTE}]`);
  if (arrow && typeof arrow.animate === "function") {
    animations.push(
      arrow.animate(
        plan.frames.map((frame) => ({ transform: `rotate(${frame.tiltDeg}deg)`, offset: frame.offset })),
        plan.durationMs,
      ),
    );
  }
  state.animations = animations;

  const arrival = new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      animations[0]?.removeEventListener("finish", done);
      animations[0]?.removeEventListener("cancel", done);
      if (state.settle === done) state.settle = undefined;
      if (state.arrival === arrival) state.arrival = undefined;
      resolve();
    };
    animations[0]?.addEventListener("finish", done);
    animations[0]?.addEventListener("cancel", done);
    timer = setTimeout(done, plan.durationMs + ARRIVAL_SLACK_MS);
    state.settle = done;
  });
  state.arrival = arrival;
  return arrival;
}

/** Places the pointer without travel, wherever it is now. */
function jumpTo(state: PointerState, element: HTMLElement, to: TravelPoint): void {
  cancelAnimations(state);
  element.style.transform = placementTransform(to.x, to.y);
  state.x = to.x;
  state.y = to.y;
}

/** Draws a new pointer at `at`, placed and not travelled in from a corner. */
function drawPointer(doc: Document, state: PointerState, at: TravelPoint, resting: boolean): HTMLElement | undefined {
  if (!doc.body) return undefined;
  ensureStyle(doc);
  const element = createPointer(doc);
  element.style.transform = placementTransform(at.x, at.y);
  doc.body.appendChild(element);
  state.element = element;
  state.x = at.x;
  state.y = at.y;
  state.resting = resting;
  state.shownWords = "";
  showWords(doc, state);
  placeLabel(doc, state);
  const view = doc.defaultView;
  if (view) {
    state.onResize = (): void => onResize(doc, state);
    view.addEventListener("resize", state.onResize);
  }
  return element;
}

/** A resize moves the rest spot, and the caption's room; a pointer pointing at something stays put. */
function onResize(doc: Document, state: PointerState): void {
  const element = state.element;
  if (!element) return;
  if (state.resting) {
    state.generation += 1;
    jumpTo(state, element, restSpot(doc));
  }
  measureCaption(doc, state);
  placeLabel(doc, state);
}

function addRing(doc: Document, at: TravelPoint): void {
  if (!doc.body) return;
  ensureStyle(doc);
  const ring = doc.createElement("div");
  ring.setAttribute(RING_ATTRIBUTE, "");
  ring.setAttribute(INDICATOR_MARKER_ATTRIBUTE, "");
  ring.setAttribute("aria-hidden", "true");
  if (prefersReducedMotion(doc)) ring.setAttribute("data-reduced", "");
  Object.assign(ring.style, { left: `${at.x}px`, top: `${at.y}px`, pointerEvents: "none" });
  adoptMark(doc, ring);
  const remove = (): void => {
    clearTimeout(timer);
    ring.removeEventListener("animationend", remove);
    ring.remove();
  };
  const timer = setTimeout(remove, RING_LIFETIME_MS);
  ring.addEventListener("animationend", remove);
  doc.body.appendChild(ring);
}

/**
 * Applies one `cursor` message and says when the pointer will have arrived: a promise for any
 * message this module owns, `undefined` for anything else - so the entry can tell "handled" from
 * "not mine" and knows to keep the reply channel open in the same call.
 *
 * The promise is already settled when there was nothing to watch: the document is hidden (no travel
 * anyone could see), the mark was just created (placed, never travelled in from the corner), the
 * target is where the pointer already is, or the browser cannot animate. On arrival the caption's
 * second starts, and a message that asked for a press gets its ring.
 */
export function moveCursor(message: unknown, host: CursorHost): Promise<void> | undefined {
  if (!isCursorMessage(message)) return undefined;
  const { doc } = host;
  // Not this document's mark to draw - and any copy a child frame drew earlier goes now.
  if (!host.isTopFrame) {
    removeCursor(doc);
    return Promise.resolve();
  }
  if (message.hide === true || message.x === undefined || message.y === undefined) {
    removeCursor(doc);
    return Promise.resolve();
  }
  if (!doc.body) return Promise.resolve();

  // Fixed positioning, so these are the same top-level viewport coordinates the input was
  // addressed by - no scroll arithmetic, and nothing for the two to disagree about.
  const target = { x: message.x, y: message.y };
  const state = stateOf(doc);
  state.generation += 1;
  const generation = state.generation;
  state.resting = false;
  clearFade(state);

  let pending: Promise<void> | undefined;
  if (state.element) {
    pending = travelTo(doc, state, state.element, target);
    showWords(doc, state);
    placeLabel(doc, state);
  } else {
    drawPointer(doc, state, target, false);
  }

  const arrive = (): void => {
    // A newer step or move took over; this arrival belongs to a move nobody is watching.
    if (state.generation !== generation || !state.element) return;
    scheduleFade(state);
    if (message.press === true) addRing(doc, target);
  };
  if (pending === undefined) {
    arrive();
    return Promise.resolve();
  }
  return pending.then(arrive);
}

/**
 * Applies one `cursor` message. Returns whether the message was one this module owns, so the entry
 * can tell "handled" from "not mine" without inspecting the shape a second time.
 */
export function applyCursor(message: unknown, host: CursorHost): boolean {
  return moveCursor(message, host) !== undefined;
}

/**
 * Applies one `pointer-step` (033/R-497) and says whether the message was one this module owns.
 * There is no reply: the worker never waits on a step.
 *
 * - `travel`: the words are stored; the pointer moves, and shows them, when the cursor message that
 *   follows arrives. Nothing is drawn or changed now, so a call that fails before it moves leaves the
 *   old caption until the next step.
 * - `stay`: the words change where the pointer is (and start their second); with no pointer yet it is
 *   drawn at the rest spot.
 * - `rest`: the pointer goes to the rest spot with the caption beside it, and the caption stays.
 * - empty words: a `travel` or `stay` step changes nothing; a `rest` step still goes to the rest spot
 *   when there is a pointer, keeping the caption it has.
 */
export function applyPointerStep(message: unknown, host: CursorHost): boolean {
  if (!isPointerStep(message)) return false;
  const { doc } = host;
  // Only the top document draws; a child frame owns the message and does nothing with it.
  if (!host.isTopFrame) return true;
  const state = stateOf(doc);
  const { words, mode } = message;

  if (mode === "travel") {
    if (words !== "") state.words = words;
    return true;
  }
  if (words === "" && mode === "stay") return true;
  if (words !== "") state.words = words;
  if (!doc.body) return true;
  if (words === "" && !state.element && state.words === "") return true;

  if (mode === "stay") {
    if (!state.element) {
      drawPointer(doc, state, restSpot(doc), true);
      return true;
    }
    clearFade(state);
    showWords(doc, state);
    placeLabel(doc, state);
    scheduleFade(state);
    return true;
  }

  // rest
  state.generation += 1;
  clearFade(state);
  const spot = restSpot(doc);
  if (!state.element) {
    drawPointer(doc, state, spot, true);
    return true;
  }
  state.resting = true;
  void travelTo(doc, state, state.element, spot);
  showWords(doc, state);
  placeLabel(doc, state);
  return true;
}
