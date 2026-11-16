import { HINT_MAX_CHARS, type AgentNativeResponse, type SiteMode } from "@hallpass/contracts";
import { readFrameFocus } from "../../chrome-adapters/frame-focus.js";
import { probeFrameSender, type FrameSenderProbe } from "../../chrome-adapters/frame-sender.js";
import { readMainWorldMarks } from "../../chrome-adapters/main-world-marks.js";
import type { SiteModeStore } from "../site-mode-store.js";
import {
  decideFrameSite,
  resolveFocusSite,
  resolvePointSite,
  type DecidingSite,
  type ViewportPoint,
} from "./frame-site.js";
import { FRAME_ANSWER_BOUND_MS } from "./frames.js";
import type { AgentInputAttachments } from "./input.js";
import { ownershipRefusal, type TabOwnershipLookup } from "./ownership.js";
import type { AgentPageBinding } from "./page-binding.js";
import { noAnswerResponse, type PromptDecision } from "./prompts.js";
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
export function promptFrameOf(
  deciding: DecidingSite | undefined,
): { site: string } | { unknown: true; sites?: [string, string] } | undefined {
  if (deciding?.kind === "frame") return { site: deciding.site };
  // `sites` only names the two ends of a drag between two known sites (#51); it decides nothing.
  if (deciding?.kind === "unknown") return deciding.sites === undefined ? { unknown: true } : { unknown: true, sites: deciding.sites };
  return undefined;
}

/**
 * Whether the page decides from the top document: a decision that is the page's own, with no frame
 * named. A ref or a point there is the page's exactly as before (FR-465), and costs no frame probe.
 */
export function decidedByTopDocument(deciding: DecidingSite): boolean {
  return deciding.kind === "page" && deciding.frameId === undefined;
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

/** What the shared ask-and-apply step is given: the question, and what it needs to apply the answer. */
export type ConsentAsk = {
  callId: string;
  sessionId: string;
  tabId: number;
  /** What the gate's site came from (the claim's decision, or none). */
  claim: DecidedClaim;
  /** The site the gate decided for (`gateSiteOf`), `null` when nobody's. */
  gateSite: string | null;
  /** The card's frame line (`promptFrameOf`); only a frame's card also names the frame in its answers. */
  promptFrame: ReturnType<typeof promptFrameOf>;
  /** Raises the question. Called once, first; whatever it builds for the card is built inside it. */
  ask: () => Promise<PromptDecision | { decision: "busy" }>;
  tabOwnership: TabOwnershipLookup;
  siteModes: Pick<SiteModeStore, "set">;
};

/** The owner said yes and everything after the yes held; or the answer the call ends in. */
export type ConsentOutcome =
  | { ok: true; allowed: Extract<PromptDecision, { decision: "allow" }> }
  | { ok: false; response: AgentNativeResponse };

/**
 * The order both runners keep once a card is up: ask, take the answer, read the lease again, refuse
 * an Allow always on an unknown site, and store the mode the owner chose (006 FR-087, 030 FR-457,
 * FR-458, T899). Every ending but a yes is the answer the call gives; a yes is handed back for the
 * runner to carry on with (the effects also record a session grant from it).
 *
 * The lease is read after the answer because the check at the top of a call is a fact about the
 * moment the question was raised; and it is read before the unknown-site refusal and before anything
 * is stored, so a tab handed back while the card stood stores nothing.
 */
export async function askAndApplyConsent(input: ConsentAsk): Promise<ConsentOutcome> {
  const { callId, claim, promptFrame } = input;
  const asked = await input.ask();
  const ended = (response: AgentNativeResponse): ConsentOutcome => ({ ok: false, response });
  if (asked.decision === "busy") return ended({ callId, outcome: "busy", reason: "prompt-pending" });
  if (asked.decision === "timed-out") {
    // FR-043: nothing ran. The prompt is dead, so a late Allow cannot start it either. And if it was
    // raised where nobody could see it, the answer says where to click (011 FR-146). 030 FR-461: a
    // frame's card also names the frame's site and why nothing was sent.
    const noAnswer = noAnswerResponse(callId, asked);
    return ended(promptFrame === undefined ? noAnswer : withFrameAnswer(noAnswer, claim, "undecided"));
  }
  // 006 FR-087: the owner's Stop reaches a parked call in the same word an in-flight wait gets.
  if (asked.decision === "stopped") return ended({ callId, outcome: "stopped", reason: "owner-stopped" });
  // 014 FR-179: the owner ended this step and kept the session; not a decline, and not a stop.
  if (asked.decision === "interrupted") return ended({ callId, outcome: "stopped", reason: "owner-interrupted" });
  if (asked.decision === "deny") {
    const denied: AgentNativeResponse = { callId, outcome: "denied", reason: "owner-denied" };
    return ended(promptFrame === undefined ? denied : withFrameAnswer(denied, claim, "refused"));
  }
  // The lease, read again now that the owner has answered (006 FR-087, S1 review): they may have
  // pressed Release tabs while the question stood, and the tab is theirs again.
  const held = await input.tabOwnership(input.sessionId, input.tabId);
  if (held.state !== "this") return ended(ownershipRefusal(callId, held));
  if (asked.decision === "released") return ended(ownershipRefusal(callId, { state: "not-yours" }));
  // 030 FR-458, T899: a card for a frame whose site is unknown offers no Allow always, so a reply
  // that asks to remember a mode answers a question nobody was shown. It is refused like a Refuse.
  const unanswerable = rememberWithoutSiteRefusal(callId, asked.rememberMode, input.gateSite, claim);
  if (unanswerable !== undefined) return ended(unanswerable);
  if (asked.rememberMode && input.gateSite !== null) {
    // FR-042: the owner may set the site's mode from inside the prompt they are answering - the site
    // the card decided, which for a frame's card is the frame's site, never the page's (030 FR-457).
    await input.siteModes.set(input.gateSite, { mode: asked.rememberMode as SiteMode, session: input.sessionId });
  }
  return { ok: true, allowed: asked };
}
