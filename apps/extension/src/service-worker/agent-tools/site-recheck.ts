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

/**
 * The site of an embedded frame as an answer names it: the canonical origin the browser reported
 * for the frame's sender, or `"unknown"` when it could not be established (030 R-440, R-447).
 */
export type FrameAnswerSite = string;

/** The one reason a refused or cancelled frame action is given (030 FR-461, R-447). */
export type FrameAnswerReason = "refused" | "undecided" | "frame-moved" | "unknown-site";

/**
 * What an agent is told when an action inside an embedded frame from another site was refused or
 * cancelled (030 FR-461, R-447): the frame's site, and exactly one reason.
 *
 * Plain text for an agent, with the site shown the way origins are everywhere else (the canonical
 * `scheme://host[:port]` string). A frame whose site is not known says so instead of printing a
 * placeholder, so the agent is never given a site name that is not one.
 */
export function frameAnswerText(site: FrameAnswerSite, reason: FrameAnswerReason): string {
  const known = site !== "unknown";
  const frame = known ? `an embedded frame from ${site}` : "an embedded frame whose site could not be established";
  switch (reason) {
    case "refused":
      return (
        `The owner refused this action inside ${frame}, so nothing was sent. ` +
        "Do not retry it unprompted; ask the owner what they want instead."
      );
    case "undecided":
      return (
        `No decision was made about this action inside ${frame}: the card timed out or was dismissed, ` +
        "so nothing was sent. You may ask the owner, then try again."
      );
    case "frame-moved":
      return (
        `${known ? `The embedded frame from ${site}` : "The embedded frame"} moved to another site or document ` +
        "after the decision, so nothing was sent. Read the page again to see where the frame is now, " +
        "then retry; if the frame is on a site that needs the owner's decision, the next call will ask them."
      );
    case "unknown-site":
      return (
        "This embedded frame's site could not be established, and the owner refused or did not answer, " +
        "so nothing was sent. Read the page again, or ask the owner, before trying anything inside that frame."
      );
  }
}

/**
 * The frame's counterpart of `SiteMovedBeforeDispatch`: thrown from the pre-dispatch check when the
 * frame an action was decided for is no longer the same site or document, before any event left.
 * It carries the frame's site so the one place every delivery passes can answer with
 * `frameAnswerText(site, "frame-moved")`.
 */
export class FrameMovedBeforeDispatch extends Error {
  readonly site: FrameAnswerSite;

  constructor(site: FrameAnswerSite) {
    super("frame-moved-before-dispatch");
    this.name = "FrameMovedBeforeDispatch";
    this.site = site;
  }
}

export function isFrameMovedBeforeDispatch(error: unknown): error is FrameMovedBeforeDispatch {
  return error instanceof FrameMovedBeforeDispatch;
}
