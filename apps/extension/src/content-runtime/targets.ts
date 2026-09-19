import { DEFAULT_BOUNDS } from "@hallpass/contracts";
import { ElementRegistry } from "./registry.js";
import { matchDescription } from "@hallpass/domain";
import type {
  ContentEvaluateConditionReply,
  ContentResolutionReply,
  WaitCondition,
} from "@hallpass/contracts";

/**
 * How much of an element's own text a `visible-text-changed` wait remembers and compares (002 US6).
 *
 * It is the label bound, because that is the length this product treats one control's worth of text
 * as, and it is the protocol constant rather than the collection's injected bound: the two ends of
 * this comparison are cut at different moments, and a baseline cut to a different length than the
 * value it is later compared with would report a change nobody made.
 */
export const WAIT_TEXT_BASELINE_CHARS = DEFAULT_BOUNDS.maxLabelChars;

export type TargetRecord = {
  targetHandle: string;
  snapshotId: string;
  documentEpoch: string;
  role?: string;
  label?: string;
  /** A button's visible text, as the collection reported it; matched by a description (002/FR-026). */
  text?: string;
  /**
   * The element's own trimmed text when this handle was minted: the baseline a
   * `visible-text-changed` wait compares against (002/FR-027).
   *
   * Deliberately separate from `text`. `text` is a *name* - only a button's text is one, which is
   * why the collector fills it for buttons alone - and it is what a description is matched against;
   * widening it would let a description resolve an element by content the review never showed it
   * under. This is a baseline for one comparison, is never matched against, and never leaves the
   * page: what the worker learns is the boolean.
   */
  visibleText?: string;
  element?: unknown;
  target?: {
    tagName: string;
    type?: string;
    href?: string;
    autocomplete?: string;
    role?: string;
  };
};

/**
 * Everything the effect-time policy is allowed to see about an element, re-read from the live
 * node. No value, text content, or selector is part of it.
 */
export type LiveTargetDescriptor = {
  tagName: string;
  type?: string;
  href?: string;
  autocomplete?: string;
  role?: string;
  name?: string;
  /** The `hidden` attribute, `aria-hidden="true"`, or a browser-reported non-rendered element. */
  hidden?: boolean;
  readOnly?: boolean;
  /** Own IDL/attribute state or an ancestor `fieldset[disabled]` via the `:disabled` pseudo-class. */
  disabled?: boolean;
  /** Attribute values only: the IDL `formAction` resolves to the document URL when absent. */
  formAction?: string;
  formAttr?: string;
  formTarget?: string;
  download?: string;
  /**
   * The owner form's two facts the key-press submission guard needs (002/FR-024). `null`: no owner
   * form. Absent: the element could have one but the facts could not be read, which fails closed.
   */
  form?: { hasSubmitAffordance: boolean; implicitSubmissionBlockers: number } | null;
};

/**
 * Handles are unpredictable and document-epoch bound: nothing about the page, its order, or a
 * previous collection lets a caller guess or replay one.
 */
export function mintTargetHandle(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `t_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

type LiveElement = {
  tagName?: string;
  type?: string;
  href?: string;
  autocomplete?: string;
  name?: string;
  hidden?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
  getAttribute?: (name: string) => string | null;
  hasAttribute?: (name: string) => boolean;
  matches?: (selector: string) => boolean;
  checkVisibility?: (options?: Record<string, boolean>) => boolean;
  /** The owner form (IDL `form`): an element, `null` for none, absent on elements that have no such property. */
  form?: LiveForm | null;
};

type LiveForm = {
  elements?: ArrayLike<{ tagName?: string; type?: string }>;
  querySelector?: (selector: string) => unknown;
  ownerDocument?: { querySelectorAll?: (selector: string) => ArrayLike<{ form?: unknown }> } | null;
};

/**
 * Input types whose Enter triggers implicit submission when they are the form's only such field
 * (HTML "field that blocks implicit submission").
 */
const IMPLICIT_SUBMISSION_BLOCKERS = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "date",
  "month",
  "week",
  "time",
  "datetime-local",
  "number",
]);

/**
 * The two facts about a form the submission guard decides on. Read from the live form, not from any
 * request: whether it can be submitted by a button, and how many fields would let Enter submit it
 * implicitly. Returns undefined when the form cannot be inspected, which the guard treats as unknown.
 */
function readOwnerForm(form: LiveForm): LiveTargetDescriptor["form"] {
  // `HTMLFormElement` lets a control named `elements` shadow the collection: what comes back is
  // then an element, not a list. A form whose controls cannot be listed is unknown to the guard. A
  // `<select name="elements">` shadows it too yet has a numeric `length`; it then reads as a list
  // with no blockers, and the guard's own rule (no affordance, at most one blocker: refuse) is what
  // fails closed for it.
  const elements = form.elements;
  if (!elements || typeof elements.length !== "number") {
    return undefined;
  }
  let hasSubmitAffordance = false;
  let implicitSubmissionBlockers = 0;
  for (let index = 0; index < elements.length; index += 1) {
    const control = elements[index];
    const tag = (control?.tagName ?? "").toUpperCase();
    const type = (control?.type ?? "").toLowerCase();
    if (tag === "BUTTON" && (type === "" || type === "submit")) hasSubmitAffordance = true;
    if (tag === "INPUT" && (type === "submit" || type === "image")) hasSubmitAffordance = true;
    if (tag === "INPUT" && IMPLICIT_SUBMISSION_BLOCKERS.has(type || "text")) implicitSubmissionBlockers += 1;
  }
  if (!hasSubmitAffordance) {
    hasSubmitAffordance = ownsImageButton(form);
  }
  return { hasSubmitAffordance, implicitSubmissionBlockers };
}

/**
 * Image buttons are not listed in `form.elements`, and one tied to the form through its `form`
 * attribute need not be a descendant either. Ownership is what makes a button submit this form, so
 * ask every image button in the document which form owns it; the subtree is only a fallback for a
 * document that cannot be asked.
 */
function ownsImageButton(form: LiveForm): boolean {
  const document = form.ownerDocument;
  if (document && typeof document.querySelectorAll === "function") {
    try {
      const images = document.querySelectorAll('input[type="image"]');
      for (let index = 0; index < images.length; index += 1) {
        if (images[index]?.form === form) return true;
      }
      return false;
    } catch {
      // A selector the engine rejects tells us nothing about the form; try the subtree.
    }
  }
  if (typeof form.querySelector === "function") {
    try {
      return form.querySelector('input[type="image"]') !== null;
    } catch {
      // Same: nothing learned.
    }
  }
  return false;
}

/**
 * Whether the browser reports the element as genuinely rendered. A browser that does not understand
 * one of the newer options ignores it rather than throwing, and a browser without the method at all
 * never reaches here; either way the attribute checks stay the floor, so this can only make the
 * visibility test stricter, never weaker.
 */
function isRendered(element: LiveElement): boolean {
  try {
    return (
      element.checkVisibility?.({
        checkVisibilityCSS: true,
        visibilityProperty: true,
        opacityProperty: true,
        contentVisibilityAuto: true,
      }) ?? true
    );
  } catch {
    // An older engine that rejects the options object tells us nothing, so it does not get to
    // report the element as hidden on its own.
    return true;
  }
}

/** The parts of an element a rendering check reads; kept structural so a fake DOM can answer it. */
type RenderableElement = {
  checkVisibility?: (options?: Record<string, boolean>) => boolean;
  getClientRects?: () => { length: number };
  parentElement?: unknown;
  ownerDocument?: {
    defaultView?: {
      getComputedStyle?: (element: unknown) => { display?: string; visibility?: string } | null;
    } | null;
  } | null;
};

/**
 * Whether the element is genuinely on the page - the test a *naming* decision needs (003/C2).
 *
 * `isRendered` above is the floor the effect executors apply, and it is what a browser answers
 * best: `checkVisibility` already walks the ancestor chain for `display:none`, `visibility:hidden`
 * and the rest. Where it exists, the one thing it cannot say is that an element has no box at all,
 * so the client rects are asked for as well. Where it does not exist - a DOM without layout - the
 * ancestor chain's own computed styles are read instead, because a control inside a hidden
 * container is not something anyone can act on and offering a handle for it would say they can.
 *
 * A `false` from `checkVisibility` is final; no layout measurement overturns it (004/T164). It was
 * once suspected of answering from paint - reporting every element of a backgrounded tab as
 * unrendered - and a bounding-box fallback was added on that theory. Measured on Chrome 152 over a
 * raw DevTools session (no focus emulation), a backgrounded tab with `document.visibilityState ===
 * "hidden"` still answers `checkVisibility() === true` for a boxed control; the `false` that was
 * seen came from the page's own responsive CSS (`display:none` below a viewport breakpoint), and
 * every ancestor-hidden element measures the same way. The fallback, meanwhile, made a
 * `visibility:hidden` or `opacity:0` control - which keeps its box - count as rendered, so it was
 * a regression against the rule this function exists for, and it is gone.
 */
export function isElementRendered(node: unknown): boolean {
  const element = node as RenderableElement | undefined;
  if (!element || typeof element !== "object") return false;
  if (typeof element.checkVisibility === "function") {
    if (!isRendered(element as LiveElement)) return false;
    try {
      return (element.getClientRects?.().length ?? 1) > 0;
    } catch {
      // An engine that will not measure tells us nothing; the visibility answer above stands.
      return true;
    }
  }
  const view = element.ownerDocument?.defaultView;
  if (typeof view?.getComputedStyle !== "function") return true;
  let current: unknown = element;
  let steps = 0;
  while (current && steps < 64) {
    let style: { display?: string; visibility?: string } | null | undefined;
    try {
      style = view.getComputedStyle(current);
    } catch {
      return true;
    }
    if (style?.display === "none") return false;
    if (style?.visibility === "hidden" || style?.visibility === "collapse") return false;
    current = (current as { parentElement?: unknown }).parentElement;
    steps += 1;
  }
  return true;
}

/**
 * Re-derives a target descriptor from the element as it is right now. Classification immediately
 * before an effect must never rely on metadata captured at collection time, nor on anything a
 * caller supplied.
 */
export function readLiveTarget(node: unknown): LiveTargetDescriptor | undefined {
  const element = node as LiveElement | undefined;
  const tagName = element?.tagName?.toUpperCase();
  if (!tagName) {
    return undefined;
  }
  // Prefer the IDL property, fall back to the attribute: a page can mutate either one.
  const attribute = (name: string): string | undefined =>
    element?.getAttribute?.(name) ?? undefined;
  const hasAttribute = (name: string): boolean =>
    typeof element?.hasAttribute === "function"
      ? element.hasAttribute(name)
      : (element?.getAttribute?.(name) ?? null) !== null;
  const matches = (selector: string): boolean => {
    try {
      return typeof element?.matches === "function" && element.matches(selector);
    } catch {
      return false;
    }
  };
  const type = element?.type ?? attribute("type");
  const href = element?.href ?? attribute("href");
  const autocomplete = element?.autocomplete || attribute("autocomplete");
  const explicitRole = attribute("role");
  const name = element?.name || attribute("name");
  const hidden =
    element?.hidden === true ||
    hasAttribute("hidden") ||
    attribute("aria-hidden") === "true" ||
    // Chrome reports display:none / visibility:hidden / content-visibility:hidden through
    // `checkVisibility`; an engine without it is asked about the ancestor chain's own styles
    // instead (003/C2). `opacityProperty` and `contentVisibilityAuto` are asked for as well: an
    // element at zero opacity or skipped by content-visibility is not something a user can see, and
    // treating it as visible would let an effect land on a control that is not really on screen.
    !isElementRendered(element);
  const readOnly = element?.readOnly === true || hasAttribute("readonly");
  const disabled = element?.disabled === true || hasAttribute("disabled") || matches(":disabled");
  const formAction = attribute("formaction");
  const formAttr = attribute("form");
  const formTarget = attribute("formtarget") ?? attribute("target");
  const download = attribute("download");
  const owner = element?.form;
  const form = owner === null ? null : owner ? readOwnerForm(owner) : undefined;
  return {
    tagName,
    ...(type ? { type: type.toLowerCase() } : {}),
    ...(href ? { href } : {}),
    ...(autocomplete ? { autocomplete: autocomplete.toLowerCase() } : {}),
    ...(explicitRole ? { role: explicitRole } : {}),
    ...(name ? { name } : {}),
    ...(hidden ? { hidden: true } : {}),
    ...(readOnly ? { readOnly: true } : {}),
    ...(disabled ? { disabled: true } : {}),
    ...(formAction !== undefined ? { formAction } : {}),
    ...(formAttr !== undefined ? { formAttr } : {}),
    ...(formTarget !== undefined ? { formTarget } : {}),
    ...(download !== undefined ? { download } : {}),
    ...(form !== undefined ? { form } : {}),
  };
}

/**
 * What a record keeps between collections. The element is deliberately not part of it: it lives in
 * the `ElementRegistry` behind a `WeakRef`, so remembering an element's name never keeps the
 * element itself alive (004/R-115).
 */
type StoredRecord = Omit<TargetRecord, "element"> & { bound: boolean };

export class TargetRegistry {
  private readonly handles = new Map<string, StoredRecord>();
  /**
   * The document's persistent element register (004/US6, R-115). It is what makes a handle a name
   * for an *element* rather than for a moment in a read: it survives every collection and dies
   * only with the document, which is what `invalidate` marks.
   */
  private elements = new ElementRegistry();

  /**
   * The name this document has for an element - minted the first time it is seen and the same one
   * every collection afterwards. Callers that hand out handles ask for it here rather than minting
   * their own, so one element never accumulates two names.
   */
  handleFor(element: unknown): string {
    return this.elements.register(element).handle;
  }

  /** The register's own index for a handle, or nothing once the entry has been pruned. */
  indexOf(targetHandle: string): number | undefined {
    return this.elements.entryOfHandle(targetHandle)?.index;
  }

  issue(record: TargetRecord): string {
    const { element, ...rest } = record;
    // The element goes into the register, never into the record: the record is metadata this
    // collection wrote, and the element is held weakly beside it for as long as the page holds it.
    if (element !== undefined && element !== null) this.elements.bind(record.targetHandle, element);
    this.handles.set(record.targetHandle, { ...rest, bound: element !== undefined && element !== null });
    return record.targetHandle;
  }

  resolve(targetHandle: string, documentEpoch: string): TargetRecord | undefined {
    const record = this.handles.get(targetHandle);
    if (!record || record.documentEpoch !== documentEpoch) {
      return undefined;
    }
    return this.materialize(record);
  }

  /**
   * The document this registry belongs to is gone: every name it minted goes with it, and the next
   * document starts a register of its own (R-115, "it dies with the document").
   */
  invalidate(): void {
    this.handles.clear();
    this.elements = new ElementRegistry();
  }

  /**
   * Retires the names of elements the page no longer holds, and keeps every other one.
   *
   * This is what a collection does now instead of clearing the registry (003's per-read
   * replacement, 004/FR-066): a reference an agent was given on an earlier read still names its
   * element, and only an element that has actually left the document loses its name.
   */
  prune(): void {
    this.elements.prune();
    for (const [handle, record] of this.handles) {
      if (record.bound && this.elements.entryOfHandle(handle) === undefined) this.handles.delete(handle);
    }
  }

  /** Every handle this document holds, in the order the elements were first named. */
  records(documentEpoch: string): TargetRecord[] {
    const records: TargetRecord[] = [];
    for (const record of this.handles.values()) {
      if (record.documentEpoch !== documentEpoch) continue;
      records.push(this.materialize(record));
    }
    return records;
  }

  /** Puts the live element back beside the record the collection wrote. */
  private materialize(record: StoredRecord): TargetRecord {
    const { bound, ...rest } = record;
    const element = bound ? this.elements.elementOf(record.targetHandle) : undefined;
    return { ...rest, ...(element === undefined ? {} : { element }) };
  }
}

function stillShown(record: TargetRecord): boolean {
  const element = record.element as { isConnected?: unknown } | undefined;
  if (!element) return true;
  if (element.isConnected === false) return false;
  const live = readLiveTarget(element);
  return live === undefined || live.hidden !== true;
}

/**
 * 002/FR-027, R-024. Decides one wait condition against the live element behind a handle the worker
 * already holds, and answers with one boolean.
 *
 * Everything it observes stays on this side of the channel. The four conditions are exactly what
 * this runtime can decide locally about one element - shown, not shown, usable, its own text
 * changed - and each is re-read from the live node, never from what the collection recorded, for
 * the same reason effect-time classification is. A handle this document never minted is refused
 * rather than answered `false`: nothing was observed, and a wait told "not yet" would sit out its
 * whole bound on a target that was never there.
 */
export function evaluateCondition(
  registry: TargetRegistry,
  documentEpoch: string,
  targetHandle: string,
  condition: WaitCondition,
): ContentEvaluateConditionReply {
  const record = registry.resolve(targetHandle, documentEpoch);
  if (!record) return { ok: false, reason: "stale-target" };
  const shown = stillShown(record);
  if (condition === "present") return { ok: true, holds: shown };
  if (condition === "absent") return { ok: true, holds: !shown };
  if (condition === "enabled") {
    if (!shown) return { ok: true, holds: false };
    const live = readLiveTarget(record.element);
    return { ok: true, holds: live?.disabled !== true };
  }
  // Text nobody can see has not visibly changed, whatever the node now contains.
  if (!shown) return { ok: true, holds: false };
  const element = record.element as { textContent?: unknown } | undefined;
  const current =
    typeof element?.textContent === "string" ? element.textContent.trim().slice(0, WAIT_TEXT_BASELINE_CHARS) : "";
  return { ok: true, holds: current !== (record.visibleText ?? "") };
}

/** One matched record, kept alongside what ranking and ancestor-collapsing need to decide (004/T128, B65). */
type DescribedMatch = {
  targetHandle: string;
  /** Whether the shown name *is* the description, not merely a superset of it. */
  exact: boolean;
  element: unknown;
};

/** The description and a shown name, folded the same way for an exact comparison: trimmed, one space, lower case. */
function normalizedName(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Whether the label or the button text this match was made on *is* the description, not just contains it. */
function isExactNameMatch(description: string, record: TargetRecord): boolean {
  const wanted = normalizedName(description);
  if (wanted.length === 0) return false;
  return normalizedName(record.label) === wanted || normalizedName(record.text) === wanted;
}

/** Whether `container` is a strict DOM ancestor of `descendant` - never true of an element and itself. */
function isStrictAncestor(container: unknown, descendant: unknown): boolean {
  if (container === descendant) return false;
  const node = container as { contains?: (other: unknown) => boolean } | undefined;
  if (!node || typeof node.contains !== "function") return false;
  try {
    return node.contains(descendant);
  } catch {
    // An engine that will not answer `contains` tells us nothing; the two stay unrelated.
    return false;
  }
}

/**
 * Collapses matches whose elements are literally nested inside one another (004/T128, B65): a
 * container's accessible name concatenates every descendant's, so it names anything its descendants
 * do, and a match on it beside a match on the descendant it contains is one element on the page
 * described three ways, not distinct choices for the agent. Only a match that is a *strict ancestor
 * of another match* is dropped, so two genuinely distinct elements - neither containing the other -
 * are left exactly as `too-broad` already treats them (002/FR-026); this never turns a real choice
 * into a refusal, and never turns a refusal into a choice.
 */
function collapseAncestorChains(matches: readonly DescribedMatch[]): DescribedMatch[] {
  return matches.filter(
    (candidate) => !matches.some((other) => isStrictAncestor(candidate.element, other.element)),
  );
}

/**
 * 004/T152 (S4 review). `collapseAncestorChains` is an all-pairs `contains` walk - O(matched^2) DOM
 * calls, on the owner's own page thread, once per `find`, once per frame. T137 raised the
 * collection's own ceiling from 200 to `AGENT_READ_PAGE_MAX_NODES` (10,000) so `find` could reach a
 * shadow-only control past the old default; the cost this bounds is what that made possible - a
 * broad description now reaching thousands of textual matches before the too-broad bound is even
 * consulted. Past this many matches the description is too broad on any real page regardless of how
 * it collapses (nesting this deep is not an ordinary page), so the quadratic walk is skipped and the
 * outcome decided directly - the same answer collapsing would reach, at a cost this bounds instead
 * of paying.
 */
const ANCESTOR_COLLAPSE_CEILING = 256;

/**
 * 002/FR-026, R-025. Resolves a description against the handles the last collection minted for the
 * bound document, and answers with exactly one of three outcomes.
 *
 * What this side owns is liveness and the bound: which handles the document still shows, and when
 * the answer stops being a choice. Whether a description names one of them is a language policy and
 * belongs to `matchDescription` in `@hallpass/domain`, which is given only what a review card would show
 * - the label, a button's text, and the control's role - so nothing is read from the page that the
 * user would not see on a card, and form values are never touched. More matches than the bound is
 * too broad: the product stops choosing and says so, rather than returning a truncated list or
 * picking one.
 *
 * Two more things happen before the bound is even asked (004/T128, B65). Nested matches collapse to
 * one - a container's name contains every descendant's, so a submenu link and its own `<li>` are one
 * element, not two choices, and it is the count *after* collapsing that the bound judges. And what
 * is left is ordered so a name that *is* the description outranks one that merely contains it: a
 * caller taking the first match gets the control, not whichever ancestor the collection walked to
 * first.
 */
export function resolveDescription(
  registry: TargetRegistry,
  documentEpoch: string,
  description: string,
  maxCandidates: number,
): ContentResolutionReply {
  const matched: DescribedMatch[] = [];
  for (const record of registry.records(documentEpoch)) {
    if (!stillShown(record)) continue;
    // The wait baseline (`visibleText`) is deliberately not offered: it is not a name.
    if (!matchDescription(description, { role: record.role, label: record.label, text: record.text })) {
      continue;
    }
    matched.push({
      targetHandle: record.targetHandle,
      exact: isExactNameMatch(description, record),
      element: record.element,
    });
  }
  if (matched.length > ANCESTOR_COLLAPSE_CEILING) return { ok: true, outcome: "too-broad" };
  const distinct = collapseAncestorChains(matched);
  // Stable: an exact name first, the rest in the order the collection walked them.
  distinct.sort((a, b) => Number(b.exact) - Number(a.exact));
  if (distinct.length === 0) return { ok: true, outcome: "no-match" };
  if (distinct.length > maxCandidates) return { ok: true, outcome: "too-broad" };
  // The handle alone. The label and the role this match was made on stay here: the worker names
  // the element from the metadata it minted, never from what the page says about it now.
  return { ok: true, outcome: "resolved", candidates: distinct.map((match) => ({ targetHandle: match.targetHandle })) };
}

/**
 * 003/US3 decision 2. Mints a handle for one element the caller found some other way - what is at a
 * point, or what has focus - and answers in the same shape a description resolution does.
 *
 * The whole reason it goes through the registry is *lifetime*. A coordinate and "the focused
 * element" are both moments in time; a handle is bound to this document's epoch and is invalidated
 * by the same navigation that invalidates every other handle. Turning both into handles before
 * anything acts on them means there is one definition of stale in the system rather than three,
 * and an effect can never be aimed at a point whose meaning has since changed underneath it.
 *
 * Nothing about the element travels back: the handle alone, exactly as `resolveDescription` answers.
 */
export function registerLiveElement(
  registry: TargetRegistry,
  documentEpoch: string,
  element: unknown,
): ContentResolutionReply {
  const live = readLiveTarget(element);
  if (!live) return { ok: true, outcome: "no-match" };
  // The register's name for this element, not a new one: a point or the focused element may well
  // be an element an earlier read already named, and two names for one element would be two
  // lifetimes for it (004/R-115).
  const targetHandle = registry.handleFor(element);
  const text = typeof (element as { textContent?: unknown }).textContent === "string"
    ? (element as { textContent: string }).textContent.trim().slice(0, 200)
    : undefined;
  registry.issue({
    targetHandle,
    // Not from a collection, and said so: nothing may treat this handle as part of a snapshot the
    // owner was shown.
    snapshotId: `live-${documentEpoch}`,
    documentEpoch,
    role: live.role ?? live.tagName.toLowerCase(),
    ...(live.name ? { label: live.name } : {}),
    ...(text ? { text } : {}),
    visibleText: text ?? "",
    element,
    target: {
      tagName: live.tagName,
      ...(live.type ? { type: live.type } : {}),
      ...(live.href ? { href: live.href } : {}),
      ...(live.autocomplete ? { autocomplete: live.autocomplete } : {}),
      ...(live.role ? { role: live.role } : {}),
    },
  });
  return { ok: true, outcome: "resolved", candidates: [{ targetHandle }] };
}
