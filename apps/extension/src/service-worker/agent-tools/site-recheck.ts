import type { AgentNativeResponse } from "@hallpass/contracts";
import { canonicalOriginFromUrl } from "@hallpass/domain";
import { getTabLoadState } from "../../chrome-adapters/tabs.js";

/**
 * The site, asked again at the last moment before input or a picture leaves (014 change log
 * 2026-10-11).
 *
 * The site mode decides once per call, and the call then spends time before it reaches the page:
 * a gesture waits for the agent's cursor to glide to its point, a picture brings the tab forward.
 * A page that starts moving to another site inside that time would otherwise be given a press - or
 * be photographed - on a site the owner was never asked about, before the transition question
 * (FR-186, FR-187) could stand in the way. So the tab's own address is read once more, immediately
 * before the first event or the capture, and a tab that is no longer on the site the call was
 * decided on - committed elsewhere, or with a navigation to elsewhere already pending - receives
 * nothing.
 *
 * Cheap on purpose: one tab read per check and no waiting. Origins are compared in the form the
 * owner's decisions are keyed by, through the one parser `@hallpass/domain` has for it.
 */

/** What the browser says about where a tab is and where it is going. */
export type TabAddress = { url: string; pendingUrl?: string };

export type ReadTabAddress = (tabId: number) => Promise<TabAddress | undefined>;

/** The default reader: one `chrome.tabs.get`. */
export const readTabAddress: ReadTabAddress = getTabLoadState;

/** The origin a tab has committed, when it has one a decision could be keyed by. */
export async function committedOrigin(tabId: number, read: ReadTabAddress = readTabAddress): Promise<string | undefined> {
  const address = await read(tabId).catch(() => undefined);
  return address === undefined ? undefined : canonicalOriginFromUrl(address.url);
}

/**
 * Whether the tab is still on `origin`, counting a navigation that has not committed yet.
 *
 * A tab that cannot be read is not known to be there, and is answered `false`: the caller is about
 * to put something into that page, and "nothing was sent" is the honest answer when it cannot say
 * which page that would be.
 */
export async function stillOnOrigin(
  tabId: number,
  origin: string,
  read: ReadTabAddress = readTabAddress,
): Promise<boolean> {
  const address = await read(tabId).catch(() => undefined);
  if (address === undefined) return false;
  if (canonicalOriginFromUrl(address.url) !== origin) return false;
  if (address.pendingUrl !== undefined && address.pendingUrl !== "") {
    return canonicalOriginFromUrl(address.pendingUrl) === origin;
  }
  return true;
}

/**
 * What an agent is told when the tab left the site before the step reached it.
 *
 * Fixed text with no holes: the destination is the transition notice's to name (014 FR-186), and
 * that notice is appended by the runtime once the move is known to it.
 */
export const SITE_MOVED_HINT =
  "The tab moved, or began moving, to another site before this step reached it, so nothing was sent " +
  "or captured. If that site needs the owner's decision, the next call on this tab will ask them.";

/**
 * The refusal, in the `stale` family a document that moved on already answers with: the agent's
 * next move is the same one - look at the page again - and nothing about the page was changed.
 */
export function siteMovedAnswer(callId: string): AgentNativeResponse {
  return { callId, outcome: "stale", reason: "stale-context", hint: SITE_MOVED_HINT };
}

/**
 * Thrown from inside a gesture when its pre-dispatch check said no, before any event left.
 *
 * A throw rather than a return value because the gesture is several layers down (`computer`'s
 * dispatcher, a batch step's runner) and every one of them must stop exactly there; the effect
 * runner turns it back into `siteMovedAnswer` at the one place every delivery already passes.
 */
export class SiteMovedBeforeDispatch extends Error {
  constructor() {
    super("site-moved-before-dispatch");
    this.name = "SiteMovedBeforeDispatch";
  }
}

export function isSiteMovedBeforeDispatch(error: unknown): error is SiteMovedBeforeDispatch {
  return error instanceof SiteMovedBeforeDispatch;
}
