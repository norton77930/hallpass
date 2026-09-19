import type { ContentExecutionRefusalReason, RuntimeAction } from "@hallpass/contracts";
import { classifyClick, classifyDrag, classifyKeyPress, classifyTextEntry } from "@hallpass/domain";
import { readLiveTarget, type LiveTargetDescriptor, type TargetRecord, type TargetRegistry } from "./targets.js";

export type TargetVisibility = "visible" | "not-visible" | "not-applicable";

export type PageSink = {
  scrollBy(delta: number): number;
  /** Brings one live target into view and returns the resulting scroll position. */
  scrollToTarget(target: TargetRecord): number;
  /** Whether the target is rendered inside the viewport right now; observed after an effect. */
  targetVisibility(target: TargetRecord): TargetVisibility;
  /**
   * The document URL as the page sees it at this instant. It is compared before and after an
   * effect: a same-document URL change (pushState, hash) is observable synchronously, while a full
   * navigation is only observable by the worker through its later re-probe.
   */
  currentHref(): string | undefined;
  click(target: TargetRecord): { ok: boolean; clicks: number };
  enterText(
    target: TargetRecord,
    text: string,
    editMode: "insert" | "replace",
  ): { ok: boolean; charactersChanged: number };
  /**
   * Focuses the target and delivers one key as keyboard events. Synthetic events run the page's own
   * handlers and none of the browser's default actions - no implicit submission, no focus move -
   * which is the boundary this capability lives inside. `focusRetained` is the verification: whether
   * the focused element is still the one the key was sent to.
   */
  pressKey(
    target: TargetRecord,
    key: string,
    modifiers: readonly string[],
  ): { ok: boolean; focusRetained: boolean };
  /**
   * Delivers a hover as the pointer and mouse events a page's own handlers listen for. Synthetic
   * events do not make `:hover` match, so a menu opened purely by CSS stays closed while a
   * script-driven one opens. `targetVisible` is the verification: the target is still connected and
   * rendered after the hover.
   */
  hover(target: TargetRecord): { ok: boolean; targetVisible: boolean };
  /** Two activations of the control, then the dblclick its handlers listen for; `clicks` is the running count. */
  doubleClick(target: TargetRecord): { ok: boolean; clicks: number };
  /**
   * The right-button pointer and mouse sequence, ending in `contextmenu`, delivered to the page's
   * own handlers (003/US3 decision 4). Synthetic events run no browser default action, so the
   * native context menu never opens and the page's own menu - the thing an agent is after - does.
   */
  rightClick(target: TargetRecord): { ok: boolean; clicks: number };
  /**
   * Three activations plus the `dblclick` a browser sends on the second, delivered as events.
   * The browser's own text selection is a default action and does not happen; a page that selects
   * a paragraph in its own handler does.
   */
  tripleClick(target: TargetRecord): { ok: boolean; clicks: number };
  /**
   * Sets one control to a stated value: text into an input or textarea, an option into a `<select>`
   * by value or by label, checked state into a checkbox or radio. `valueMatched` is the
   * verification and is read back *from the control* after the change, so a page whose own handler
   * rejected or rewrote the value reports false rather than the value that was asked for.
   */
  setValue(target: TargetRecord, value: string | boolean): { ok: boolean; valueMatched: boolean };
  /**
   * The HTML drag-and-drop sequence from one target onto another. `documentChanged` is consulted
   * between the events, so a document that changes mid-gesture ends it before the drop. `moved` is
   * the verification: the dragged element's document order relative to the drop target, or its
   * position on screen, changed.
   */
  drag(
    source: TargetRecord,
    target: TargetRecord,
    documentChanged: () => boolean,
  ): { ok: boolean; moved: boolean; documentChanged: boolean };
};

type EventTargetLike = {
  dispatchEvent(event: unknown): boolean;
  isConnected?: boolean;
  compareDocumentPosition?: (other: unknown) => number;
  getBoundingClientRect?: () => Rect;
};

function isEventTarget(value: unknown): value is EventTargetLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { dispatchEvent?: unknown }).dispatchEvent === "function"
  );
}

type EventCtor = new (type: string, init?: Record<string, unknown>) => object;

/** The first of the named event constructors this environment has; a page always has `Event`. */
function eventConstructor(...names: string[]): EventCtor | undefined {
  const globals = globalThis as Record<string, unknown>;
  for (const name of names) {
    const ctor = globals[name];
    if (typeof ctor === "function") return ctor as EventCtor;
  }
  return undefined;
}

/** A hover as a pointer sees it: over and move bubble, enter does not. */
const HOVER_SEQUENCE: ReadonlyArray<readonly [type: string, bubbles: boolean]> = [
  ["pointerover", true],
  ["pointerenter", false],
  ["mouseover", true],
  ["mouseenter", false],
  ["pointermove", true],
  ["mousemove", true],
];

/**
 * The right button as a pointer sends it (003/US3 decision 4). `contextmenu` is last, which is the
 * order a browser uses and the one a page listening for it expects.
 */
const RIGHT_CLICK_SEQUENCE: ReadonlyArray<readonly [type: string, bubbles: boolean]> = [
  ["pointerdown", true],
  ["mousedown", true],
  ["pointerup", true],
  ["mouseup", true],
  ["contextmenu", true],
];

function pointerLikeEvent(
  type: string,
  init: { bubbles: boolean; detail?: number; button?: number; buttons?: number },
): object {
  const Ctor =
    (type.startsWith("pointer")
      ? eventConstructor("PointerEvent", "MouseEvent", "Event")
      : eventConstructor("MouseEvent", "Event")) ?? eventConstructor("Event");
  if (!Ctor) return { type };
  return new Ctor(type, {
    bubbles: init.bubbles,
    cancelable: true,
    composed: true,
    ...(init.detail !== undefined ? { detail: init.detail } : {}),
    ...(init.button !== undefined ? { button: init.button } : {}),
    ...(init.buttons !== undefined ? { buttons: init.buttons } : {}),
    // What a real mouse-driven pointer carries; a handler filtering on the pointer type sees a mouse.
    ...(type.startsWith("pointer") ? { pointerType: "mouse", isPrimary: true, pointerId: 1 } : {}),
  });
}

/** One `DataTransfer` shared by the whole drag sequence, where the environment has one. */
function createDataTransfer(): unknown {
  const Ctor = eventConstructor("DataTransfer") as unknown as (new () => object) | undefined;
  try {
    return Ctor ? new Ctor() : undefined;
  } catch {
    return undefined;
  }
}

function dragLikeEvent(type: string, dataTransfer: unknown): object {
  const DragCtor = eventConstructor("DragEvent");
  if (DragCtor) {
    try {
      return new DragCtor(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        ...(dataTransfer ? { dataTransfer } : {}),
      });
    } catch {
      // An environment that names DragEvent but cannot construct it: deliver a plain event instead.
    }
  }
  const Ctor = eventConstructor("Event");
  return Ctor ? new Ctor(type, { bubbles: true, cancelable: true }) : { type };
}

/**
 * Where an element is, for the purpose of telling whether a drag moved it: its document order
 * relative to the drop target (a reorder), and its position on screen *relative to the drop
 * target* where layout exists, so a scroll that carried both endpoints together is not a move.
 * Environments without layout report zero-sized rectangles, which are ignored.
 */
type Position = { order: number; top?: number; left?: number };

function positionOf(element: EventTargetLike, relativeTo: EventTargetLike): Position {
  const order =
    typeof element.compareDocumentPosition === "function" ? element.compareDocumentPosition(relativeTo) : 0;
  const rect = readRect(element);
  const anchor = readRect(relativeTo);
  if (!rect || (rect.width <= 0 && rect.height <= 0)) return { order };
  if (!anchor || (anchor.width <= 0 && anchor.height <= 0)) return { order, top: rect.top, left: rect.left };
  return { order, top: rect.top - anchor.top, left: rect.left - anchor.left };
}

function samePosition(before: Position, after: Position): boolean {
  return before.order === after.order && before.top === after.top && before.left === after.left;
}

/** Whether a hovered target is still something a user could see: connected, and not hidden. */
function isRenderedTarget(element: EventTargetLike): boolean {
  if (element.isConnected === false) return false;
  const live = readLiveTarget(element);
  return live !== undefined && live.hidden !== true;
}

/** The part of a form control `setValue` touches; named so the sink can be read without a DOM lib. */
type ControlElement = {
  tagName?: string;
  value?: unknown;
  checked?: unknown;
  readOnly?: unknown;
  disabled?: unknown;
  selectedIndex?: number;
  options?: ArrayLike<{ value?: string; label?: string; text?: string } | undefined>;
  dispatchEvent?(event: unknown): boolean;
};

type ScrollRoot = { scrollTop: number; clientWidth?: number; clientHeight?: number };

export type DocumentSinkHost = {
  window: { scrollY?: number; innerWidth?: number; innerHeight?: number };
  document: {
    documentElement: ScrollRoot;
    body?: ScrollRoot | null;
    scrollingElement?: ScrollRoot | null;
    activeElement?: unknown;
  };
  location?: { href?: string };
};

type Rect = { top: number; bottom: number; left: number; right: number; width: number; height: number };

function isClickable(value: unknown): value is { click(): void } {
  return typeof value === "object" && value !== null && typeof (value as { click?: unknown }).click === "function";
}

/**
 * Only a writable input or textarea may receive text. A button also exposes a string `value`, so
 * the tag is checked as well as the property; read-only and disabled controls are refused here too
 * in case a caller bypassed classification.
 */
function isTextControl(value: unknown): value is { value: string; dispatchEvent(event: unknown): boolean } {
  if (typeof value !== "object" || value === null) return false;
  const element = value as {
    value?: unknown;
    dispatchEvent?: unknown;
    tagName?: unknown;
    readOnly?: unknown;
    disabled?: unknown;
  };
  const tag = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
  return (
    (tag === "INPUT" || tag === "TEXTAREA") &&
    typeof element.value === "string" &&
    typeof element.dispatchEvent === "function" &&
    element.readOnly !== true &&
    element.disabled !== true
  );
}

function isDetached(record: TargetRecord | undefined): boolean {
  const element = record?.element;
  return (
    typeof element === "object" &&
    element !== null &&
    "isConnected" in element &&
    (element as { isConnected?: unknown }).isConnected === false
  );
}

function readRect(element: unknown): Rect | undefined {
  const candidate = element as { getBoundingClientRect?: () => Rect } | null | undefined;
  if (!candidate || typeof candidate.getBoundingClientRect !== "function") return undefined;
  const rect = candidate.getBoundingClientRect();
  return rect && typeof rect.top === "number" ? rect : undefined;
}

export function createDocumentSink(host: DocumentSinkHost): PageSink {
  const clickCounts = new WeakMap<object, number>();
  const root = () => host.document.scrollingElement ?? host.document.documentElement;
  const currentScrollTop = () => Number(root().scrollTop) || Number(host.window.scrollY) || 0;
  return {
    scrollBy(delta) {
      const scrollRoot = root();
      const next = (Number(scrollRoot.scrollTop) || 0) + delta;
      scrollRoot.scrollTop = next;
      if (host.document.body && host.document.body !== scrollRoot) host.document.body.scrollTop = next;
      return Number(scrollRoot.scrollTop) || Number(host.window.scrollY) || next;
    },
    scrollToTarget(target) {
      const element = target.element as
        | { scrollIntoView?: (options: unknown) => void; offsetTop?: number }
        | null
        | undefined;
      if (element && typeof element.scrollIntoView === "function") {
        // Instant, so the scroll position and visibility read right after are post-effect facts
        // rather than a pre-animation snapshot under a smooth scroll-behavior stylesheet.
        element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      } else if (element && typeof element.offsetTop === "number") {
        root().scrollTop = element.offsetTop;
      }
      return currentScrollTop();
    },
    targetVisibility(target) {
      const element = target.element;
      if (!element || (element as { isConnected?: unknown }).isConnected === false) return "not-visible";
      const rect = readRect(element);
      if (!rect || (rect.width <= 0 && rect.height <= 0)) return "not-visible";
      const viewportWidth = host.window.innerWidth ?? host.document.documentElement.clientWidth ?? 0;
      const viewportHeight = host.window.innerHeight ?? host.document.documentElement.clientHeight ?? 0;
      const onScreen =
        rect.bottom > 0 &&
        rect.right > 0 &&
        (viewportHeight <= 0 || rect.top < viewportHeight) &&
        (viewportWidth <= 0 || rect.left < viewportWidth);
      return onScreen ? "visible" : "not-visible";
    },
    currentHref() {
      const href = host.location?.href;
      return typeof href === "string" ? href : undefined;
    },
    click(target) {
      const element = target.element;
      if (!isClickable(element)) return { ok: false, clicks: 0 };
      element.click();
      const next = (clickCounts.get(element) ?? 0) + 1;
      clickCounts.set(element, next);
      return { ok: true, clicks: next };
    },
    enterText(target, text, editMode) {
      const element = target.element;
      if (!isTextControl(element)) return { ok: false, charactersChanged: 0 };
      element.value = editMode === "replace" ? text : element.value + text;
      const EventCtor = (globalThis as { Event?: new (type: string, init?: { bubbles?: boolean }) => object }).Event;
      if (EventCtor) element.dispatchEvent(new EventCtor("input", { bubbles: true }));
      return { ok: true, charactersChanged: text.length };
    },
    pressKey(target, key, modifiers) {
      const element = target.element;
      // Same floor as text entry: only a writable text control, whatever a caller was told.
      if (!isTextControl(element)) return { ok: false, focusRetained: false };
      const focusable = element as { focus?: () => void };
      focusable.focus?.();
      const KeyboardEventCtor = (
        globalThis as {
          KeyboardEvent?: new (
            type: string,
            init?: { key?: string; code?: string; bubbles?: boolean; cancelable?: boolean; shiftKey?: boolean },
          ) => object;
        }
      ).KeyboardEvent;
      if (KeyboardEventCtor) {
        const init = {
          key,
          code: KEY_CODES[key] ?? key,
          bubbles: true,
          cancelable: true,
          shiftKey: modifiers.includes("Shift"),
        };
        element.dispatchEvent(new KeyboardEventCtor("keydown", init));
        element.dispatchEvent(new KeyboardEventCtor("keyup", init));
      }
      return { ok: true, focusRetained: host.document.activeElement === element };
    },
    hover(target) {
      const element = target.element;
      if (!isEventTarget(element)) return { ok: false, targetVisible: false };
      for (const [type, bubbles] of HOVER_SEQUENCE) {
        element.dispatchEvent(pointerLikeEvent(type, { bubbles }));
      }
      return { ok: true, targetVisible: isRenderedTarget(element) };
    },
    doubleClick(target) {
      const element = target.element;
      if (!isClickable(element) || !isEventTarget(element)) return { ok: false, clicks: 0 };
      element.click();
      element.click();
      element.dispatchEvent(pointerLikeEvent("dblclick", { bubbles: true, detail: 2 }));
      const next = (clickCounts.get(element) ?? 0) + 2;
      clickCounts.set(element, next);
      return { ok: true, clicks: next };
    },
    rightClick(target) {
      const element = target.element;
      // The same floor the other two gestures apply (003/B8): something that cannot be activated at
      // all is not a control, whatever events could be dispatched at it.
      if (!isClickable(element) || !isEventTarget(element)) return { ok: false, clicks: 0 };
      // `element.click()` is deliberately absent: it is a *left* activation, and a right-button
      // gesture that also activated the control would do two different things at once.
      for (const [type, bubbles] of RIGHT_CLICK_SEQUENCE) {
        element.dispatchEvent(pointerLikeEvent(type, { bubbles, button: 2, buttons: 2, detail: 1 }));
      }
      const next = (clickCounts.get(element) ?? 0) + 1;
      clickCounts.set(element, next);
      return { ok: true, clicks: next };
    },
    tripleClick(target) {
      const element = target.element;
      if (!isClickable(element) || !isEventTarget(element)) return { ok: false, clicks: 0 };
      element.click();
      element.click();
      element.dispatchEvent(pointerLikeEvent("dblclick", { bubbles: true, detail: 2 }));
      element.click();
      // `detail: 3` is what a browser sends on the third click of a run, and it is how a page's own
      // handler recognises a triple click at all.
      element.dispatchEvent(pointerLikeEvent("click", { bubbles: true, detail: 3 }));
      const next = (clickCounts.get(element) ?? 0) + 3;
      clickCounts.set(element, next);
      return { ok: true, clicks: next };
    },
    setValue(target, value) {
      const element = target.element as ControlElement | null | undefined;
      const dispatch = element?.dispatchEvent;
      if (!element || typeof dispatch !== "function") {
        return { ok: false, valueMatched: false };
      }
      const tag = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
      const fire = (): void => {
        const EventCtor = (globalThis as { Event?: new (type: string, init?: { bubbles?: boolean }) => object })
          .Event;
        if (!EventCtor) return;
        // Both, in the order a browser sends them: pages listen for one or the other and a control
        // set without them is a value the page's own state never learns about.
        dispatch.call(element, new EventCtor("input", { bubbles: true }));
        dispatch.call(element, new EventCtor("change", { bubbles: true }));
      };
      if (typeof value === "boolean") {
        if (typeof element.checked !== "boolean") return { ok: false, valueMatched: false };
        element.checked = value;
        fire();
        return { ok: true, valueMatched: element.checked === value };
      }
      if (tag === "SELECT") {
        const options = element.options ?? [];
        // By value first, then by visible label: an agent reading a page sees the label, and a
        // select whose values are opaque would otherwise be unusable.
        let matched = -1;
        for (let index = 0; index < options.length; index += 1) {
          const option = options[index];
          if (option?.value === value || option?.label === value || option?.text?.trim() === value) {
            matched = index;
            break;
          }
        }
        if (matched < 0) return { ok: true, valueMatched: false };
        element.selectedIndex = matched;
        fire();
        return { ok: true, valueMatched: element.value === options[matched]?.value };
      }
      if (typeof element.value !== "string" || element.readOnly === true || element.disabled === true) {
        return { ok: false, valueMatched: false };
      }
      element.value = value;
      fire();
      return { ok: true, valueMatched: element.value === value };
    },
    drag(source, target, documentChanged) {
      const from = source.element;
      const to = target.element;
      if (!isEventTarget(from) || !isEventTarget(to)) return { ok: false, moved: false, documentChanged: false };
      const before = positionOf(from, to);
      const transfer = createDataTransfer();
      from.dispatchEvent(dragLikeEvent("dragstart", transfer));
      if (documentChanged()) return { ok: true, moved: false, documentChanged: true };
      to.dispatchEvent(dragLikeEvent("dragenter", transfer));
      // The browser's own rule: a drop happens only where the page cancelled `dragover`, which is
      // how a page says it accepts the drag. `dispatchEvent` returns false exactly then.
      const accepted = !to.dispatchEvent(dragLikeEvent("dragover", transfer));
      // The last look before the drop: a page that navigated while the pointer was over the drop
      // target gets no drop at all, and the gesture is reported as interrupted (US4 scenario 4).
      if (documentChanged()) return { ok: true, moved: false, documentChanged: true };
      if (accepted) {
        to.dispatchEvent(dragLikeEvent("drop", transfer));
      } else {
        // The browser's model: a drag that resolves to nothing leaves the target it entered, so a
        // page that highlighted on `dragenter` gets the `dragleave` that clears it.
        to.dispatchEvent(dragLikeEvent("dragleave", transfer));
      }
      from.dispatchEvent(dragLikeEvent("dragend", transfer));
      const changed = documentChanged();
      return {
        ok: true,
        moved: accepted && !changed && !samePosition(before, positionOf(from, to)),
        documentChanged: changed,
      };
    },
  };
}

/** `code` values for the named keys, so a handler that reads `event.code` sees what a real press sends. */
const KEY_CODES: Record<string, string> = {
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Home: "Home",
  End: "End",
  Backspace: "Backspace",
  Delete: "Delete",
};

export function pageSinkFromGlobal(globalRef: typeof globalThis = globalThis): PageSink | undefined {
  const pageWindow = (globalRef as { window?: DocumentSinkHost["window"] }).window;
  const pageDocument = (globalRef as { document?: DocumentSinkHost["document"] }).document;
  const pageLocation = (globalRef as { location?: DocumentSinkHost["location"] }).location;
  if (!pageWindow || !pageDocument?.documentElement) return undefined;
  return createDocumentSink({
    window: pageWindow,
    document: pageDocument,
    ...(pageLocation ? { location: pageLocation } : {}),
  });
}

export type MemoryField = {
  value: string;
  clicks: number;
  /** Right-button gestures delivered to this field; counted apart from activations. */
  rightClicks?: number;
  /** A checkbox-like field's state, as `form_input` sets it. */
  checked?: boolean;
  /** A `<select>`'s option list; a value outside it cannot be set. */
  options?: string[];
  /** Keys delivered to this field, in order. */
  keysPressed?: string[];
  /** When set, a key press leaves this field unfocused, like a handler that moved focus. */
  losesFocusOnKey?: boolean;
  /** Hovers delivered to this field. */
  hovers?: number;
  /** When set, a hover leaves this field hidden, like a handler that closed the control. */
  hidesOnHover?: boolean;
  /** When false, a drop onto this field changes nothing, like a page that ignores the drag. */
  acceptsDrop?: boolean;
  /** Handles this field was dragged onto, in order. */
  dropsOnto?: string[];
  /** When set, a click moves the href of the sink there, like a handler that navigates. */
  navigatesTo?: string;
  /** Scroll position that brings this field into view. */
  offsetTop?: number;
  /** Whether the field counts as on screen after a scroll; defaults to true. */
  visible?: boolean;
};

export function createMemorySink(initial?: {
  scrollTop?: number;
  href?: string;
  fields?: Record<string, MemoryField>;
}): PageSink & {
  scrollTop: number;
  href: string | undefined;
  scrolledTo: string[];
  field(targetHandle: string): MemoryField | undefined;
} {
  let scrollTop = initial?.scrollTop ?? 0;
  let href = initial?.href;
  const scrolledTo: string[] = [];
  const fields = new Map<string, MemoryField>(
    Object.entries(initial?.fields ?? { "tgt-1": { value: "", clicks: 0 } }),
  );
  return {
    get scrollTop() {
      return scrollTop;
    },
    get href() {
      return href;
    },
    set href(next: string | undefined) {
      href = next;
    },
    scrolledTo,
    field(targetHandle) {
      return fields.get(targetHandle);
    },
    scrollBy(delta) {
      scrollTop += delta;
      return scrollTop;
    },
    scrollToTarget(target) {
      const field = fields.get(target.targetHandle);
      scrolledTo.push(target.targetHandle);
      if (field?.offsetTop !== undefined) scrollTop = field.offsetTop;
      return scrollTop;
    },
    targetVisibility(target) {
      const field = fields.get(target.targetHandle);
      if (!field) return "not-visible";
      return field.visible === false ? "not-visible" : "visible";
    },
    currentHref() {
      return href;
    },
    click(target) {
      const field = fields.get(target.targetHandle);
      if (!field) return { ok: false, clicks: 0 };
      field.clicks += 1;
      if (field.navigatesTo !== undefined) href = field.navigatesTo;
      return { ok: true, clicks: field.clicks };
    },
    enterText(target, text, editMode) {
      const field = fields.get(target.targetHandle);
      if (!field) return { ok: false, charactersChanged: 0 };
      field.value = editMode === "replace" ? text : field.value + text;
      return { ok: true, charactersChanged: text.length };
    },
    pressKey(target, key) {
      const field = fields.get(target.targetHandle);
      if (!field) return { ok: false, focusRetained: false };
      field.keysPressed = [...(field.keysPressed ?? []), key];
      return { ok: true, focusRetained: field.losesFocusOnKey !== true };
    },
    hover(target) {
      const field = fields.get(target.targetHandle);
      if (!field) return { ok: false, targetVisible: false };
      field.hovers = (field.hovers ?? 0) + 1;
      return { ok: true, targetVisible: field.hidesOnHover !== true && field.visible !== false };
    },
    doubleClick(target) {
      const field = fields.get(target.targetHandle);
      if (!field) return { ok: false, clicks: 0 };
      field.clicks += 2;
      if (field.navigatesTo !== undefined) href = field.navigatesTo;
      return { ok: true, clicks: field.clicks };
    },
    rightClick(target) {
      const field = fields.get(target.targetHandle);
      if (!field) return { ok: false, clicks: 0 };
      // Counted, but the field's `navigatesTo` is deliberately not followed: a right-button gesture
      // is not an activation, and a memory sink that navigated on one would be modelling the
      // opposite of what the document sink does.
      field.rightClicks = (field.rightClicks ?? 0) + 1;
      return { ok: true, clicks: field.rightClicks };
    },
    tripleClick(target) {
      const field = fields.get(target.targetHandle);
      if (!field) return { ok: false, clicks: 0 };
      field.clicks += 3;
      if (field.navigatesTo !== undefined) href = field.navigatesTo;
      return { ok: true, clicks: field.clicks };
    },
    setValue(target, value) {
      const field = fields.get(target.targetHandle);
      if (!field) return { ok: false, valueMatched: false };
      if (typeof value === "boolean") {
        field.checked = value;
        return { ok: true, valueMatched: field.checked === value };
      }
      // A field with a fixed option list models a `<select>`: a value outside it is not set, which
      // is the same answer the document sink gives.
      if (field.options && !field.options.includes(value)) return { ok: true, valueMatched: false };
      field.value = value;
      return { ok: true, valueMatched: field.value === value };
    },
    drag(source, target, documentChanged) {
      const from = fields.get(source.targetHandle);
      const to = fields.get(target.targetHandle);
      if (!from || !to) return { ok: false, moved: false, documentChanged: false };
      // A drop target that navigates does so while the pointer is over it: mid-gesture.
      if (to.navigatesTo !== undefined) href = to.navigatesTo;
      if (documentChanged()) return { ok: true, moved: false, documentChanged: true };
      from.dropsOnto = [...(from.dropsOnto ?? []), target.targetHandle];
      return { ok: true, moved: to.acceptsDrop !== false, documentChanged: false };
    },
  };
}

const MAGNITUDE: Record<string, number> = { small: 80, medium: 200, large: 400 };

export type ExecuteActionResult = {
  ok: boolean;
  effect?: string;
  /** Why the action was refused or could not be carried out; a contract value (002 T053b). */
  reason?: ContentExecutionRefusalReason;
  scrollTop?: number;
  clicks?: number;
  charactersChanged?: number;
  valueEchoed?: false;
  /** The key a key press delivered. */
  key?: string;
  /**
   * Whether the focused element is still the one the key went to. Reported as observed; the worker
   * transmits false as uncertain, never as success.
   */
  focusRetained?: boolean;
  /** Whether a hovered target is still connected and rendered; false is uncertain, never success. */
  targetVisible?: boolean;
  /** Whether a dragged element's position changed; false is uncertain, never success. */
  moved?: boolean;
  /** Whether the control holds the stated value now; false is never success. */
  valueMatched?: boolean;
  /** Whether the document URL changed synchronously during the effect; never true on success. */
  documentChanged?: boolean;
  /** Target visibility observed after a scroll; not-applicable for viewport scrolling. */
  targetVisibility?: TargetVisibility;
};

export function executeAction(
  registry: TargetRegistry,
  input: {
    capability: RuntimeAction;
    documentEpoch: string;
    /**
     * Whose policy this effect runs under (003/US3 decision 3).
     *
     * `classified` - the default, and the only value the archived remote path ever produces - keeps
     * every refusal 002 built: a navigating link, a submitting control and a target that cannot be
     * classified are all refused here. `trusted-agent` skips *those refusals and nothing else*: the
     * owner's per-site consent has already been given for this call, and re-deciding it from an
     * element's shape would refuse an effect the owner explicitly approved. Everything that is not
     * classification - the stale-handle check, the missing-sink check, the document observation, the
     * evidence each result carries - runs identically, because none of it is policy: it is how the
     * worker knows what happened, and FR-040 forbids claiming an effect nobody observed no matter
     * who asked.
     */
    policy?: "classified" | "trusted-agent";
    mode?: "viewport" | "target";
    targetHandle?: string;
    /** A drag's drop target; classified like the start, and the stricter decides. */
    dropTargetHandle?: string;
    target?: LiveTargetDescriptor;
    text?: string;
    editMode?: "insert" | "replace";
    /** `browser.form-input`'s stated value. */
    value?: string | boolean;
    key?: string;
    modifiers?: readonly string[];
    magnitude?: "small" | "medium" | "large";
    direction?: "up" | "down";
    sink?: PageSink;
  },
): ExecuteActionResult {
  const targetRecord = input.targetHandle ? registry.resolve(input.targetHandle, input.documentEpoch) : undefined;
  if (input.targetHandle && (!targetRecord || isDetached(targetRecord))) return { ok: false, reason: "stale-target" };
  // Live metadata wins: re-read the element now, fall back to what the registry captured, and
  // only then to a caller-supplied descriptor (which the wire path never provides).
  const target =
    (targetRecord ? readLiveTarget(targetRecord.element) ?? targetRecord.target : undefined) ??
    input.target;
  /** See `policy` above: the owner's per-site consent has already answered this question. */
  const classified = input.policy !== "trusted-agent";
  if (classified && input.capability === "browser.click" && (!target || classifyClick(target) === "deny")) {
    return { ok: false, reason: "denied" };
  }
  if (
    classified &&
    input.capability === "browser.enter-text" &&
    (!target || classifyTextEntry(target) === "deny")
  ) {
    return { ok: false, reason: "denied" };
  }
  if (classified && input.capability === "browser.key-press") {
    if (!target) return { ok: false, reason: "denied" };
    const decision = classifyKeyPress(target, input.key ?? "", input.modifiers ?? []);
    if (decision.decision === "deny") {
      // Each refusal is named for what it is: the submission guard is a decision about this key on
      // this control, and the user (and the service) should be able to tell it from a bad target.
      return {
        ok: false,
        reason:
          decision.reason === "submission"
            ? "submission-guard"
            : decision.reason === "key"
              ? "unsupported-key"
              : "denied",
      };
    }
  }
  if (
    classified &&
    (input.capability === "browser.hover" ||
      input.capability === "browser.double-click" ||
      input.capability === "browser.right-click" ||
      input.capability === "browser.triple-click")
  ) {
    // The gestures ride on the click classification of the live element (002/FR-025).
    if (!target || classifyClick(target) === "deny") return { ok: false, reason: "denied" };
  }
  let dropRecord: TargetRecord | undefined;
  if (input.capability === "browser.drag") {
    dropRecord = input.dropTargetHandle ? registry.resolve(input.dropTargetHandle, input.documentEpoch) : undefined;
    if (!dropRecord || isDetached(dropRecord)) return { ok: false, reason: "stale-target" };
    const dropTarget = readLiveTarget(dropRecord.element) ?? dropRecord.target;
    // Both endpoints, read live, and the stricter decides; an endpoint that cannot be classified
    // refuses the whole request rather than half of it.
    if (classified && (!target || !dropTarget || classifyDrag(target, dropTarget) === "deny")) {
      return { ok: false, reason: "denied" };
    }
  }
  if (!input.sink) return { ok: false, reason: "missing-sink" };
  const sink = input.sink;
  if (input.capability === "browser.scroll") {
    if (input.mode === "target") {
      if (!targetRecord) return { ok: false, reason: "stale-target" };
      const scrollTop = sink.scrollToTarget(targetRecord);
      return { ok: true, effect: "scrolled", scrollTop, targetVisibility: sink.targetVisibility(targetRecord) };
    }
    const sign = input.direction === "up" ? -1 : 1;
    const scrollTop = sink.scrollBy(sign * (MAGNITUDE[input.magnitude ?? "small"] ?? 80));
    return { ok: true, effect: "scrolled", scrollTop, targetVisibility: "not-applicable" };
  }
  if (!targetRecord) return { ok: false, reason: "stale-target" };
  const hrefBefore = sink.currentHref();
  const observeDocument = (): boolean => {
    const hrefAfter = sink.currentHref();
    return hrefBefore !== undefined && hrefAfter !== undefined && hrefAfter !== hrefBefore;
  };
  if (input.capability === "browser.click") {
    const clicked = sink.click(targetRecord);
    return clicked.ok
      ? { ok: true, effect: "activated", clicks: clicked.clicks, documentChanged: observeDocument() }
      : { ok: false, reason: "missing-target" };
  }
  if (input.capability === "browser.key-press") {
    const pressed = sink.pressKey(targetRecord, input.key ?? "", input.modifiers ?? []);
    return pressed.ok
      ? {
          ok: true,
          effect: "key-pressed",
          key: input.key ?? "",
          focusRetained: pressed.focusRetained,
          valueEchoed: false,
          documentChanged: observeDocument(),
        }
      : { ok: false, reason: "missing-target" };
  }
  if (input.capability === "browser.hover") {
    const hovered = sink.hover(targetRecord);
    return hovered.ok
      ? { ok: true, effect: "hovered", targetVisible: hovered.targetVisible, documentChanged: observeDocument() }
      : { ok: false, reason: "missing-target" };
  }
  if (input.capability === "browser.double-click") {
    const activated = sink.doubleClick(targetRecord);
    return activated.ok
      ? { ok: true, effect: "double-activated", clicks: activated.clicks, documentChanged: observeDocument() }
      : { ok: false, reason: "missing-target" };
  }
  if (input.capability === "browser.right-click") {
    const activated = sink.rightClick(targetRecord);
    return activated.ok
      ? { ok: true, effect: "context-activated", clicks: activated.clicks, documentChanged: observeDocument() }
      : { ok: false, reason: "missing-target" };
  }
  if (input.capability === "browser.triple-click") {
    const activated = sink.tripleClick(targetRecord);
    return activated.ok
      ? { ok: true, effect: "triple-activated", clicks: activated.clicks, documentChanged: observeDocument() }
      : { ok: false, reason: "missing-target" };
  }
  if (input.capability === "browser.drag") {
    if (!dropRecord) return { ok: false, reason: "stale-target" };
    const dragged = sink.drag(targetRecord, dropRecord, observeDocument);
    return dragged.ok
      ? {
          ok: true,
          effect: "dragged",
          moved: dragged.moved,
          documentChanged: dragged.documentChanged || observeDocument(),
        }
      : { ok: false, reason: "missing-target" };
  }
  if (input.capability === "browser.form-input") {
    const set = sink.setValue(targetRecord, input.value ?? "");
    return set.ok
      ? {
          ok: true,
          effect: "value-set",
          valueMatched: set.valueMatched,
          documentChanged: observeDocument(),
        }
      : { ok: false, reason: "missing-target" };
  }
  if (input.capability === "browser.enter-text") {
    const entered = sink.enterText(targetRecord, input.text ?? "", input.editMode ?? "replace");
    return entered.ok
      ? {
          ok: true,
          effect: "text-entered",
          charactersChanged: entered.charactersChanged,
          valueEchoed: false,
          documentChanged: observeDocument(),
        }
      : { ok: false, reason: "missing-target" };
  }
  return noExecutionPath(input.capability);
}

/**
 * Reached only if `RUNTIME_ACTIONS` gains a member without a delivery path of its own: the compiler
 * refuses the call, and a frame for it at runtime is refused rather than delivered as text entry.
 */
function noExecutionPath(capability: never): ExecuteActionResult {
  void capability;
  return { ok: false, reason: "invalid-message" };
}
