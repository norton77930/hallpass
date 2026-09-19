/**
 * The one attribute that says "this element is the extension's, not the page's" (004 FR-062).
 *
 * It lives in its own module because two sides need the same word and neither should pull the
 * other in: the indicator writes it, and the collector reads it to walk past everything wearing it.
 * A collector that imported the indicator would carry the agent build's DOM code into the narrow
 * artefact, which is the one thing 004 promised not to do (SC-038).
 */
export const INDICATOR_MARKER_ATTRIBUTE = "data-hallpass-indicator";
