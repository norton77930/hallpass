/**
 * What the worker's ports share, whichever path opens them.
 *
 * Both values were written for the archived control port and are used by the agent path too - the
 * agent panel port applies the same sender check, and the agent's `wait` samples at the same
 * interval. They live here so that the control port's removal takes only the control port with it.
 */

/**
 * How often a wait asks the page whether its condition holds yet (002/FR-027).
 *
 * An implementation constant, not a product bound: the bound a wait carries is the protocol's
 * `maxWaitMs`, and this only decides how finely the interval up to it is sampled. It is a
 * configuration input for the same reason the settle window is - a test needs a tighter one - and a
 * value either side of it changes how promptly a run continues, never whether it terminates. It is
 * recorded under A-010 beside the settle window, in 001's `contracts/extension-runtime.md`.
 *
 * One poll is bounded by the page port's own ten-second deadline, which is above `maxWaitMs`
 * (15 000 ms) only in the sense that a single silent poll could outlast the whole wait. It cannot:
 * the wait's bound runs on the worker's own timer, so a poll that never comes back ends the wait at
 * the bound and its late reply is ignored.
 */
export const DEFAULT_WAIT_POLL_MS = 250;

/**
 * Whether a connecting port really is this extension's own side panel: a Port can be opened by any
 * page or extension that knows the id, so "the panel" is proven rather than assumed.
 */
export function isTrustedControlSender(
  sender: chrome.runtime.MessageSender | undefined,
  extensionId: string,
  sidePanelUrl: string,
): boolean {
  return sender?.id === extensionId && sender.tab === undefined && sender.url === sidePanelUrl;
}
