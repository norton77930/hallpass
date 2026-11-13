import { INDICATOR_MARKER_ATTRIBUTE } from "./indicator-marker.js";

/**
 * Hiding Hallpass's own marks for a capture (033, FR-509, R-499).
 *
 * A screenshot returned to the agent must not show the pointer, its caption, the press ring, the pill
 * or the glow - they are page DOM, so the browser paints them like anything else. The worker sends
 * `{ type: "marks", hidden: true }` just before such a capture and `hidden: false` right after.
 *
 * - **Inline style, not the injected stylesheet.** The caption's sheet is a `<style>` element a
 *   strict page CSP may block; the hiding must work on every page the marks do. Setting properties
 *   through the element's CSSOM is not subject to the page's CSP. `!important` matters because the
 *   glow breathes with a Web Animation, and an important inline declaration beats an animation.
 * - **Only `opacity` and `transition`.** Nothing is `display: none`d, nothing leaves layout, and every
 *   mark was already `pointer-events: none` (the pill's control aside, which stays where it is), so
 *   the page cannot tell from layout or hit-testing that a capture is under way. `transition: none`
 *   makes the hide immediate rather than a 200 ms fade the capture could catch half-way.
 * - **Each element's previous inline values are remembered and put back**, the glow's own resting
 *   opacity among them, so showing again is exactly the state before. Opacity returns first, while
 *   `transition: none` still holds, then a style flush, then the transition: the marks come back at
 *   once instead of fading in.
 * - **It undoes itself.** Three seconds after a hide the marks come back whether or not a `hidden:
 *   false` arrived: a lost message must not leave the owner without the pointer for good.
 * - **A mark drawn while hidden is hidden too** (`adoptMark`): a gesture that lands during the
 *   capture must not flash the pointer into it.
 */

/** Worn by every mark while it is hidden: how tests and the restore find them. */
export const MARKS_HIDDEN_ATTRIBUTE = "data-hallpass-hidden";

/** The safety net: the longest the marks stay hidden without a `hidden: false`. */
export const MARKS_HIDE_LIMIT_MS = 3000;

/** What the worker sends around a capture. Exactly these two keys. */
export type MarksMessage = { type: "marks"; hidden: boolean };

/** Accepts only the exact shape of the contract; anything else is not this module's message. */
export function isMarksMessage(message: unknown): message is MarksMessage {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const candidate = message as Record<string, unknown>;
  if (candidate["type"] !== "marks" || typeof candidate["hidden"] !== "boolean") return false;
  return Object.keys(candidate).length === 2;
}

/** The marks are everything wearing the indicator's marker except the stylesheet that draws some of them. */
const MARK_SELECTOR = `[${INDICATOR_MARKER_ATTRIBUTE}]:not(style)`;

/** The properties hidden, and what each element had in them before. */
const HIDING = [
  ["opacity", "0"],
  ["transition", "none"],
] as const;

type Remembered = Array<{ property: string; value: string; priority: string }>;
const remembered = new WeakMap<Element, Remembered>();

type DocumentMarks = { hidden: boolean; timer: ReturnType<typeof setTimeout> | undefined };
const documents = new WeakMap<Document, DocumentMarks>();

function stateOf(doc: Document): DocumentMarks {
  let state = documents.get(doc);
  if (!state) {
    state = { hidden: false, timer: undefined };
    documents.set(doc, state);
  }
  return state;
}

function hideElement(element: HTMLElement): void {
  // Already hidden: its remembered values are the real ones, and this would overwrite them with ours.
  if (remembered.has(element)) return;
  remembered.set(
    element,
    HIDING.map(([property]) => ({
      property,
      value: element.style.getPropertyValue(property),
      priority: element.style.getPropertyPriority(property),
    })),
  );
  element.setAttribute(MARKS_HIDDEN_ATTRIBUTE, "");
  for (const [property, value] of HIDING) element.style.setProperty(property, value, "important");
}

function showElement(element: HTMLElement): void {
  const before = remembered.get(element);
  if (!before) return;
  remembered.delete(element);
  element.removeAttribute(MARKS_HIDDEN_ATTRIBUTE);
  // Opacity first, while `transition: none` still holds, then a style flush, then the transition: a
  // mark whose stylesheet fades opacity (the caption's 200 ms) must come back at once, not fade in
  // from 0 under the frame the recorder takes right after a screenshot (033 review I2).
  const opacity = before.find((entry) => entry.property === "opacity");
  if (opacity) restoreProperty(element, opacity);
  void element.ownerDocument.defaultView?.getComputedStyle(element).opacity;
  for (const entry of before) if (entry !== opacity) restoreProperty(element, entry);
}

function restoreProperty(element: HTMLElement, { property, value, priority }: Remembered[number]): void {
  if (value === "") element.style.removeProperty(property);
  else element.style.setProperty(property, value, priority);
}

/** Every mark in this document, wherever it is. */
function marksOf(doc: Document): HTMLElement[] {
  return [...doc.querySelectorAll<HTMLElement>(MARK_SELECTOR)];
}

function clearTimer(state: DocumentMarks): void {
  if (state.timer !== undefined) clearTimeout(state.timer);
  state.timer = undefined;
}

/** Hides every mark now and arms the three-second return. */
export function hideMarks(doc: Document): void {
  const state = stateOf(doc);
  state.hidden = true;
  clearTimer(state);
  state.timer = setTimeout(() => showMarks(doc), MARKS_HIDE_LIMIT_MS);
  for (const mark of marksOf(doc)) hideElement(mark);
}

/** Puts every mark back as it was. */
export function showMarks(doc: Document): void {
  const state = stateOf(doc);
  state.hidden = false;
  clearTimer(state);
  for (const mark of marksOf(doc)) showElement(mark);
}

/** Called when a mark is made: while the document's marks are hidden, a new one is hidden at birth. */
export function adoptMark(doc: Document, mark: HTMLElement): void {
  if (documents.get(doc)?.hidden === true) hideElement(mark);
}

/** `"not-mine"`: not a marks message; `"answered"`: reply now; `"answering"`: the reply follows the frames. */
export type MarksOutcome = "not-mine" | "answered" | "answering";

/**
 * Applies one `marks` message. Both a hide and a show are answered after two animation frames, so
 * the worker's capture starts only once the hidden state has been painted, and the recorder's frame
 * after a screenshot is taken only once the marks are painted back. A document with no animation
 * frames to wait for is answered at once; a background tab, where none run, is answered by the
 * worker's own cap, which is why the page asks for nothing more here.
 */
export function applyMarks(message: unknown, doc: Document, answer: () => void): MarksOutcome {
  if (!isMarksMessage(message)) return "not-mine";
  if (message.hidden) hideMarks(doc);
  else showMarks(doc);
  const view = doc.defaultView;
  if (doc.hidden || typeof view?.requestAnimationFrame !== "function") {
    answer();
    return "answered";
  }
  view.requestAnimationFrame(() => view.requestAnimationFrame(answer));
  return "answering";
}
