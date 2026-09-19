/**
 * What a form control holds right now, as the owner sees it (005/US1, FR-072..FR-074, R-122).
 *
 * Pure over an element, so the collector can spread its answer into a node the same way it spreads
 * `type` and `options`, and so the rule can be tested on a jsdom table with no collection at all.
 * Two exports because they are two decisions made at two times: `isRedactedField` is asked *before*
 * the control's value is taken into an answer, and `fieldState` carries a value only where the
 * predicate let it through. A redacted field's text is looked at for one bit - is there anything
 * in it (FR-073 says an empty one carries nothing) - and discarded on the spot; it never reaches a
 * node, a bound, or a message.
 */

/**
 * The autocomplete tokens that name a secret (FR-073): a current or new password, a one-time code,
 * a payment card's number, security code and expiry in each of the browser's spellings. Matched as
 * whole tokens of the space-separated list, case-insensitively, so `section-billing CC-Number` is
 * caught and `cc-name` - a cardholder's name, which is not a secret - is not.
 */
const REDACTED_AUTOCOMPLETE_TOKENS = new Set([
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
]);

/** Input types whose value is a button's caption or a file path, never something the owner typed. */
const VALUELESS_INPUT_TYPES = new Set(["submit", "button", "reset", "image", "file"]);

export type FieldState = {
  value?: string;
  checked?: boolean;
  redacted?: boolean;
  valueTruncated?: boolean;
};

/** The shape read from an element; every member optional because the walk hands over `unknown`. */
type FieldElement = {
  tagName?: string;
  type?: string;
  value?: string;
  checked?: boolean;
  getAttribute?: (name: string) => string | null;
  selectedOptions?: ArrayLike<{ textContent?: string | null; label?: string }>;
};

function asFieldElement(el: unknown): FieldElement | undefined {
  if (!el || typeof el !== "object") return undefined;
  return el as FieldElement;
}

/**
 * Whether the control's value must never be reported (FR-073, D-005-1).
 *
 * The `type` is read through the attribute as well as the property so a spelling the DOM
 * normalises (`PASSWORD`) and one it does not both count. `hidden` is here for completeness - the
 * walk never offers a hidden input - so the predicate is true of the field and not of the walk.
 */
export function isRedactedField(el: unknown): boolean {
  const element = asFieldElement(el);
  if (!element) return false;
  const tagName = (element.tagName ?? "").toUpperCase();
  if (tagName !== "INPUT" && tagName !== "TEXTAREA" && tagName !== "SELECT") return false;
  if (tagName === "INPUT") {
    const type = (element.getAttribute?.("type") ?? element.type ?? "").toLowerCase();
    if (type === "password" || type === "hidden") return true;
  }
  const autocomplete = element.getAttribute?.("autocomplete") ?? "";
  return autocomplete
    .toLowerCase()
    .split(/\s+/)
    .some((token) => REDACTED_AUTOCOMPLETE_TOKENS.has(token));
}

/**
 * The control's current state, bounded (FR-072, FR-074).
 *
 * An empty answer is the normal one: an element that is not a field, a text entry with nothing in
 * it, a select showing nothing, an empty password - all say nothing, so the node reads exactly as
 * it did before the field joined it. A toggle always answers, because `checked: false` is a fact
 * the agent acts on and "no field" would be read as "not a toggle".
 */
export function fieldState(el: unknown, bound: number): FieldState {
  const element = asFieldElement(el);
  if (!element) return {};
  const tagName = (element.tagName ?? "").toUpperCase();
  if (tagName === "SELECT") {
    const selected = element.selectedOptions ? Array.from(element.selectedOptions) : [];
    if (selected.length === 0) return {};
    if (isRedactedField(element)) return { redacted: true };
    return bounded(selected.map((option) => (option.label || option.textContent || "").trim()).join(", "), bound);
  }
  if (tagName === "TEXTAREA") {
    if (isRedactedField(element)) return redactedState(element);
    return bounded(element.value ?? "", bound);
  }
  if (tagName !== "INPUT") return {};
  const type = (element.type ?? "text").toLowerCase();
  if (type === "checkbox" || type === "radio") return { checked: element.checked === true };
  if (VALUELESS_INPUT_TYPES.has(type)) return {};
  // The predicate first, on purpose: a redacted field's value never reaches `bounded` (R-122).
  if (isRedactedField(element)) return redactedState(element);
  return bounded(element.value ?? "", bound);
}

/** Filled or empty is the only thing a redacted field says; the text itself is dropped here. */
function redactedState(element: FieldElement): FieldState {
  return (element.value ?? "").length > 0 ? { redacted: true } : {};
}

/** The value at the label bound; a cut is said, not silent (FR-074). Line breaks are kept as-is. */
function bounded(value: string, bound: number): FieldState {
  if (value.length === 0) return {};
  if (value.length <= bound) return { value };
  return { value: value.slice(0, bound), valueTruncated: true };
}
