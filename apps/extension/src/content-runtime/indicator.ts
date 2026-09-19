import { INDICATOR_MARKER_ATTRIBUTE } from "./indicator-marker.js";

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
};

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
  const candidate = message as Partial<IndicatorMessage>;
  return candidate.type === "indicator" && typeof candidate.show === "boolean";
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
  doc.body?.appendChild(layer);
}

/**
 * Applies one `indicator` message. Returns whether the message was one this module owns, so the
 * entry can tell "handled" from "not mine" without inspecting the shape a second time.
 */
export function applyIndicator(message: unknown, host: IndicatorHost): boolean {
  if (!isIndicatorMessage(message)) return false;
  const { doc } = host;
  removeIndicator(doc);
  if (!message.show) return true;
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
  Object.assign(element.style, {
    position: "fixed",
    top: "8px",
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

  const text = doc.createElement("span");
  // `textContent`, never `innerHTML`: the label crosses from the worker as text and stays text.
  text.textContent = message.label ?? "";
  element.appendChild(text);

  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = message.action ?? "";
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
    /**
     * The security property (R-117, FR-062). A page script can call `click()` on any element in
     * its own document, so a control that acted on every click would let the page decide when the
     * owner's window comes forward. Only an event the browser itself made is trusted.
     */
    const trusted = host.isTrustedEvent ?? ((candidate: Event) => candidate.isTrusted === true);
    if (!trusted(event)) return;
    host.send({ type: "ui.agent.focus-main" });
  });
  element.appendChild(button);

  doc.body.appendChild(element);
  return true;
}
