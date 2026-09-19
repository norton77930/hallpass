import { INDICATOR_MARKER_ATTRIBUTE } from "./indicator-marker.js";

/**
 * The phantom cursor (004/T127, FR-064, R-119).
 *
 * Browser-level input leaves no pointer on the screen: the page reacts exactly as it would under a
 * person's hand, and the owner watching the tab sees things happen with nothing moving. This is the
 * mark that answers "where is the agent pointing" at a glance. It appears with the first gesture on
 * a held tab, glides from one target to the next between gestures (a short eased transform
 * transition the browser interpolates - no animation loop of ours), and stays on the page for as
 * long as the tab is the agent's. It leaves when the tab does: the indicator's `show: false` is that
 * moment and the entry takes the pointer down with the banner, and a navigation takes it with the
 * document like everything else drawn there. The worker sends the moves (T121); it never has to send
 * a "hide" for the ordinary case, though the message still accepts one.
 *
 * The glide is why the worker waits. A press dispatched the instant the move was sent would land
 * while the pointer was still on its way, and the owner would watch the page react *before* the
 * arrow got there - the one thing that makes a drawn pointer read as a pointer is that the click
 * happens where it just stopped. So each move is answered when the transition ends (or a timer
 * says it must have), and the worker holds the `mouseMoved` until then, capped so a page that never
 * answers cannot hold a click. It never waits before a press or a release: those follow a move that
 * already arrived.
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

/** What the worker sends before each pointer gesture (`input.ts`); `hide` is kept for the protocol. */
export type CursorMessage = { type: "cursor"; x?: number; y?: number; hide?: true };

export type CursorHost = {
  doc: Document;
  /** Whether this document is the top one; only it draws. The entry asks the browser, not the page. */
  isTopFrame: boolean;
};

/** The arrow's box, in pixels; its tip is the box's top-left corner, which is the hot spot. */
const CURSOR_WIDTH = 18;
const CURSOR_HEIGHT = 24;

/** How long the glide takes, and the curve: fast out of the old spot, settling into the new one. */
const GLIDE_MS = 200;
const GLIDE_TRANSITION = `transform ${GLIDE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;

/** The arrival fallback: the glide plus slack, for a page whose `transitionend` never comes. */
const ARRIVAL_FALLBACK_MS = 240;

const CURSOR_FILL = "rgba(255, 59, 48, 0.9)";
const CURSOR_GLOW = "drop-shadow(0 0 6px rgba(255, 59, 48, 0.7)) drop-shadow(0 2px 3px rgba(0, 0, 0, 0.45))";

/** A classic tilted arrow with its tip at (0, 0); the box below is what the path fits in. */
const ARROW_PATH = "M0 0 L0 18 L4.8 13.6 L8 21 L11.4 19.5 L8.2 12.2 L14.6 12.2 Z";

/** Accepts only the exact shape above; a page posting anything else is not answered. */
export function isCursorMessage(message: unknown): message is CursorMessage {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<CursorMessage>;
  if (candidate.type !== "cursor") return false;
  if (candidate.hide === true) return true;
  return typeof candidate.x === "number" && typeof candidate.y === "number";
}

function findCursor(doc: Document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(`[${CURSOR_MARKER_ATTRIBUTE}]`);
}

export function removeCursor(doc: Document): void {
  findCursor(doc)?.remove();
}

function placement(x: number, y: number): string {
  return `translate3d(${x}px, ${y}px, 0)`;
}

/**
 * Where each mark was last sent, as this module wrote it. Compared instead of `style.transform`
 * because the browser serialises that back in its own spelling (`0` becomes `0px`), and a
 * comparison that never matched would make every repeat at the same point wait the fallback out.
 */
const placed = new WeakMap<HTMLElement, string>();

function createArrow(doc: Document): HTMLElement {
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
    filter: CURSOR_GLOW,
    zIndex: "2147483647",
    // The press for this very point is next: nothing here may be what receives it.
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
  element.appendChild(svg);
  return element;
}

/**
 * Resolves when the glide to the current transform has ended - the transition's own word, or the
 * fallback timer when the page never gives it. Never rejects: arrival is a courtesy to the owner's
 * eye, and nothing about the input may depend on it.
 */
function arrival(element: HTMLElement): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      element.removeEventListener("transitionend", onEnd);
      resolve();
    };
    const onEnd = (event: Event): void => {
      if ((event as TransitionEvent).propertyName === "transform") done();
    };
    element.addEventListener("transitionend", onEnd);
    timer = setTimeout(done, ARRIVAL_FALLBACK_MS);
  });
}

/**
 * Applies one `cursor` message and says when the pointer will have arrived: a promise for any
 * message this module owns, `undefined` for anything else - so the entry can tell "handled" from
 * "not mine" and knows to keep the reply channel open in the same call.
 *
 * The promise is already settled when there was nothing to watch: the document is hidden (no glide
 * anyone could see), the mark was just created (placed, never glided in from the corner), or the
 * target is where the pointer already is.
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
  const target = placement(message.x, message.y);
  const existing = findCursor(doc);
  if (!existing) {
    const element = createArrow(doc);
    // Placed, not glided: with no transition yet, the first transform is where it appears. The
    // reflow between the two commits that position before the transition can apply to it.
    element.style.transition = "none";
    element.style.transform = target;
    placed.set(element, target);
    doc.body.appendChild(element);
    void element.getBoundingClientRect();
    element.style.transition = GLIDE_TRANSITION;
    return Promise.resolve();
  }
  if (placed.get(existing) === target) return Promise.resolve();
  const pending = doc.hidden === true ? Promise.resolve() : arrival(existing);
  existing.style.transform = target;
  placed.set(existing, target);
  return pending;
}

/**
 * Applies one `cursor` message. Returns whether the message was one this module owns, so the entry
 * can tell "handled" from "not mine" without inspecting the shape a second time.
 */
export function applyCursor(message: unknown, host: CursorHost): boolean {
  return moveCursor(message, host) !== undefined;
}
