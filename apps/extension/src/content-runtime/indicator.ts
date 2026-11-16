import { INDICATOR_MARKER_ATTRIBUTE } from "./indicator-marker.js";
import { adoptMark } from "./marks.js";

export { INDICATOR_MARKER_ATTRIBUTE } from "./indicator-marker.js";

/**
 * The in-page indicator (004 FR-062, R-117, data-model "Indicator").
 *
 * Every tab a session holds says on the page itself that an agent is active, and offers one
 * control that brings the session's main tab forward. The worker sends the copy already in the
 * owner's locale; nothing here reads a message table, because a content script running in a page
 * has no business choosing what the owner is told.
 */
export type IndicatorMessage = {
  type: "indicator";
  show: boolean;
  /** What the owner reads: "an agent is working in this tab", already localised by the worker. */
  label?: string;
  /** The control's own copy - "back to the agent's tab". */
  action?: string;
  /**
   * 034 (R-518): what the pill is for. Absent, or a value this build does not know, is "working" - an
   * older worker sends none, and a newer one must not leave the pill unreadable.
   */
  mode?: IndicatorMode;
  /** Stop's own copy; drawn only when present, with mode working or conversation. */
  stop?: string;
  /** Resume's own copy; drawn only with mode held. */
  resume?: string;
  /** What the owner reads while the session is held. */
  heldLabel?: string;
  /** Shown on the pill when a Stop press got no answer. */
  stopUndelivered?: string;
  /** Shown on the pill when a Resume press got no answer. */
  resumeUndelivered?: string;
  /**
   * 035 (R-530): the owner's edge; absent or any other value is the top. A new field of the wrong
   * type is read as absent - the guard stays permissive and the drawing checks the type.
   */
  edge?: PillEdge;
  /** The move control's words while the pill is drawn at the bottom; the control needs both move strings. */
  moveToTop?: string;
  /** The move control's words while the pill is drawn at the top. */
  moveToBottom?: string;
  /** The Open side panel control's words; drawn only when present. */
  openPanel?: string;
  /** Shown on the pill when the open did not succeed. */
  panelUnopened?: string;
};

export type IndicatorMode = "working" | "held" | "conversation";

export type PillEdge = "top" | "bottom";

/**
 * What a press sends: Stop or Resume (034) carry the type and nothing else - the page names no session
 * or tab; the move press (035/R-529) names the edge its control shows and nothing else.
 */
export type PillPress =
  | { type: "ui.agent.pill-stop" }
  | { type: "ui.agent.pill-resume" }
  | { type: "ui.agent.pill-move"; to: PillEdge };
export type PillPressReply = { accepted: boolean };

/** What the Open side panel control sends (035/R-527), and the worker's answer. */
export type PillOpenPress = { type: "ui.agent.pill-open-panel" };
export type PillOpenReply = { opened: boolean };

/** No answer this long after a press: the same press goes once more; twice as long: the owner is told. */
const PILL_RESEND_MS = 1000;
const PILL_UNDELIVERED_MS = 2000;

/** The pill's distance from its edge, and how far its area reaches past its box (035/R-525). */
const PILL_MARGIN_PX = 8;
const PILL_AREA_GROW_PX = 8;

/** A rectangle in top-document viewport pixels; the same shape as the cursor message's `box`. */
export type PillBox = { x: number; y: number; width: number; height: number };
/** What the agent last pointed at: the point, and the target's box when the step had one. */
export type PillPoints = { point: { x: number; y: number }; box?: PillBox };

/** How the pill and the glow are found again; the exclusion they both wear is the marker's. */
export const INDICATOR_PILL_ATTRIBUTE = "data-hallpass-pill";
export const INDICATOR_GLOW_ATTRIBUTE = "data-hallpass-glow";

/**
 * The glow's own numbers: three inset shadows in the pointer's red, breathing between 0.6 and 1
 * over two seconds. The edge of the page is the one place every layout leaves free, which is what
 * makes it readable on any site at a glance - the same reason the reference draws it there.
 */
const GLOW_SHADOW =
  "inset 0 0 15px rgba(255, 59, 48, 0.7), inset 0 0 25px rgba(255, 59, 48, 0.5), inset 0 0 35px rgba(255, 59, 48, 0.2)";
const GLOW_PULSE_MS = 2000;
const GLOW_RESTING_OPACITY = "0.85";

export type IndicatorHost = {
  doc: Document;
  /** Sends the worker one message; the caller decides whether that is a port or `runtime`. */
  send: (message: { type: "ui.agent.focus-main" }) => void;
  /**
   * Sends the worker a press and resolves with its reply; `undefined` is "no reply" (a rejected send
   * included). Absent means this host cannot press, and Stop and Resume do nothing.
   */
  press?: (message: PillPress) => Promise<PillPressReply | undefined>;
  /**
   * Sends the open press once (035/R-527) and resolves with the worker's reply; `undefined` is "no
   * reply" (a rejected send included). Absent means this host cannot open, and the control does nothing.
   */
  openPanel?: () => Promise<PillOpenReply | undefined>;
  /**
   * Whether this document is the top one. The pill is drawn wherever the message lands; the glow
   * is the *page's* edge and is drawn in the top document only - one page, one glow, never one per
   * frame. Absent means top, which is what a host built for a single document is.
   */
  isTopFrame?: boolean;
  /**
   * Whether this click came from the owner rather than from the page (004 FR-062, R-117).
   *
   * The default is the browser's own answer and production never passes anything else. It is a
   * parameter only because `isTrusted` is unforgeable by design - in a browser and in jsdom alike -
   * so the owner's half of the claim can be exercised no other way. Nothing in the extension may
   * pass a predicate that answers `true` for a page's event.
   */
  isTrustedEvent?: (event: Event) => boolean;
};

/** Accepts only the exact shape above; a page posting anything else is not answered. */
export function isIndicatorMessage(message: unknown): message is IndicatorMessage {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Record<string, unknown>;
  if (candidate.type !== "indicator" || typeof candidate.show !== "boolean") return false;
  // The 034 fields are accepted with their types only; an unknown `mode` string is drawn as working.
  for (const key of ["mode", "stop", "resume", "heldLabel", "stopUndelivered", "resumeUndelivered"]) {
    if (candidate[key] !== undefined && typeof candidate[key] !== "string") return false;
  }
  // 035 (R-530): `edge`, `moveToTop`, `moveToBottom`, `openPanel` and `panelUnopened` are not refused
  // for a wrong type - they are read as absent where they are used (`textOf`, `edgeOf`).
  return true;
}

/** A new text field of the wrong type is absent (035/R-530). */
function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function edgeOf(message: IndicatorMessage): PillEdge {
  return (message.edge as unknown) === "bottom" ? "bottom" : "top";
}

function modeOf(message: IndicatorMessage): IndicatorMode {
  return message.mode === "held" || message.mode === "conversation" ? message.mode : "working";
}

/**
 * Whether this message is the one that takes the indicator down - the moment the tab leaves the
 * session, which everything else drawn for that session (the pointer) takes as its own cue.
 */
export function isIndicatorHide(message: unknown): boolean {
  return isIndicatorMessage(message) && message.show === false;
}

export function removeIndicator(doc: Document): void {
  // Both pieces, by their own names: the marker attribute is shared with the pointer, which has
  // its own lifetime and must not go with the banner.
  for (const element of doc.querySelectorAll<HTMLElement>(`[${INDICATOR_PILL_ATTRIBUTE}], [${INDICATOR_GLOW_ATTRIBUTE}]`)) {
    element.remove();
  }
}

/**
 * The glow around the page while an agent holds this tab: a fixed, click-through layer whose
 * inset shadows light the four edges, breathing unless the owner asked for reduced motion.
 */
function drawGlow(doc: Document): void {
  const layer = doc.createElement("div");
  layer.setAttribute(INDICATOR_GLOW_ATTRIBUTE, "");
  layer.setAttribute(INDICATOR_MARKER_ATTRIBUTE, "");
  layer.setAttribute("aria-hidden", "true");
  Object.assign(layer.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483646",
    pointerEvents: "none",
    boxShadow: GLOW_SHADOW,
    opacity: GLOW_RESTING_OPACITY,
  });
  const view = doc.defaultView;
  const stillness = view?.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  if (!stillness && typeof layer.animate === "function") {
    layer.animate([{ opacity: 0.6 }, { opacity: 1 }, { opacity: 0.6 }], {
      duration: GLOW_PULSE_MS,
      iterations: Number.POSITIVE_INFINITY,
      easing: "ease-in-out",
    });
  }
  // Drawn while a capture has the marks hidden: hidden at birth (033/R-499).
  adoptMark(doc, layer);
  doc.body?.appendChild(layer);
}

/**
 * The answer that came before the page had a body, one per document.
 *
 * The agent script runs at `document_start` and announces at once; the worker's answer routinely
 * lands while the parser is still in `<head>`, and a message dropped then was never sent again -
 * a tab that loaded while held showed no indicator at all. So the latest message waits here and is
 * applied the moment a body exists. Latest wins: a second show replaces the first, and a hide
 * clears the wait outright, so nothing is drawn for a tab that has already left the session.
 */
type PendingIndicator = { message: IndicatorMessage; host: IndicatorHost; stop: () => void };
const pendingByDocument = new WeakMap<Document, PendingIndicator>();

function clearPending(doc: Document): void {
  pendingByDocument.get(doc)?.stop();
  pendingByDocument.delete(doc);
}

/**
 * Keeps the latest message for when the body appears. Two cues, whichever comes first: a mutation
 * observer, because the body is parsed well before `DOMContentLoaded` and the owner should see the
 * indicator as soon as the page does; and `DOMContentLoaded` itself, for a document with no
 * observer to offer. One watcher per document - a later message only replaces what it will draw.
 */
function deferUntilBody(message: IndicatorMessage, host: IndicatorHost): void {
  const { doc } = host;
  const waiting = pendingByDocument.get(doc);
  if (waiting) {
    waiting.message = message;
    waiting.host = host;
    return;
  }

  const onReady = (): void => {
    const pending = pendingByDocument.get(doc);
    if (!pending || !doc.body) return;
    clearPending(doc);
    applyIndicator(pending.message, pending.host);
  };
  const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  const observer = Observer ? new Observer(onReady) : undefined;
  observer?.observe(doc, { childList: true, subtree: true });
  doc.addEventListener("DOMContentLoaded", onReady);
  pendingByDocument.set(doc, {
    message,
    host,
    stop: () => {
      observer?.disconnect();
      doc.removeEventListener("DOMContentLoaded", onReady);
    },
  });
}

/** One press at a time per drawn pill; a pill the worker redraws starts clean (a new element, a new entry). */
const pressingByPill = new WeakSet<HTMLElement>();

/**
 * Sends a press and watches for the answer (034/R-517): no reply after a second sends the same press
 * once more, no reply after two shows the not-delivered words on the pill. A rejected send is no
 * reply. Any reply, accepted or not, ends the watch; the worker's next `indicator` message is what
 * redraws the pill. A pill that has left the document (redrawn or taken down) is left alone.
 */
function pressOnPill(host: IndicatorHost, pill: HTMLElement, press: PillPress, undelivered: string | undefined): void {
  if (!host.press || pressingByPill.has(pill)) return;
  pressingByPill.add(pill);
  let answered = false;
  let resend: ReturnType<typeof setTimeout> | undefined;
  let giveUp: ReturnType<typeof setTimeout> | undefined;

  const attempt = (): void => {
    try {
      void host.press?.({ ...press }).then(
        (reply) => {
          if (reply === undefined || answered) return;
          answered = true;
          clearTimeout(resend);
          clearTimeout(giveUp);
          pressingByPill.delete(pill);
        },
        () => {
          /* a rejected send is no reply */
        },
      );
    } catch {
      /* a send that throws is no reply either */
    }
  };

  attempt();
  resend = setTimeout(() => {
    if (!answered && pill.isConnected) attempt();
  }, PILL_RESEND_MS);
  giveUp = setTimeout(() => {
    pressingByPill.delete(pill);
    if (answered || !pill.isConnected || !undelivered) return;
    const note = pill.ownerDocument.createElement("span");
    note.textContent = undelivered;
    pill.appendChild(note);
  }, PILL_UNDELIVERED_MS);
}

/** One open press at a time per drawn pill; a pill the worker redraws starts clean. */
const openingByPill = new WeakSet<HTMLElement>();
const unopenedNoteByPill = new WeakMap<HTMLElement, HTMLElement>();

/**
 * The Open side panel press (035/R-527, R-530): sent once - a resend carries no user gesture - and the
 * owner is told with `unopened` when the reply is `{ opened: false }`, the send was rejected (the host
 * resolves that as no reply) or two seconds pass in silence. The pill's own state is left as it is, and a
 * pill that has left the document is left alone.
 */
function openOnPill(host: IndicatorHost, pill: HTMLElement, unopened: string | undefined): void {
  if (!host.openPanel || openingByPill.has(pill)) return;
  openingByPill.add(pill);
  unopenedNoteByPill.get(pill)?.remove();
  unopenedNoteByPill.delete(pill);
  let settled = false;

  const settle = (opened: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    openingByPill.delete(pill);
    if (opened || !pill.isConnected || !unopened) return;
    const note = pill.ownerDocument.createElement("span");
    note.textContent = unopened;
    pill.appendChild(note);
    unopenedNoteByPill.set(pill, note);
  };
  const timer = setTimeout(() => settle(false), PILL_UNDELIVERED_MS);

  try {
    void host.openPanel().then(
      (reply) => settle(reply?.opened === true),
      () => settle(false),
    );
  } catch {
    settle(false);
  }
}

/**
 * Where the pill sits (035/R-524, R-525, data-model "Pill place"). Pure: the owner's edge, the pill's box
 * (only its x, width and height count - it is mirrored to either edge), the viewport and what the agent
 * last pointed at. The pill's area at an edge is its box there grown by 8 px on every side; the pill
 * steps to the other edge when the points overlap the owner's area and not the other one.
 */
export function placeFor(
  ownerEdge: PillEdge,
  pillBox: Pick<PillBox, "x" | "width" | "height">,
  viewport: { width: number; height: number },
  points: PillPoints | undefined,
): PillEdge {
  if (!points) return ownerEdge;
  const areaAt = (edge: PillEdge): PillBox => {
    const y = edge === "top" ? PILL_MARGIN_PX : viewport.height - PILL_MARGIN_PX - pillBox.height;
    return {
      x: pillBox.x - PILL_AREA_GROW_PX,
      y: y - PILL_AREA_GROW_PX,
      width: pillBox.width + 2 * PILL_AREA_GROW_PX,
      height: pillBox.height + 2 * PILL_AREA_GROW_PX,
    };
  };
  const overlaps = (area: PillBox): boolean => {
    const { point, box } = points;
    const inside = point.x >= area.x && point.x <= area.x + area.width && point.y >= area.y && point.y <= area.y + area.height;
    if (inside) return true;
    return (
      box !== undefined &&
      box.x <= area.x + area.width &&
      box.x + box.width >= area.x &&
      box.y <= area.y + area.height &&
      box.y + box.height >= area.y
    );
  };
  const otherEdge: PillEdge = ownerEdge === "top" ? "bottom" : "top";
  return overlaps(areaAt(ownerEdge)) && !overlaps(areaAt(otherEdge)) ? otherEdge : ownerEdge;
}

/** What the page remembers of the pill's place, per document; it outlives one drawn pill (a redraw keeps `lastPoints`). */
type PillPlaceState = {
  ownerEdge: PillEdge;
  lastPoints: PillPoints | undefined;
  /** The drawn pill, and how to put it at a place; absent while no pill is drawn. */
  element: HTMLElement | undefined;
  apply: ((place: PillEdge) => void) | undefined;
};
const placeByDocument = new WeakMap<Document, PillPlaceState>();

function placeStateOf(doc: Document): PillPlaceState {
  let state = placeByDocument.get(doc);
  if (!state) {
    state = { ownerEdge: "top", lastPoints: undefined, element: undefined, apply: undefined };
    placeByDocument.set(doc, state);
  }
  return state;
}

/** Decides the place from the owner's edge and the kept points, and applies it to the drawn pill. */
function refreshPlace(doc: Document, state: PillPlaceState): void {
  const { element, apply } = state;
  if (!element || !apply || !element.isConnected) return;
  if (!state.lastPoints) {
    apply(state.ownerEdge);
    return;
  }
  const view = doc.defaultView;
  const viewport = {
    width: view?.innerWidth ?? doc.documentElement.clientWidth,
    height: view?.innerHeight ?? doc.documentElement.clientHeight,
  };
  apply(placeFor(state.ownerEdge, element.getBoundingClientRect(), viewport, state.lastPoints));
}

/**
 * Records what the agent is pointing at (`undefined`: nothing - the pointer left or went to rest) and puts
 * the pill where it asks (035/R-524). Synchronous, so the entry can call it before the pointer's glide
 * starts. The points are kept across a redraw by a new `indicator` message and dropped when the indicator
 * is taken down.
 */
export function placePill(doc: Document, points: PillPoints | undefined): void {
  const state = placeStateOf(doc);
  state.lastPoints = points;
  refreshPlace(doc, state);
}

/**
 * Applies one `indicator` message. Returns whether the message was one this module owns, so the
 * entry can tell "handled" from "not mine" without inspecting the shape a second time.
 */
export function applyIndicator(message: unknown, host: IndicatorHost): boolean {
  if (!isIndicatorMessage(message)) return false;
  const { doc } = host;
  removeIndicator(doc);
  const place = placeStateOf(doc);
  place.element = undefined;
  place.apply = undefined;
  if (message.show && !doc.body) {
    deferUntilBody(message, host);
    return true;
  }
  // Whatever was waiting for the body is superseded by this message, drawn or hidden.
  clearPending(doc);
  if (!message.show) {
    // The tab left the session: what the agent pointed at went with it (035/R-525).
    place.lastPoints = undefined;
    return true;
  }
  if (!doc.body) return true;

  if (host.isTopFrame !== false) drawGlow(doc);

  const element = doc.createElement("div");
  element.setAttribute(INDICATOR_PILL_ATTRIBUTE, "");
  element.setAttribute(INDICATOR_MARKER_ATTRIBUTE, "");
  /**
   * Belt and braces for the two ways a page collection could still see it: the collector skips the
   * marked subtree by name, and `aria-hidden` keeps it out of anything reading the document
   * through the accessibility tree - a page's own script, a screen reader, or a later reader here.
   */
  element.setAttribute("aria-hidden", "true");
  // 035 (R-530, R-531): drawn at the owner's edge, 8 px in from it and from the right; the step-aside
  // below may move it to the other edge once it is in the document and can be measured.
  const ownerEdge = edgeOf(message);
  Object.assign(element.style, {
    position: "fixed",
    ...(ownerEdge === "bottom" ? { bottom: `${PILL_MARGIN_PX}px` } : { top: `${PILL_MARGIN_PX}px` }),
    right: "8px",
    zIndex: "2147483647",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 10px",
    borderRadius: "999px",
    background: "rgba(17, 17, 17, 0.88)",
    color: "#ffffff",
    font: "12px/1.4 system-ui, sans-serif",
    // The indicator sits over the page the agent is working on, so every pixel of it that is not
    // the control must let a click through to the page underneath.
    pointerEvents: "none",
  });

  const mode = modeOf(message);
  const text = doc.createElement("span");
  // `textContent`, never `innerHTML`: the label crosses from the worker as text and stays text.
  text.textContent = (mode === "held" ? (message.heldLabel ?? message.label) : message.label) ?? "";
  element.appendChild(text);

  /**
   * The security property (R-117, FR-062, 034/R-522). A page script can call `click()` on any element
   * in its own document, so a control that acted on every click would let the page decide when the
   * owner's window comes forward - or when the agent is stopped. Only an event the browser itself
   * made is trusted.
   */
  const trusted = (event: Event): boolean =>
    (host.isTrustedEvent ?? ((candidate: Event) => candidate.isTrusted === true))(event);
  const control = (copy: string, onTrustedClick: () => void): HTMLButtonElement => {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = copy;
    Object.assign(button.style, {
      pointerEvents: "auto",
      cursor: "pointer",
      border: "1px solid rgba(255, 255, 255, 0.6)",
      borderRadius: "999px",
      background: "transparent",
      color: "inherit",
      font: "inherit",
      padding: "2px 8px",
    });
    button.addEventListener("click", (event: Event) => {
      if (!trusted(event)) return;
      onTrustedClick();
    });
    element.appendChild(button);
    return button;
  };

  // The row (035/R-531): Stop or Resume, back to the agent's tab, Open side panel, Move to ...
  // Stop with working and conversation, Resume with held; never both, and neither without its words.
  if (mode === "held") {
    if (message.resume) {
      control(message.resume, () => pressOnPill(host, element, { type: "ui.agent.pill-resume" }, message.resumeUndelivered));
    }
  } else if (message.stop) {
    control(message.stop, () => pressOnPill(host, element, { type: "ui.agent.pill-stop" }, message.stopUndelivered));
  }

  control(message.action ?? "", () => host.send({ type: "ui.agent.focus-main" }));

  const openWords = textOf(message.openPanel);
  if (openWords) {
    const unopened = textOf(message.panelUnopened);
    control(openWords, () => openOnPill(host, element, unopened));
  }

  // The move control names the edge the pill is NOT drawn at, which is where a press sends it
  // (035/R-529): while the pill has stepped aside it still moves the owner's edge to the other one.
  const moveToTop = textOf(message.moveToTop);
  const moveToBottom = textOf(message.moveToBottom);
  let drawnAt: PillEdge = ownerEdge;
  const moveControl =
    moveToTop && moveToBottom
      ? control(drawnAt === "top" ? moveToBottom : moveToTop, () =>
          pressOnPill(host, element, { type: "ui.agent.pill-move", to: drawnAt === "top" ? "bottom" : "top" }, undefined),
        )
      : undefined;

  place.ownerEdge = ownerEdge;
  place.element = element;
  place.apply = (at: PillEdge): void => {
    drawnAt = at;
    element.style.top = at === "top" ? `${PILL_MARGIN_PX}px` : "";
    element.style.bottom = at === "bottom" ? `${PILL_MARGIN_PX}px` : "";
    if (moveControl && moveToTop && moveToBottom) moveControl.textContent = at === "top" ? moveToBottom : moveToTop;
  };

  adoptMark(doc, element);
  doc.body.appendChild(element);
  // A redraw keeps what the agent last pointed at, so it does not undo a step aside (035/R-530).
  refreshPlace(doc, place);
  return true;
}
