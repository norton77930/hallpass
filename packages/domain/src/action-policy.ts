import { KEY_PRESS_KEYS, KEY_PRESS_MODIFIERS, type ActionRisk } from "@hallpass/contracts";
import { classifyFormControl, type FormControlSnapshot } from "./form-value-policy.js";

export type ActionDecision = "allow" | "deny";

/**
 * The effect-time view of a target. Every field is optional because a caller may only know part of
 * it; anything not established fails closed where the rule needs it.
 */
export type ActionTarget = {
  tagName?: string;
  href?: string;
  type?: string;
  role?: string;
  autocomplete?: string;
  name?: string;
  hidden?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
  formAction?: string;
  formAttr?: string;
  formTarget?: string;
  download?: string;
  /**
   * The owner form's two facts the submission guard needs (002/FR-024, R-022): whether it has a
   * submit affordance, and how many of its fields block implicit submission. `null` means the
   * element has no owner form; `undefined` means the fact was not established, which fails closed.
   */
  form?: { hasSubmitAffordance: boolean; implicitSubmissionBlockers: number } | null;
};

/** Tags that are never a click target in hallpass-v1: they navigate, submit, select, or delegate. */
const NON_CLICK_TAGS = new Set(["a", "area", "form", "option", "select", "label", "iframe", "object", "embed"]);

/**
 * Only a locally classifiable low-risk, non-navigation, non-submitting control may be activated
 * (task-channel.md "browser.click eligibility"). Anything that can submit a form, carry a URL or
 * form association, open a target, download, or that is not rendered/enabled is denied.
 */
export function classifyClick(target: ActionTarget): ActionDecision {
  const tag = (target.tagName ?? "").toLowerCase();
  if (tag.length === 0 || NON_CLICK_TAGS.has(tag) || target.href) {
    return "deny";
  }
  const type = (target.type ?? "").toLowerCase();
  if (type === "submit" || type === "file" || type === "reset" || type === "image") {
    return "deny";
  }
  if (tag === "button" && type !== "button") {
    // A button without an explicit type is a submit button inside a form.
    return "deny";
  }
  if (target.role === "link") {
    return "deny";
  }
  if (
    target.formAction !== undefined ||
    target.formAttr !== undefined ||
    target.formTarget !== undefined ||
    target.download !== undefined
  ) {
    return "deny";
  }
  if (target.hidden || target.disabled) {
    return "deny";
  }
  return "allow";
}

/**
 * Mirrors the collection-time sensitivity filter so an element mutated after its handle was
 * minted cannot receive text it would never have been offered for.
 */
const SENSITIVE_AUTOCOMPLETE = /password|one-time-code|cc-|credit-card|card-number|cvc|cvv/;

/**
 * Text may enter only a rendered, enabled, writable input or textarea that the closed form-value
 * policy conclusively classifies as ordinary (FR-004/FR-005). The same allow-list that decides what
 * a page read may disclose decides what the assistant may type into; an unnamed, unlisted,
 * sensitive, or ambiguous control fails closed, as does anything that is not a text control.
 */
export function classifyTextEntry(target: ActionTarget): ActionDecision {
  const tag = (target.tagName ?? "").toLowerCase();
  const type = (target.type ?? "").toLowerCase();
  const autocomplete = (target.autocomplete ?? "").toLowerCase();
  if (type === "password" || type === "file" || type === "hidden") {
    return "deny";
  }
  if (SENSITIVE_AUTOCOMPLETE.test(autocomplete)) {
    return "deny";
  }
  if (target.hidden || target.readOnly || target.disabled) {
    return "deny";
  }
  if (tag !== "input" && tag !== "textarea") {
    // Buttons, selects, and contenteditable regions are never text targets; the last carries no
    // name the closed policy could classify, so it fails closed with the rest.
    return "deny";
  }
  const control: FormControlSnapshot = {
    kind: tag === "textarea" ? "textarea" : "input",
    ...(tag === "input" ? { type: type || "text" } : {}),
    ...(target.name ? { name: target.name } : {}),
    ...(autocomplete ? { autocomplete } : {}),
  };
  return classifyFormControl(control) === "allowed-ordinary" ? "allow" : "deny";
}

export type KeyPressDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: "target" | "submission" | "key" };

/**
 * Whether a key may be pressed on this target (002/FR-024, R-022).
 *
 * Three gates, in order. The key must be in the named set, with `Shift` only beside `Tab`. The target
 * must pass the same text-entry classification the page read already trusts: sensitive, unnamed,
 * hidden, read-only, disabled and non-text controls are refused, so a key can never reach a field
 * text could not. And the confirmation key is refused wherever its default effect would submit a form
 * or navigate - which 001/FR-005 forbids and FR-028 preserves - or where that cannot be established.
 *
 * The submission rule follows the browser's own: a textarea's Enter is a newline; an input with no
 * owner form has nothing to submit; an input whose form has a submit button submits; an input whose
 * form has none submits implicitly only when it is the single field that blocks implicit submission.
 * A page's script may intercept Enter before any of that happens, but that is not locally decidable,
 * so it earns no allowance.
 */
export function classifyKeyPress(
  target: ActionTarget,
  key: string,
  modifiers: readonly string[] = [],
): KeyPressDecision {
  if (!(KEY_PRESS_KEYS as readonly string[]).includes(key)) {
    return { decision: "deny", reason: "key" };
  }
  if (modifiers.length > 0) {
    if (modifiers.some((modifier) => !(KEY_PRESS_MODIFIERS as readonly string[]).includes(modifier)) || key !== "Tab") {
      return { decision: "deny", reason: "key" };
    }
  }
  if (classifyTextEntry(target) === "deny") {
    return { decision: "deny", reason: "target" };
  }
  if (key !== "Enter") {
    return { decision: "allow" };
  }
  if ((target.tagName ?? "").toLowerCase() === "textarea") {
    return { decision: "allow" };
  }
  const form = target.form;
  if (form === undefined) {
    return { decision: "deny", reason: "submission" };
  }
  if (form === null) {
    return { decision: "allow" };
  }
  if (form.hasSubmitAffordance || form.implicitSubmissionBlockers <= 1) {
    return { decision: "deny", reason: "submission" };
  }
  return { decision: "allow" };
}

/**
 * A drag has two endpoints and each is classified as a click target is (002/FR-025, R-023): the
 * stricter decides, and an endpoint that cannot be classified refuses the whole request.
 */
export function classifyDrag(start: ActionTarget, end: ActionTarget): ActionDecision {
  return classifyClick(start) === "allow" && classifyClick(end) === "allow" ? "allow" : "deny";
}

/** The bounded target kinds the worker keeps in memory for a review (D1: role, label, kind). */
export type TargetKind = "button" | "text-input" | "combobox" | "other";

/** The part of a target a review-time kind establishes; anything it cannot establish stays unset. */
const KIND_TARGETS: Record<TargetKind, ActionTarget> = {
  button: { tagName: "button", type: "button" },
  "text-input": { tagName: "input", type: "text" },
  combobox: { tagName: "select" },
  other: {},
};

/**
 * The risk label shown on a consent or Plan card, decided locally from the capability and the
 * bounded target metadata the worker holds. It is a review-time projection, never an authorization:
 * `classifyClick` and `classifyTextEntry` still re-read the live element immediately before the
 * effect and remain the conclusive gates.
 *
 * Clicks run through `classifyClick` on the target the kind establishes. Text entry cannot: the
 * ordinary/sensitive decision needs the live control's name and type, which the worker deliberately
 * does not keep, so the label states only that text would be entered into a text control and an
 * unclassifiable kind reports `unclassified` rather than something reassuring.
 */
export function classifyActionRisk(input: {
  /**
   * Any capability, not only the ones this function knows. Both callers narrow with `isBridgeAction`
   * first today; the parameter stays open so that the fail-safe below - an unknown capability is
   * `unclassified`, never the label of the branch it happened to reach - is a property of this
   * function and not of its callers.
   */
  capability: string;
  targetKind?: TargetKind;
  /** A drag's drop target; absent for every other capability, and unclassifiable when unknown. */
  secondTargetKind?: TargetKind;
}): ActionRisk {
  if (input.capability === "browser.scroll") {
    // Scrolling changes what is shown and can neither activate a control nor enter text.
    return "view-only";
  }
  if (input.capability === "browser.enter-text") {
    return input.targetKind === "text-input" ? "text-entry" : "unclassified";
  }
  if (input.capability === "browser.key-press") {
    // R-023: a key can commit a value, so it is an activation - and only of a text control, which is
    // the one kind the effect-time policy will let a key reach.
    return input.targetKind === "text-input" ? "activation" : "unclassified";
  }
  const target = input.targetKind ? KIND_TARGETS[input.targetKind] : undefined;
  const targetClassifies = target !== undefined && classifyClick(target) === "allow";
  if (input.capability === "browser.click") {
    return targetClassifies ? "activation" : "unclassified";
  }
  if (input.capability === "browser.hover") {
    // R-023: a hover can neither activate a control nor enter text, so it is view-only - on a target
    // the click classification accepts. Anything else is unclassified, exactly as for a click.
    return targetClassifies ? "view-only" : "unclassified";
  }
  if (input.capability === "browser.double-click") {
    return targetClassifies ? "activation" : "unclassified";
  }
  if (input.capability === "browser.drag") {
    // Both endpoints, and the stricter decides: a drop target that is missing or cannot be
    // classified is not "probably fine", it is unclassified.
    const drop = input.secondTargetKind ? KIND_TARGETS[input.secondTargetKind] : undefined;
    return targetClassifies && drop !== undefined && classifyClick(drop) === "allow" ? "activation" : "unclassified";
  }
  // A capability with no risk case of its own is unclassified, never the label of the branch it
  // happened to reach. `activation` on a card is a claim the product has judged this effect; a
  // capability nobody has classified has not been judged at all.
  return "unclassified";
}
