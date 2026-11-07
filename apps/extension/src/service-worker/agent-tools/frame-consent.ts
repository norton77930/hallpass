import type { AgentNativeResponse } from "@hallpass/contracts";
import { probeFrameSender, type FrameSenderProbe } from "../../chrome-adapters/frame-sender.js";
import { readMainWorldMarks } from "../../chrome-adapters/main-world-marks.js";
import { readFrameFocus } from "./frame-focus.js";
import {
  decideFrameSite,
  resolveFocusSite,
  resolvePointSite,
  type DecidingSite,
  type ViewportPoint,
} from "./frame-site.js";
import { FRAME_ANSWER_BOUND_MS } from "./frames.js";
import type { AgentInputAttachments } from "./input.js";
import type { AgentPageBinding } from "./page-binding.js";
import { frameAnswerText } from "./site-recheck.js";

/**
 * The frame-consent steps every runner that acts inside a frame shares (030 FR-450..FR-464):
 * finding the deciding site through the browser, turning it into what the gate and the card are
 * given, and the answers a frame's card ends in. The effects (`effects.ts`) and the uploads
 * (`upload.ts`) both take them from here, so a frame is decided, asked about and answered for the
 * same way whichever tool acts in it.
 *
 * `frame-site.ts` stays the pure part (what the browser's answers mean); this module is where those
 * answers are asked for, and what the runners do with the decision.
 */

/** A claimed child frame's site, from the browser's sender for one message it sends (R-440). */
export type FrameSiteOf = (binding: AgentPageBinding, frameId: number) => Promise<DecidingSite>;

/**
 * No reply within the frame bound, or a script that could not run there, is unknown (FR-464).
 * `probe` is the adapter by default.
 */
export function createFrameSiteOf(probe: typeof probeFrameSender = probeFrameSender): FrameSiteOf {
  return async (binding, frameId) => {
    let probed: FrameSenderProbe;
    try {
      probed = await probe(binding.tabId, frameId, FRAME_ANSWER_BOUND_MS);
    } catch {
      probed = {};
    }
    if (probed.documentId === undefined || probed.sender === undefined) {
      return { kind: "unknown", pageSite: binding.site, frameId };
    }
    return decideFrameSite({ sender: probed.sender }, { frameId, documentId: probed.documentId }, binding.site);
  };
}

/** The whole coordinate walk's bound (FR-464): the frame bound for the debugger, and one for the probe. */
const POINT_SITE_BOUND_MS = 2 * FRAME_ANSWER_BOUND_MS;

/** The focus walk's bound (T908): the frame bound for the all-frames read, and one for the probe. */
const FOCUS_SITE_BOUND_MS = 2 * FRAME_ANSWER_BOUND_MS;

/** What the coordinate walk is asked over: the tab's input attachment, and the browser's frame answers. */
export type PointSiteDeps = {
  attachments: Pick<AgentInputAttachments, "send" | "oopifSessions">;
  readFrameMarks?: typeof readMainWorldMarks;
  probeFrameSender?: typeof probeFrameSender;
};

/**
 * The site under a point in the top-level viewport (FR-455, R-442 as settled by T886), asked over
 * the input attachment the gesture will leave by. Any failed step is unknown (FR-464).
 *
 * One resolver for every runner that acts at a point - the effects, and `upload_image`'s drop - so
 * all of them are bounded and decided the same way.
 */
export function createPointSiteOf(
  deps: PointSiteDeps,
): (binding: AgentPageBinding, point: ViewportPoint) => Promise<DecidingSite> {
  const readFrameMarks = deps.readFrameMarks ?? readMainWorldMarks;
  const probeSender = deps.probeFrameSender ?? probeFrameSender;
  return (binding, point) =>
    resolvePointSite(point, binding.site, {
      send: (method, params, sessionId) => deps.attachments.send(binding.tabId, method, params, sessionId),
      sessions: () => deps.attachments.oopifSessions(binding.tabId),
      readMarks: (key) => readFrameMarks(binding.tabId, key),
      probeSender: (frameId) => probeSender(binding.tabId, frameId, FRAME_ANSWER_BOUND_MS),
      boundMs: POINT_SITE_BOUND_MS,
    });
}

/** What the focus walk is asked over: one all-frames read, and the browser's sender for the frame found. */
export type FocusSiteDeps = {
  readFrameFocus?: typeof readFrameFocus;
  probeFrameSender?: typeof probeFrameSender;
};

/**
 * The site of the frame holding the tab's focus (T908): where keys sent with no target land. Any
 * failed or doubtful step is unknown (FR-464).
 */
export function createFocusSiteOf(deps: FocusSiteDeps): (binding: AgentPageBinding) => Promise<DecidingSite> {
  const readFocus = deps.readFrameFocus ?? readFrameFocus;
  const probeSender = deps.probeFrameSender ?? probeFrameSender;
  return (binding) =>
    resolveFocusSite(binding.site, {
      readFocus: () => readFocus(binding.tabId),
      probeSender: (frameId) => probeSender(binding.tabId, frameId, FRAME_ANSWER_BOUND_MS),
      boundMs: FOCUS_SITE_BOUND_MS,
    });
}

/**
 * The site the gate is given (R-444): the page's when nothing in a frame decides or the frame is
 * the page's own site, the frame's when another site's frame does, and `null` - nobody's, which
 * always asks (FR-464) - when the frame's site is unknown.
 */
export function gateSiteOf(deciding: DecidingSite | undefined, pageSite: string): string | null {
  if (deciding === undefined || deciding.kind === "page") return pageSite;
  return deciding.kind === "frame" ? deciding.site : null;
}

/** The card names the frame only when the frame, not the page, is what is being decided (R-445). */
export function promptFrameOf(deciding: DecidingSite | undefined): { site: string } | { unknown: true } | undefined {
  if (deciding?.kind === "frame") return { site: deciding.site };
  if (deciding?.kind === "unknown") return { unknown: true };
  return undefined;
}

/** What a frame answer is about: the decision a claim carries, if any. */
export type DecidedClaim = { deciding?: DecidingSite };

/** The site a frame answer names (R-447): the deciding site when known, `"unknown"` otherwise. */
export function frameAnswerSite(claim: DecidedClaim): string {
  const deciding = claim.deciding;
  return deciding === undefined || deciding.kind === "unknown" ? "unknown" : deciding.site;
}

/** The frame-moved answer for a site (FR-460, FR-461): nothing was sent. */
export function frameMovedResponse(callId: string, site: string): AgentNativeResponse {
  return { callId, outcome: "stale", reason: "stale-context", hint: frameAnswerText(site, "frame-moved") };
}

/** The frame the gate decided for is no longer the one the delivery would reach (FR-460). */
export function frameMovedAnswer(callId: string, claim: DecidedClaim): AgentNativeResponse {
  return frameMovedResponse(callId, frameAnswerSite(claim));
}

/** The bound the answer's `hint` has to fit (contracts `agentNativeResponseSchema`). */
const HINT_MAX_CHARS = 400;

/**
 * A frame card's answer names the frame's site and the reason (FR-461). A hint the answer already
 * carries (a closed panel's instruction) is kept after it when both fit.
 */
export function withFrameAnswer(
  response: AgentNativeResponse,
  claim: DecidedClaim,
  reason: "refused" | "undecided",
): AgentNativeResponse {
  const known = claim.deciding?.kind === "frame";
  const text = frameAnswerText(frameAnswerSite(claim), known ? reason : "unknown-site");
  const joined = response.hint === undefined ? text : `${text} ${response.hint}`;
  return { ...response, hint: joined.length <= HINT_MAX_CHARS ? joined : text };
}

/**
 * The answer to an Allow always on a card that offered none (FR-458, T899): a frame whose site is
 * unknown has no site to store a mode under, so a reply that asks to remember one answers a question
 * nobody was shown. It is refused like a Refuse - nothing stored, nothing delivered, and the agent
 * told why. `undefined` when the reply is an answer to the card that was shown.
 */
export function rememberWithoutSiteRefusal(
  callId: string,
  rememberMode: unknown,
  gateSite: string | null,
  claim: DecidedClaim,
): AgentNativeResponse | undefined {
  if (!rememberMode || gateSite !== null) return undefined;
  return withFrameAnswer({ callId, outcome: "denied", reason: "owner-denied" }, claim, "refused");
}
