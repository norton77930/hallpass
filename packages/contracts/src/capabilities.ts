/**
 * The seven effects the shared content runtime inherited from 001/002, kept because the runtime's
 * own vocabulary and its refusal reasons are keyed off them. The capability set that wrapped them —
 * `BRIDGE_CAPABILITIES`, `page.resolve`, `page.wait` — belonged to the archived remote path and went
 * with it (009/T245).
 */
export const BRIDGE_ACTIONS = [
  "browser.scroll",
  "browser.click",
  "browser.enter-text",
  "browser.key-press",
  "browser.hover",
  "browser.double-click",
  "browser.drag",
] as const;

/**
 * Every effect the shared content runtime can deliver, which is a superset of what the *remote*
 * caller may ask for (003/US3 decision 4).
 *
 * `browser.right-click` and `browser.triple-click` are two more pointer sequences the page's own
 * handlers see - no browser default action, so no native context menu opens and nothing is selected
 * by the browser itself. `browser.form-input` sets one control to a stated value, which a text
 * entry cannot express for a checkbox or a `<select>`: entering text says "type this", and setting a
 * control says "make it this", and only the second is idempotent enough for an agent to rely on.
 *
 * All three exist for the local agent and are deliberately not in `BRIDGE_ACTIONS`: that list is the
 * archived 001/002 closed action set, kept as the runtime's inherited vocabulary rather than widened.
 */
export const RUNTIME_ACTIONS = [
  ...BRIDGE_ACTIONS,
  "browser.right-click",
  "browser.triple-click",
  "browser.form-input",
] as const;

export type RuntimeAction = (typeof RUNTIME_ACTIONS)[number];

export const PAGE_READ_DATA_CATEGORIES = [
  "page.canonical-origin",
  "page.title",
  "page.visible-text",
  "page.structure",
  "page.selection",
  "page.target-metadata",
  "page.form-values",
] as const;
