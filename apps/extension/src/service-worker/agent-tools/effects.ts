import {
  AGENT_015_REASON_OUTCOMES,
  agentToolArgSchemas,
  isAgentEffectTool,
  type AgentEffectObservation,
  type AgentEffectVerdict,
  type AgentNativeResponse,
  type AgentToolName,
  type CurrentDialog,
  type RuntimeAction,
  type SiteMode,
} from "@hallpass/contracts";
import type { captureTab, CaptureDeps, CaptureFrame, CaptureRegion } from "../../chrome-adapters/capture.js";
import {
  clearFrameNonce,
  enumerateFrameOffsets,
  enumerateTabFrames,
  writeFrameNonce,
} from "../../chrome-adapters/scripting.js";
import type { queryTabSnapshots } from "../../chrome-adapters/tabs.js";
import {
  collectFromActiveTab,
  executeOnActiveTab,
  probeActiveTab,
  resolveHandleOnTab,
} from "../content-broker.js";
import type { DownloadObserver } from "../download-observer.js";
import { verifyPageEffect } from "../effect-verification.js";
import type { PageExecutionOutcome } from "../page-ports.js";
import type { SiteModeStore } from "../site-mode-store.js";
import type { AgentSessionContexts, AgentToolContext } from "./context.js";
import { decideGate, type StatedPlan } from "./gate.js";
import {
  createKeyboardInput,
  createPointerInput,
  inputUnavailable,
  isInputDispatchDeadline,
  type AgentInputAttachments,
  type AgentKeyboardInput,
  type AgentPointerInput,
  type CursorSender,
  type PointerButton,
} from "./input.js";
import {
  createFrameOffsets,
  createHybridFrameOffsets,
  tabFrames,
  type FrameEnumerator,
  type FrameOffsetMeasurement,
  type FrameOffsets,
} from "./frames.js";
import {
  cropAround,
  deliverPosition,
  insideViewport,
  measureViewport,
  outsideViewport,
  positionOf,
  type PositionPoint,
  type Viewport,
} from "./computer.js";
import { bindingFailureResponse, INPUT_NOT_ANSWERED_HINT, type AgentPageBinding, type AgentPageBindings } from "./page-binding.js";
import { photographTab } from "./photograph.js";
import { noAnswerResponse, type AgentPromptController } from "./prompts.js";
import { findOnTab, resolveRef, type AgentTarget } from "./refs.js";
import type { AgentToolRequest } from "./stop.js";
import { summariseToolCall } from "./summaries.js";
import { ownershipRefusal, type TabOwnershipLookup } from "./ownership.js";

/**
 * The effect tools (003/T028, FR-040..FR-043).
 *
 * One order, for every effect, and it is the order the guarantees depend on:
 *
 *   own the tab → bind the page → read the site's mode → gate → resolve refs → execute → verify
 *
 * The gate is before the refs on purpose. Resolving a point mints a handle, which is a read of the
 * page; doing it before the owner has consented would mean an `ask` the owner denied had already
 * touched the document. And verification is after the effect, always, because FR-040's rule is that
 * an `ok` names something that was *observed* - the executor's evidence plus a re-probe of the tab
 * the effect ran on.
 *
 * `find` is here too and is deliberately not gated: it reads, and reading is ungated by design.
 *
 * Acting by position (004/T139) keeps that order and adds one step in front of the gate rather than
 * beside it: a coordinate has to be checked against the tab's own viewport before anybody is asked
 * about it, because a point past the edge is refused with the size and the owner should never be
 * shown a question about an effect that was never going to be delivered.
 *
 * A confirmation carries the frame's identity, never the tab's (004/T155). `frameId`,
 * `documentEpoch` and `canonicalOrigin` belong to the document that claimed the ref - asking the top
 * document about a claim a nested or cross-origin frame made is not a staleness check, it is asking
 * the wrong document and reporting its mismatch as one. This has shipped wrong three times running:
 * the click confirmation before B69 (epoch) and B72 (origin), then `type`'s own focus confirmation
 * here. Every confirmer takes the frame's identity as optional fields for exactly this reason - fill
 * them in from `TargetRect.frame` whenever one exists, and default to the binding's own only when it
 * does not; never reach past a present `TargetRect.frame` for the binding's identity instead.
 */

export type AgentEffectDeps = {
  context: AgentSessionContexts;
  siteModes: SiteModeStore;
  bindings: AgentPageBindings;
  prompts: AgentPromptController;
  /** FR-034: the session's own tabs, and nothing else. */
  tabOwnership: TabOwnershipLookup;
  /**
   * The shared debugger attachment every pointer gesture is delivered over (004/T121, R-113).
   *
   * Required rather than optional: an effects runner with no attachment could only deliver the
   * page-level events this slice replaces, and a quiet fallback to them is exactly the input the
   * page can tell apart from a person's.
   */
  attachments: AgentInputAttachments;
  /** Where the page is told the pointer is; absent means the ordinary content-script channel. */
  cursor?: CursorSender;
  /** Where an element is, in its own frame's viewport. The frame offsets are T124/T125. */
  locate?: TargetLocator;
  /**
   * Whether a delivered point actually resolves to the target it was computed from (004/T128).
   * Asked only after delivery, and only of the click family: a coordinate is this worker's own
   * arithmetic on a rect the page reported, and the rect can be wrong in ways nothing else here
   * catches - the point still needs to be verified, at the frame that owns the element, the same
   * way `elementFromPoint` already resolves a point target before the gate (`refs.ts`).
   */
  confirm?: TargetConfirmer;
  /**
   * Whether a key press's target kept focus (004/T128, B65). Asked only of a key press that named
   * a target - the ref that was clicked before the keys were delivered - the same way `confirm`
   * above is asked only of the click family.
   */
  confirmFocus?: FocusConfirmer;
  /** The session's StatedPlan for `follow-a-plan`; a `browser_batch` the owner approved states one. */
  /**
   * The tab this session just acted in (004/T103a). The tab manager keeps it as the session's
   * `mainTabId`, which is what the indicator's control focuses - so it has to follow the effects,
   * not only the tabs the session created.
   */
  onEffect?: (sessionId: string, tabId: number) => void;
  /**
   * Where the gesture landed, in page coordinates (008/T221, FR-105).
   *
   * Only this runner knows: the coordinate is its own arithmetic on the box the page reported for
   * the target, and it is gone the moment the delivery returns. The recording's ring is drawn from
   * it; nothing here changes because nobody is listening.
   */
  onDelivered?: (
    callId: string,
    delivery: { point?: { x: number; y: number }; from?: { x: number; y: number }; to?: { x: number; y: number } },
  ) => void;
  /**
   * The effect the owner's consent has just covered on this tab (008/T226, data-model
   * LastApprovedEffect, R-139).
   *
   * Told at the moment the gate admits or the owner allows, not when the effect lands: the page can
   * open its confirm while the click is still being delivered, and the question the chaining rule
   * asks is "did the owner approve something here a moment ago", not "did it finish". Read by
   * nothing but `dialogs.ts`.
   */
  onApproved?: (tabId: number, tool: AgentToolName) => void;
  /**
   * The dialog open on a tab right now (008/T226, FR-111).
   *
   * An effect asks for one reason only: the page may have opened a dialog *because of* the effect,
   * in which case the verify step is asking a renderer that will not answer. The dialog then rides
   * back on this call's own answer, which is what tells the agent what its click actually did.
   */
  currentDialog?: (tabId: number) => CurrentDialog | undefined;
  statedPlan?: (site: string) => StatedPlan | undefined;
  /**
   * Told which step of the plan was just admitted, so the plan advances past it.
   *
   * The gate reads the plan and never writes it - a decision function that moved its own input
   * would admit a step differently depending on when it was asked - so advancing is the caller's,
   * and it happens at admission rather than after the effect: the owner approved one occurrence of
   * that step, and a step whose effect failed has still been used up.
   */
  onAdmitted?: (site: string, step: number) => void;
  /**
   * Whether the calling session's approved site plan names `site` (017 R-245): the gate's input,
   * asked with the same site the mode was read for - the binding's, i.e. the tab's current
   * top-level origin. Absent is "not covered", which is every answer the gate gave before 017.
   */
  sitePlanCovers?: (sessionId: string, site: string) => Promise<boolean>;
  /**
   * Photographing the tab (004/T139, US7, FR-069).
   *
   * An effect runner had no use for a camera until `computer` arrived, and it now has two: the
   * tool's own `screenshot` action, and the crop the owner is shown around a point they are being
   * asked about. Both go through the same lookup the `screenshot` tool uses (`photograph.ts`), so
   * the owner's window is put back the same way whichever tool took the picture.
   */
  capture?: typeof captureTab;
  captureDeps?: CaptureDeps;
  listTabs?: typeof queryTabSnapshots;
  /**
   * The emulated size a session gave this tab, when it gave it one (012/T311, FR-158, R-166).
   *
   * Both pictures this runner takes need it for the same reason the `screenshot` tool does: under
   * an emulated viewport `captureVisibleTab` photographs the *window*, so a `computer screenshot`
   * and the crop the owner is shown would be pictures of something other than the page the agent
   * is working on. The command travels over `attachments`, which this runner already has - the
   * emulation is holding that attachment open for exactly as long as it lasts.
   */
  currentViewport?: (tabId: number) => Promise<CaptureFrame | undefined>;
  /**
   * How `computer`'s `wait` waits.
   *
   * Injected for the same reason every other clock in this worker is: a test should not have to
   * spend the time the agent asked for in order to check that it was asked for.
   */
  sleep?: (ms: number) => Promise<void>;
  execute?: typeof executeOnActiveTab;
  probe?: typeof probeActiveTab;
  /** How an out-of-process frame's session is confirmed for a claimed ref (004/T129, B75). */
  writeFrameNonce?: typeof writeFrameNonce;
  /** How the correlation nonce's tell is removed after the round trip (004/T149). */
  clearFrameNonce?: typeof clearFrameNonce;
  /** How long a navigation started by an effect is given to unload the old document. */
  settleMs?: number;
  reportDiagnostic?: (code: string) => void;
  /**
   * Tabs as the browser creates them (015/T406, FR-200). A press listens for the length of its
   * settle wait and keeps only the tabs whose opener is the tab it pressed in. Defaults to
   * `chrome.tabs.onCreated`; injected so a test can open a tab at the moment it chooses.
   */
  watchTabCreated?: (listener: (tab: CreatedTabEvent) => void) => () => void;
  /**
   * A tab's address as the browser has it now - committed, or pending while it has not committed
   * (015/T406). `undefined` when the tab cannot be read; the observation then omits the address
   * rather than guessing it. Defaults to `chrome.tabs.get`.
   */
  tabUrl?: (tabId: number) => Promise<string | undefined>;
  /**
   * The session's download records started since a moment (015/T405, T406). Absent means this
   * runner cannot see downloads, and a press reports none - never "none happened" on its behalf:
   * without it `observedForMs` would claim a silence nobody observed, so it is wired wherever the
   * observer exists.
   */
  downloads?: Pick<DownloadObserver, "createdSince">;
  /** The clock a press's window is measured by; injected with the rest of the browser. */
  now?: () => number;
};

/** What `tabs.onCreated` says about a tab, as far as a press needs it (015/T406). */
export type CreatedTabEvent = {
  id?: number | undefined;
  openerTabId?: number | undefined;
  url?: string | undefined;
  pendingUrl?: string | undefined;
};

export type AgentEffectRunner = {
  /** Whether this runner answers the tool at all; the dispatch table asks before routing. */
  handles(tool: AgentToolName): boolean;
  run(request: AgentToolRequest): Promise<AgentNativeResponse>;
};

/** The 002 settle window, reused: the same page needs the same time whoever asked. */
const DEFAULT_SETTLE_MS = 400;

/**
 * How often an effect in flight looks at this worker's own dialog map (008/FR-111).
 *
 * Fine enough that a confirm raised inside a click is noticed while the verification is still its
 * first round trip, and coarse enough to be nothing at all on a page that opens no dialog. It asks
 * a map in this worker's memory, never the page.
 */
const DIALOG_RACE_POLL_MS = 25;

type EffectPlan = {
  capability: RuntimeAction;
  args: Record<string, unknown>;
  /** How many times to deliver it; only `key` repeats, and it is bounded by the contract. */
  repeat: number;
};

function answer(
  callId: string,
  outcome: AgentNativeResponse["outcome"],
  reason?: string,
  refusal?: AgentNativeResponse["refusal"],
): AgentNativeResponse {
  return { callId, outcome, ...(reason === undefined ? {} : { reason }), ...(refusal === undefined ? {} : { refusal }) };
}

/**
 * A ref whose element has genuinely left the document (004/T136): a different next move from
 * `target-not-located` ("I could not find that anywhere") - this one means "your ref is dead, read
 * the page again" - so it carries the schema's own `stale-reference` refusal, like its `stale-*`
 * siblings carry theirs.
 */
function staleReferenceAnswer(callId: string): AgentNativeResponse {
  return answer(callId, "stale", "stale-reference", { reason: "stale-reference" });
}

/**
 * Maps the executor's evidence arm onto the observation the agent is given.
 *
 * The verdict is an input rather than a footnote (003/B2): a navigation the effect started
 * asynchronously is invisible to the executor and visible only to the probe that followed it, so
 * `documentChanged` is the *or* of the two. Reporting the executor's own `false` there would tell
 * the agent its refs survived an effect that killed every one of them.
 */
function observationOf(
  outcome: Extract<PageExecutionOutcome, { ok: true }>,
  verdict: AgentEffectVerdict,
): AgentEffectObservation | undefined {
  const effect = outcome.effect;
  if (
    effect !== "activated" &&
    effect !== "context-activated" &&
    effect !== "double-activated" &&
    effect !== "triple-activated" &&
    effect !== "hovered" &&
    effect !== "dragged" &&
    effect !== "text-entered" &&
    effect !== "key-pressed" &&
    effect !== "scrolled" &&
    effect !== "value-set"
  ) {
    return undefined;
  }
  return {
    effect,
    documentChanged: outcome.documentChanged === true || verdict === "document-changed",
    verified: verdict === "verified",
    verdict,
    ...(outcome.clicks === undefined ? {} : { clicks: outcome.clicks }),
    ...(outcome.charactersChanged === undefined ? {} : { charactersChanged: outcome.charactersChanged }),
    ...(outcome.focusRetained === undefined ? {} : { focusRetained: outcome.focusRetained }),
    ...(outcome.targetVisible === undefined ? {} : { targetVisible: outcome.targetVisible }),
    ...(outcome.moved === undefined ? {} : { moved: outcome.moved }),
    ...(outcome.valueMatched === undefined ? {} : { valueMatched: outcome.valueMatched }),
    ...(outcome.scrollTop === undefined ? {} : { scrollTop: outcome.scrollTop }),
    ...(outcome.targetVisibility === undefined ? {} : { targetVisibility: outcome.targetVisibility }),
    ...(outcome.key === undefined ? {} : { key: outcome.key }),
  };
}

/**
 * What one press left behind in its settle wait, before the verdict says whether the document moved
 * (015/T406, contracts/press-outcomes.md, data-model "Press observation").
 */
type PressFacts = {
  /** The pressed tab's address at the end of the wait, when it could be read and fits the bound. */
  url?: string;
  newTabs: Array<{ tabId: number; url: string; held: false }>;
  downloads: Array<{ id: number; filename: string; url: string; state: string }>;
  /** Whether downloads were watched at all; without the observer nothing may be called silent. */
  downloadsObserved: boolean;
  /** The wait actually spent, from just before the press to the end of the settle. */
  spentMs: number;
};

/** The press's own window: armed just before the input leaves, ended when the settle wait ends. */
type PressWatch = {
  /**
   * Ends the window and reads what the press left behind. Never throws; answers once. The window
   * closes synchronously, inside the call - a tab created after it returns is not this press's.
   */
  settle(): Promise<PressFacts>;
  /** Ends the window without reading - the call is answering some other way. Idempotent. */
  stop(): void;
};

/** The contract's bounds on what an observation may carry (agentEffectObservationSchema). */
const PRESS_LIST_MAX = 10;
const PRESS_URL_MAX = 2048;
/** The response's own bound on `hint`. */
const HINT_MAX = 400;

/**
 * A link that was pressed and led nowhere within the window (015 FR-201, contracts rule 6).
 *
 * The window is stated in it because it is the only thing the answer actually knows: nothing
 * happened *yet*. The page may have handled the press itself, or be about to navigate.
 */
function linkHint(windowMs: number): string {
  return (
    `The link was pressed, but nothing navigated, opened or downloaded within ${windowMs} ms. ` +
    "The page may handle it itself — read the page or wait before assuming it did nothing."
  );
}

/**
 * The tabs a press opened, and the one move that makes them this session's (015 FR-200, contracts
 * rule 7). Seeing a tab open does not hold it; `tabs_claim` does. One tab is named with its
 * address, as the contract words it; an address too long for the hint, or several tabs, are named
 * by id alone - the observation beside it carries every address in full.
 */
function newTabsHint(tabs: PressFacts["newTabs"]): string {
  const [only] = tabs;
  if (tabs.length === 1 && only) {
    const named = `The press opened tab ${only.tabId} (${only.url}). It is not held by this session; use tabs_claim to act on it.`;
    if (only.url !== "" && named.length <= HINT_MAX) return named;
    return `The press opened tab ${only.tabId}. It is not held by this session; use tabs_claim to act on it.`;
  }
  const listed = `The press opened tabs ${tabs.map((tab) => tab.tabId).join(", ")}. They are not held by this session; use tabs_claim to act on them.`;
  return listed.length <= HINT_MAX
    ? listed
    : `The press opened ${tabs.length} tabs. They are not held by this session; use tabs_claim to act on them.`;
}

/**
 * The press's facts, turned into the observation's additive fields and the answer's hint, once the
 * verdict has said whether the document moved (015 FR-200 – FR-202).
 *
 * `url` is only for a document that changed - an unchanged tab's address is not news. Every outcome
 * that happened is reported, so a press that navigated *and* opened a tab says both. `observedForMs`
 * is the opposite claim - that none of the three happened - so it is made only when all three were
 * actually watched; a runner that cannot see downloads says nothing rather than "nothing".
 */
function pressOutcome(
  facts: PressFacts,
  documentChanged: boolean,
  link: boolean,
  windowMs: number,
): { fields: Partial<AgentEffectObservation>; hint?: string } {
  const newTabs = facts.newTabs.slice(0, PRESS_LIST_MAX);
  const downloads = facts.downloads.slice(0, PRESS_LIST_MAX);
  const nothing = !documentChanged && newTabs.length === 0 && downloads.length === 0 && facts.downloadsObserved;
  const fields: Partial<AgentEffectObservation> = {
    ...(documentChanged && facts.url !== undefined ? { url: facts.url } : {}),
    ...(newTabs.length > 0 ? { newTabs } : {}),
    ...(downloads.length > 0 ? { downloads } : {}),
    ...(nothing ? { observedForMs: facts.spentMs } : {}),
  };
  if (facts.newTabs.length > 0) return { fields, hint: newTabsHint(facts.newTabs) };
  if (nothing && link) return { fields, hint: linkHint(windowMs) };
  return { fields };
}

/** An address the observation may carry: whole, or not at all (a cut address reads as another). */
function boundedUrl(url: string | undefined): string | undefined {
  return url !== undefined && url !== "" && url.length <= PRESS_URL_MAX ? url : undefined;
}

/** `chrome.tabs.onCreated`, when this worker has it; a no-op subscription when it does not. */
function watchChromeTabCreated(listener: (tab: CreatedTabEvent) => void): () => void {
  const events = typeof chrome !== "undefined" ? chrome.tabs?.onCreated : undefined;
  if (!events) return () => {};
  const handler = (tab: chrome.tabs.Tab): void => listener(tab);
  events.addListener(handler);
  return () => events.removeListener(handler);
}

/** A tab's committed address, or its pending one; `undefined` for a tab that cannot be read. */
async function chromeTabUrl(tabId: number): Promise<string | undefined> {
  const tab = await chrome.tabs.get(tabId);
  return tab.url || tab.pendingUrl || undefined;
}

/**
 * Decision 8's mapping from a refused execution to a tool outcome. Each word means one thing:
 * `stale` is a handle or a document that has moved on, `not-actionable` is a page this extension
 * may not act on, `stopped` is the fence, and everything else is a `failed` carrying the runtime's
 * own stable code - never a sentence.
 */
function refusalOutcome(reason: string): { outcome: AgentNativeResponse["outcome"]; reason: string } {
  if (reason === "stale-target" || reason === "stale-context" || reason === "stale-binding") {
    return { outcome: "stale", reason };
  }
  if (reason === "unsupported-page") return { outcome: "not-actionable", reason };
  if (reason === "fence-refused" || reason === "cancelled") return { outcome: "stopped", reason };
  if (reason === "denied" || reason === "submission-guard") return { outcome: "denied", reason };
  return { outcome: "failed", reason };
}

/** One element's box, as its own document reports it. */
export type TargetRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * The frame that claimed the ref, and its box in that frame's own viewport (004/T128 gap 2) -
   * what a same-frame confirmation has to ask in, since `elementFromPoint` is a fact about one
   * document and the top document's point is not that document's own. Present only when a frame
   * offset was actually applied; the single-document page needs none, and asking frame 0 with the
   * page point already is that document's own point.
   *
   * `documentEpoch` is that same frame's own epoch, as its own collection just declared it (004/T128
   * gap 3) - not the top document's, which a nested frame's own document never shares. A
   * confirmation that checked the frame's answer against the top epoch always refused a framed
   * target, on a document that had never gone stale at all.
   *
   * `canonicalOrigin` is that same frame's own origin, as its own collection just declared it
   * (004/T129, B71) - not the top document's, which a genuinely cross-origin frame never has and
   * never will. A confirmation that checked the frame's answer against the top origin always
   * refused a cross-origin target, structurally rather than on any real staleness.
   */
  frame?: {
    frameId: number;
    rect: { x: number; y: number; width: number; height: number };
    documentEpoch: string;
    canonicalOrigin: string;
    /**
     * This frame's own CDP session, when it is a genuine out-of-process (cross-site) frame
     * (004/T129). Present only for that case - `createTargetLocator` never composes an offset for
     * it (there is nothing above it in the page's own process to compose with) - and it is what
     * routes delivery through `{tabId, sessionId}` at this frame's *own* coordinates, in the frame's
     * own rect above, rather than through the tab at a page point.
     */
    sessionId?: string;
  };
  /**
   * The element is a link with an address (015/T406, FR-201): the frame that claimed the ref gave it
   * the role `link`, which the collection gives only to an anchor that has an `href` or to an element
   * the page itself calls a link. Read for one thing only - a press on a link that caused nothing is
   * the press whose silence needs explaining. Absent for everything else, and when not reported.
   */
  link?: true;
};

export type TargetLocator = (input: {
  context: AgentToolContext;
  binding: AgentPageBinding;
  ref: string;
  /**
   * Whether this locate is about to compute a coordinate to deliver at, as opposed to one whose
   * only purpose is to verify what already happened (004/T128, B70). Only the former scrolls the
   * target into view - a locate that re-measures to check movement would have its own comparison
   * defeated by a scroll that re-centres the element to exactly where it centred it before, making
   * a genuinely moved element measure identical to where it started. The call site states which one
   * it is; nothing here infers it from the effect's name.
   */
  scroll: boolean;
}) => Promise<TargetRect | TargetLocateStale | TargetLocateNotActionable | undefined>;

/**
 * What a delivery-wide locate answers when the ref itself is gone (004/T136), aggregated across
 * every frame: `undefined` still means "not located" - no frame has ever heard of this ref, or the
 * page has only one document and it did not claim one - while this means at least one frame's
 * registry once bound it and the element has since left. The two lead an agent to different next
 * moves, so `locator`/`deliverPointer`'s callers answer `stale-reference` for this one rather than
 * `target-not-located`.
 */
export type TargetLocateStale = { stale: true };

/**
 * A third fact `undefined` cannot carry (004/T161): the page itself is one this extension may not
 * act on at all (`unsupported-page` - a `chrome://` page, a PDF viewer), discovered when the
 * collection this locate needed threw that specific error. "Not located" tells the agent to read the
 * page again and retry; that is the wrong next move for a page that can never be read at all, so
 * `locator`'s callers answer `not-actionable` for this one instead of `target-not-located`.
 */
export type TargetLocateNotActionable = { notActionable: true };

/**
 * Where the locators for one delivery come from (004/T125a).
 *
 * A locator is opened per delivery rather than per runner because that is the lifetime of the
 * frame geometry behind it: within one delivery a chain is measured once, and the delivery is
 * where the measurement stops being trustworthy.
 */
export type TargetLocatorSource = {
  forDelivery(): TargetLocator;
};

/**
 * What confirming a delivered point found (004/T128, T129): the ref it was computed for or a
 * descendant of it (`hit`), a live element that is neither (`missed`, with what was actually
 * there - bounded the way a `find` candidate already is), or no answer at all because the round
 * trip that asks could not run (`unconfirmed` - `stale-context`'s family, 004/T129). The three are
 * kept apart rather than collapsed to a boolean: a miss and an unanswerable check are different
 * facts, and only the first is something the confirmation actually observed.
 */
export type TargetConfirmResult =
  | { outcome: "hit" }
  | { outcome: "missed"; role?: string; label?: string }
  | { outcome: "unconfirmed" };

/**
 * Whether a point that was just delivered resolves, in the page's own hit-testing, to the ref it
 * was computed for - or to a descendant of it (004/T128).
 *
 * Deliberately a second, independent question from `TargetLocator`'s: a locator answers "where is
 * this ref", which is exactly the machinery a wrong rect would come from, so asking it again after
 * delivery would only repeat whatever it already got wrong. This asks the page's own
 * `elementFromPoint` instead - the same primitive a point target is minted from before the gate
 * (`refs.ts`) - which is a fact about the document, not a restatement of this worker's arithmetic.
 */
export type TargetConfirmer = (input: {
  context: AgentToolContext;
  binding: AgentPageBinding;
  ref: string;
  /** In the frame's own coordinates - the top document's, for a target with no `frameId` below. */
  point: { x: number; y: number };
  /** The frame that claimed the ref (004/T128 gap 2); absent asks the top document. */
  frameId?: number;
  /**
   * The epoch that frame's own document must still be at (004/T128 gap 3): the frame's own, as
   * `TargetRect.frame.documentEpoch` carried it from the locate that found the target, when a frame
   * claimed the ref - or absent for the top document, whose epoch is the binding's own.
   */
  documentEpoch?: string;
  /**
   * The origin that frame's own document must still answer from (004/T129, B71): the frame's own,
   * as `TargetRect.frame.canonicalOrigin` carried it from the locate that found the target - or
   * absent for the top document, whose origin is the binding's own. Without this a genuinely
   * cross-origin frame's answer was always compared against the top document's origin instead,
   * which is structural, not staleness, so a click landing inside such a frame always refused.
   */
  frameOrigin?: string;
}) => Promise<TargetConfirmResult>;

/**
 * The default confirmer: asks the document what is actually at the delivered point, through the
 * same `content.resolve-point` round trip a point target already resolves through, and checks
 * whether it minted the ref this delivery was aimed at.
 *
 * `targetHandle` rides along so the document can answer "or a descendant of it" on its own side
 * (004/T128 gap 1 - `content-runtime/index.ts`): a hit on the ref's own element or on any element
 * it contains is the ref, checked against the registry's live element, never against the
 * rect-collection walk that is itself under suspicion.
 *
 * The round trip itself can fail two different ways (004/T129), and they are not the same fact:
 * `reply.ok === false` means the check never ran at all - refused upstream, in the `stale-context`
 * family - so `unconfirmed` is the only honest answer; a resolved-but-different reply means the
 * check *did* run and named something else, which is a real `missed`, carried with what the page
 * says was actually there.
 */
export function createTargetConfirmer(resolve: typeof resolveHandleOnTab = resolveHandleOnTab): TargetConfirmer {
  return async ({ context, binding, ref, point, frameId, documentEpoch, frameOrigin }) => {
    // 004/T147 (S4 review): `resolve` throws on several paths (`unsupported-page`, `no-active-tab`,
    // `content.probe`, `content.injection`) - a routine trigger is a click that navigates to a PDF or
    // a `chrome://` page. Nothing above this call site catches a throw, so it used to escape all the
    // way to the agent bridge's own catch and answer `failed / handler-error` for an effect that had
    // already landed. A confirmation that cannot be made is exactly what `unconfirmed` already means
    // for a reply that says `ok: false`; a confirmation that could not even ask means the same thing.
    let reply: Awaited<ReturnType<typeof resolveHandleOnTab>>;
    try {
      reply = await resolve({
        taskId: context.taskId,
        operationId: context.operationId,
        runtimeEpochId: context.runtimeEpochId,
        nonce: context.nonce,
        expectedTabId: binding.tabId,
        canonicalOrigin: binding.canonicalOrigin,
        // The frame that claimed the ref carries its own epoch (004/T128 gap 3); the top document's
        // is the binding's own, unchanged. Confirming a framed answer against the binding's epoch
        // compares two different documents and refuses a target that never went stale.
        documentEpoch: documentEpoch ?? binding.documentEpoch,
        // Same reasoning, for the origin (004/T129, B71): the frame that claimed the ref carries its
        // own origin; the top document's is the binding's own, unchanged. Comparing a cross-origin
        // frame's answer against the binding's origin refuses a target whose document never moved.
        frameOrigin: frameOrigin ?? binding.canonicalOrigin,
        generalPageReadGrantId: context.generalPageReadGrantId,
        point,
        targetHandle: ref,
        ...(frameId === undefined ? {} : { frameId }),
        tab: binding.tabId,
      });
    } catch {
      return { outcome: "unconfirmed" };
    }
    if (reply.ok === false) return { outcome: "unconfirmed" };
    if (reply.outcome === "missed") {
      return { outcome: "missed", ...(reply.role ? { role: reply.role } : {}), ...(reply.label ? { label: reply.label } : {}) };
    }
    if (reply.outcome === "resolved" && reply.candidates.some((candidate) => candidate.targetHandle === ref)) {
      return { outcome: "hit" };
    }
    return { outcome: "missed" };
  };
}

/**
 * Whether the element a key press was aimed at still has focus, asked after delivery (004/T128,
 * B65): `focusRetained` had no producer on this path at all - `effect-verification.ts` requires it
 * to be exactly `true`, and nothing here ever set it, so every browser-level key press answered
 * `focus-lost` whether or not the page agreed.
 *
 * Three-way, mirroring `TargetConfirmer` (004/T161): `true` is a confirmed hit, `false` is a
 * confirmed miss - the round trip ran and named something else - and `undefined` is that the round
 * trip could not run at all. A caught throw is the last case, not the second: it is not evidence
 * that focus moved, and reporting it as `false` claimed a miss nothing here actually observed.
 */
export type FocusConfirmer = (input: {
  context: AgentToolContext;
  binding: AgentPageBinding;
  /** The ref the key press was clicked onto before it was delivered. */
  ref: string;
  /** The frame that claimed the ref (004/T155); absent asks the top document. */
  frameId?: number;
  /**
   * The epoch that frame's own document must still be at (004/T155), mirroring
   * `TargetConfirmer.documentEpoch`: the frame's own, as `TargetRect.frame.documentEpoch` carried
   * it from the locate that claimed the ref - or absent for the top document, whose epoch is the
   * binding's own.
   */
  documentEpoch?: string;
  /**
   * The origin that frame's own document must still answer from (004/T155), mirroring
   * `TargetConfirmer.frameOrigin`: the frame's own, as `TargetRect.frame.canonicalOrigin` carried
   * it - or absent for the top document, whose origin is the binding's own.
   */
  frameOrigin?: string;
}) => Promise<boolean | undefined>;

/**
 * The default confirmer: the same round trip the click confirmation uses, with no point at all - a
 * point resolves what is under it, and its absence resolves the document's own `activeElement`
 * (`content-broker.ts`, `content.resolve-active-element`). A fact about the document, never this
 * worker's own bookkeeping.
 */
export function createFocusConfirmer(resolve: typeof resolveHandleOnTab = resolveHandleOnTab): FocusConfirmer {
  return async ({ context, binding, ref, frameId, documentEpoch, frameOrigin }) => {
    // 004/T147 (S4 review): the keyboard path's own confirmation reaches the same `resolve` the
    // click family's does, and the same throws (`unsupported-page`, `no-active-tab`,
    // `content.probe`, `content.injection`) used to escape uncaught here too - a key press or typed
    // text that had landed was reported `failed / handler-error` instead of the honest, bounded
    // `focus-lost` a reply of `ok: false` already answers with, two lines below.
    let reply: Awaited<ReturnType<typeof resolveHandleOnTab>>;
    try {
      reply = await resolve({
        taskId: context.taskId,
        operationId: context.operationId,
        runtimeEpochId: context.runtimeEpochId,
        nonce: context.nonce,
        expectedTabId: binding.tabId,
        canonicalOrigin: binding.canonicalOrigin,
        // 004/T155: the frame that claimed the ref carries its own epoch, the same way the click
        // confirmation's `documentEpoch ?? binding.documentEpoch` already does above - not the top
        // document's, which a nested frame's own document never shares.
        documentEpoch: documentEpoch ?? binding.documentEpoch,
        // Same reasoning, for the origin (004/T155): the frame that claimed the ref carries its own
        // origin; the top document's is the binding's own, unchanged. Comparing a cross-origin
        // frame's answer against the binding's origin refused a focus check on a document that
        // never moved.
        frameOrigin: frameOrigin ?? binding.canonicalOrigin,
        generalPageReadGrantId: context.generalPageReadGrantId,
        ...(frameId === undefined ? {} : { frameId }),
        tab: binding.tabId,
      });
    } catch {
      // 004/T161: the round trip never ran at all - the same `unsupported-page` family
      // `createTargetConfirmer` already answers `unconfirmed` for - so this is honestly "unknown",
      // not a confirmed loss of focus.
      return undefined;
    }
    // `ok: false` is the same "never ran" fact as the throw above (stale-context, refused upstream);
    // a resolved-but-different reply is a real check that ran and found something else, which is a
    // confirmed miss.
    if (reply.ok === false) return undefined;
    if (reply.outcome !== "resolved") return false;
    return reply.candidates.some((candidate) => candidate.targetHandle === ref);
  };
}

export type TargetLocatorDeps = {
  /** Where each frame's own viewport begins on the page (004/T125a); measured per delivery. */
  offsets: FrameOffsets;
  enumerateFrames?: FrameEnumerator;
  collect?: typeof collectFromActiveTab;
  /**
   * Whether a claimed frame is a genuine out-of-process (cross-site) frame with its own CDP
   * session, and which one (004/T129). Asked before any offset is composed - a session frame never
   * gets one, by design (`TargetRect.frame.sessionId`) - and only for a frame that has already
   * claimed a ref, never speculatively for every frame of the page. Absent means every claimed
   * frame is measured the existing way, which is what every same-site test still exercises.
   */
  sessionFor?: (tabId: number, frameId: number, expectedOrigin: string) => Promise<string | undefined>;
};

/**
 * One frame's answer about one ref (004/T136): where it is, that this frame's registry once bound
 * it but the element is gone, or nothing - this frame has never heard of it. A locate asks every
 * frame, so "gone" and "nothing" are not the same fact: only the frame that minted a ref can ever
 * answer "gone" for it, and every other frame answers "nothing" whether the ref is healthy elsewhere
 * or dead everywhere - the aggregation in `createTargetLocator` is what turns that per-frame split
 * into one page-level answer.
 */
type FrameLocateResult =
  | { rect: TargetRect; documentEpoch: string; canonicalOrigin: string; link?: true }
  | { gone: true };

/** One frame's answer to "is this ref yours, and where is it in your viewport", and its own epoch. */
async function locateInFrame(
  collect: typeof collectFromActiveTab,
  input: { context: AgentToolContext; binding: AgentPageBinding; ref: string; scroll: boolean },
  frameId: number | undefined,
): Promise<FrameLocateResult | undefined> {
  const collected = await collect({
    taskId: input.context.taskId,
    operationId: input.context.operationId,
    runtimeEpochId: input.context.runtimeEpochId,
    nonce: input.context.nonce,
    // `page.target-metadata` is what puts a handle on a node at all - the content runtime mints
    // under it and the broker projects under it - and this collection exists to ask "is this ref
    // yours", a question answered by comparing handles. Without it every node came back nameless,
    // so the comparison below matched nothing and an effect refused a ref `find` had just handed
    // back (004/T129e). It is the same pair `read_page` and `find` already ask this document for,
    // in the same lease and under the same general grant; a handle is opaque and carries no page
    // content, so nothing new about the page is disclosed by asking for the element's own name.
    requested: ["page.structure", "page.target-metadata"],
    generalGrantActive: true,
    generalPageReadGrantId: input.context.generalPageReadGrantId,
    formGrantActive: false,
    mintPolicy: "all-controls",
    rootTargetHandle: input.ref,
    // 004/T128, B67 G5 correction: the reference scrolls a ref's own element to the centre of its
    // frame before it takes the rect a click is computed from; we did not, and a target that lays
    // out below an ancestor iframe's own visible box was a real click on a real box that happened to
    // be off screen. This is the one collection that is about to deliver a coordinate at the rect it
    // measures - `read_page`/`find` never set it, because a read must never move the page, and
    // neither does a locate whose purpose is only to verify a rect it already delivered at
    // (004/T128, B70): the call site says which this is (`input.scroll`).
    scrollIntoView: input.scroll,
    includeFrameFacts: true,
    ...(frameId === undefined ? {} : { frameId }),
    tab: input.binding.tabId,
  });
  for (const node of collected.semanticNodes ?? []) {
    const entry = node as { targetHandle?: unknown; rect?: TargetRect; role?: unknown };
    if (entry.targetHandle === input.ref && entry.rect) {
      return {
        rect: entry.rect,
        documentEpoch: collected.documentEpoch,
        canonicalOrigin: collected.canonicalOrigin,
        // 015/T406: whether it is a link rides beside its box, for the press that needs to know.
        ...(entry.role === "link" ? { link: true as const } : {}),
      };
    }
  }
  // 004/T136: this frame's own registry told the collection it once bound this ref but the element
  // has left the document - this frame's answer for it is "gone", not merely "not found here".
  if ((collected as { rootTargetGone?: boolean }).rootTargetGone === true) return { gone: true };
  return undefined;
}

/**
 * Correlates a claimed frame to the CDP session that is *actually* it, when it has one (004/T129).
 *
 * Chrome's own frame id equals the target id an out-of-process frame attaches under - the fact
 * `Target.attachedToTarget` (`input.ts`) makes the session table cheap to build at all - but
 * nothing bridges that value to the numeric id this worker's own frame enumeration uses; the one
 * existing bridge between the two (`pairFrameTokens`, `frames.ts`) pairs siblings *by order*, which
 * is exactly the defect already removed from the same-origin offset chain, so it is not reused here
 * to invent the same kind of mistake in a new place. This settles the question a different way,
 * exactly rather than by position: it writes one nonce into the specific numeric frame a ref was
 * just found in - the same per-frame injection every other locate already uses, in the page's own
 * (`MAIN`) world so a bare evaluate can see it - and reads it back through each attached session
 * with one bounded `Runtime.evaluate` (no domain enabled; `input.ts`'s invariant).
 *
 * The echo alone only proves a session's document ran the script that wrote the nonce - not which
 * document that was, nor that it was the only one (004/T149). Three checks make the correlation
 * mean what it claims: the echoing session's own `url` (already in hand, never previously read) must
 * share the claimed frame's origin, ruling a leaked or guessed nonce useless without also occupying
 * that origin; every candidate is scanned rather than stopping at the first echo, and more than one
 * origin-matching echo - an order only the page itself controls, by choosing when it creates its
 * iframes - is refused rather than resolved by picking one; and the global is deleted after the
 * round trip either way, so it never persists as a stable tell that this extension is driving the
 * tab, on the one path whose whole point is input a page cannot distinguish from a person's.
 *
 * Skipped entirely when the tab has no attached session at all (`sessions` empty) - a same-site
 * page pays nothing for a question that only a cross-site one can answer yes to, and the presence
 * or absence of any session is itself the tab's own answer to "does this page have an OOPIF".
 */
export function createOopifSessionResolver(deps: {
  sessions: (tabId: number) => Array<{ sessionId: string; url: string }>;
  writeNonce: (tabId: number, frameId: number, nonce: string) => Promise<void>;
  clearNonce: (tabId: number, frameId: number) => Promise<void>;
  send: (
    tabId: number,
    method: string,
    params: Record<string, unknown>,
    sessionId: string,
  ) => Promise<Record<string, unknown>>;
}): (tabId: number, frameId: number, expectedOrigin: string) => Promise<string | undefined> {
  return async (tabId, frameId, expectedOrigin) => {
    const candidates = deps.sessions(tabId);
    if (candidates.length === 0) return undefined;
    const nonceBytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(nonceBytes);
    const nonce = `oopif-${frameId}-${[...nonceBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    try {
      await deps.writeNonce(tabId, frameId, nonce);
    } catch {
      // The frame could not be written to - it navigated away mid-delivery, most likely. There is
      // nothing left to correlate a session against.
      return undefined;
    }
    const matches: string[] = [];
    for (const candidate of candidates) {
      try {
        const evaluated = await deps.send(
          tabId,
          "Runtime.evaluate",
          { expression: "window.__pocAgentOopifNonce", returnByValue: true },
          candidate.sessionId,
        );
        const value = (evaluated as { result?: { value?: unknown } }).result?.value;
        if (value !== nonce) continue;
        let origin: string | undefined;
        try {
          origin = new URL(candidate.url).origin;
        } catch {
          origin = undefined;
        }
        if (origin === expectedOrigin) matches.push(candidate.sessionId);
      } catch {
        // This session could not be asked - detached mid-delivery, most likely - so it is passed
        // over; another candidate may still confirm.
      }
    }
    try {
      await deps.clearNonce(tabId, frameId);
    } catch {
      // Best-effort: the frame may already be gone. The tell it leaves behind is no worse than one
      // that was already going to disappear with the document.
    }
    return matches.length === 1 ? matches[0] : undefined;
  };
}

/**
 * Where the element is **on the page** (004/T121 for the box, T125 for the page it is on).
 *
 * A collection rooted at the handle is what answers the first half: the registry that minted the
 * ref is the thing that can still find its element, and every collected node carries the box its
 * own frame sees. Nothing about that box is remembered between calls - a coordinate cached across
 * an effect names whatever is painted there later, which is the addressing scheme refs exist to
 * avoid.
 *
 * The second half is the frame. A target registry is per document, so "whose ref is this" is a
 * question every frame can only answer about itself, and they are asked together. The frame that
 * claims it also decides the offset added to its answer, because the box it reported is in its own
 * viewport and input is addressed in the top document's. A frame that claims the ref but whose
 * offset could not be measured leaves the target *unlocated* - the effect says so, rather than
 * delivering a real click at the frame-local coordinates, which is a click on the page's own
 * furniture at that point.
 */
export function createTargetLocator(deps: TargetLocatorDeps): TargetLocatorSource {
  const collect = deps.collect ?? collectFromActiveTab;
  const enumerate = deps.enumerateFrames ?? enumerateTabFrames;
  return {
    forDelivery: () => {
      // One measurement per delivery, shared by every ref this delivery locates - a drag's two
      // endpoints and the re-measure that follows it walk the chain once between them - and
      // dropped with the locator when the delivery returns.
      let measurement: FrameOffsetMeasurement | undefined;
      return async (input) => {
        const frames = await tabFrames(input.binding.tabId, input.binding.canonicalOrigin, enumerate);
        if (frames.length <= 1) {
          // One document: the frame-local box *is* the page's, byte for byte the 003 path.
          // 004/T147 (S4 review): the multi-frame branch below already treats a frame it could not
          // ask (`collect` throws - the same `resolveBoundPage`/`ensureContentRuntime` class of
          // failure a confirmation now catches too) as one that has not claimed the ref; this, the
          // far more common single-document case, had no such guard and let the same throw escape
          // uncaught before the effect it was locating for had even been delivered.
          let located: FrameLocateResult | undefined;
          try {
            located = await locateInFrame(collect, input, undefined);
          } catch (error) {
            // 004/T161: `unsupported-page` is a fact about the page, not about this ref - re-reading
            // the page (what "not located" tells the agent to do) can never change it, so it is
            // named rather than collapsed into the same "not located" every other throw here means.
            return error instanceof Error && error.message === "unsupported-page"
              ? { notActionable: true }
              : undefined;
          }
          if (located === undefined) return undefined;
          if (!("rect" in located)) return { stale: true };
          return located.link ? { ...located.rect, link: true } : located.rect;
        }
        const found = await Promise.all(
          frames.map(async (frame) => {
            try {
              const located = await locateInFrame(collect, input, frame.frameId);
              return located === undefined ? undefined : { frame, ...located };
            } catch {
              // A frame that could not be asked has not claimed the ref; another one may still.
              return undefined;
            }
          }),
        );
        const claimed = found.find(
          (
            entry,
          ): entry is {
            frame: (typeof frames)[number];
            rect: TargetRect;
            documentEpoch: string;
            canonicalOrigin: string;
            link?: true;
          } => entry !== undefined && "rect" in entry,
        );
        if (!claimed) {
          // 004/T136: a locate asks every frame - the frame that minted a now-dead ref answers
          // "gone", and every other frame answers "never heard of it" (`locateInFrame`'s own
          // contract). The page's own answer is stale if *any* frame says gone, and not-located
          // only once every one of them says unknown.
          const anyGone = found.some((entry) => entry !== undefined && "gone" in entry);
          return anyGone ? { stale: true } : undefined;
        }

        // 004/T129: a genuinely cross-site frame is never in this tab's own process, so there is
        // nothing above it to compose an offset with - the debugger's own chain (`DOM.getFrameOwner`
        // et al.) never reaches into it either, which is the failure this branch exists ahead of
        // rather than a case that branch happens to also cover. Asked only for the frame that
        // already claimed the ref, never spent on every frame the page has.
        let sessionId: string | undefined;
        try {
          sessionId = await deps.sessionFor?.(input.binding.tabId, claimed.frame.frameId, claimed.canonicalOrigin);
        } catch {
          sessionId = undefined;
        }
        if (sessionId !== undefined) {
          return {
            x: claimed.rect.x,
            y: claimed.rect.y,
            width: claimed.rect.width,
            height: claimed.rect.height,
            ...(claimed.link ? { link: true as const } : {}),
            frame: {
              frameId: claimed.frame.frameId,
              rect: claimed.rect,
              documentEpoch: claimed.documentEpoch,
              canonicalOrigin: claimed.canonicalOrigin,
              sessionId,
            },
          };
        }

        measurement ??= deps.offsets.forDelivery(input.binding.tabId);
        const offset = await measurement.offsetFor(frames, claimed.frame.frameId);
        if (!offset) return undefined;
        return {
          x: claimed.rect.x + offset.x,
          y: claimed.rect.y + offset.y,
          width: claimed.rect.width,
          height: claimed.rect.height,
          ...(claimed.link ? { link: true as const } : {}),
          // 004/T128 gap 2: the frame that claimed the ref, and its box in that frame's own
          // viewport - what a same-frame confirmation has to ask in, since the offset above turns
          // that box into the *page's* coordinates and a confirmer asking frame 0 with a page point
          // asks the wrong document for a framed target. gap 3: and its own epoch, since that
          // document's freshness is a fact about it, never about the top document's. 004/T129: and
          // its own origin, for the same reason - a genuinely cross-origin frame never has the top
          // document's.
          frame: {
            frameId: claimed.frame.frameId,
            rect: claimed.rect,
            documentEpoch: claimed.documentEpoch,
            canonicalOrigin: claimed.canonicalOrigin,
          },
        };
      };
    },
  };
}

/** The four gestures that differ only in which button goes down and how many times (G6). */
const POINTER_CLICKS = {
  click: { capability: "browser.click", effect: "activated", button: "left", clickCount: 1 },
  right_click: {
    capability: "browser.right-click",
    effect: "context-activated",
    button: "right",
    clickCount: 1,
  },
  double_click: {
    capability: "browser.double-click",
    effect: "double-activated",
    button: "left",
    clickCount: 2,
  },
  triple_click: {
    capability: "browser.triple-click",
    effect: "triple-activated",
    button: "left",
    clickCount: 3,
  },
} as const satisfies Record<
  string,
  { capability: RuntimeAction; effect: string; button: PointerButton; clickCount: number }
>;

/** Which tools this slice delivers through the debugger rather than through the page. */
function isPointerTool(tool: AgentToolName): boolean {
  return tool in POINTER_CLICKS || tool === "hover" || tool === "drag";
}

/**
 * `computer`'s actions that press (015/T406, contracts/press-outcomes.md "Applies to"): the four
 * clicks `deliverPosition` delivers. `middle_click` is named by the contract "where supported";
 * this tool has none. `type` and `key` click only to place a caret, which is not the press asked for.
 */
function isPositionPress(action: string): boolean {
  return action === "left_click" || action === "right_click" || action === "double_click" || action === "triple_click";
}

/** The two the keyboard delivers (004/T123): typing a string, and pressing one named key. */
function isKeyboardTool(tool: AgentToolName): boolean {
  return tool === "type" || tool === "key";
}

/** The centre of a box, which is where a person's pointer lands on a control. */
function centreOf(rect: TargetRect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function createAgentEffects(deps: AgentEffectDeps): AgentEffectRunner {
  const execute = deps.execute ?? executeOnActiveTab;
  const probe = deps.probe ?? probeActiveTab;
  const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;
  const injected = deps.locate;
  const locators: TargetLocatorSource = injected
    ? { forDelivery: () => injected }
    : createTargetLocator({
        // 004/T128, B67: a same-origin chain measures its own offset in-page, in one round trip;
        // only a frame that walk could not reach the top from falls back to the debugger's chain,
        // which rides the same attachment the input does - one debugger on the tab, measured only
        // for a tab an effect is already being delivered to.
        offsets: createHybridFrameOffsets({
          measureInPage: enumerateFrameOffsets,
          cdp: createFrameOffsets({
            send: (tabId, method, params) => deps.attachments.send(tabId, method, params),
          }),
        }),
        // 004/T129: a claimed frame with its own out-of-process session skips the offset chain
        // above entirely (`createTargetLocator`'s own branch) - this is only how that frame's
        // session is found, never how its geometry is.
        sessionFor: createOopifSessionResolver({
          sessions: (tabId) => deps.attachments.oopifSessions(tabId),
          writeNonce: deps.writeFrameNonce ?? writeFrameNonce,
          clearNonce: deps.clearFrameNonce ?? clearFrameNonce,
          send: (tabId, method, params, sessionId) => deps.attachments.send(tabId, method, params, sessionId),
        }),
      });
  const confirmPoint = deps.confirm ?? createTargetConfirmer();
  const confirmFocus = deps.confirmFocus ?? createFocusConfirmer();
  const pointer: AgentPointerInput = createPointerInput({
    attachments: deps.attachments,
    ...(deps.cursor ? { cursor: deps.cursor } : {}),
  });
  const keyboard: AgentKeyboardInput = createKeyboardInput({ attachments: deps.attachments });
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        (timer as unknown as { unref?: () => void }).unref?.();
      }));
  const now = deps.now ?? (() => Date.now());
  const watchTabCreated = deps.watchTabCreated ?? watchChromeTabCreated;
  const readTabUrl = deps.tabUrl ?? chromeTabUrl;

  /** A tab's address for the observation; any failure to read it is "not known", never a throw. */
  async function tabUrlOf(tabId: number): Promise<string | undefined> {
    try {
      return await readTabUrl(tabId);
    } catch {
      return undefined;
    }
  }

  /**
   * Arms one press's window (015/T406, FR-200, FR-202, R-198).
   *
   * Called just before the input leaves, so a tab the press opens cannot be created before anyone
   * is listening, and so the downloads asked for later are exactly the ones started from this
   * moment on. It waits for nothing: the window is the settle wait verification already spends, and
   * `settle` is called when that wait ends, with the reads running beside the re-probe.
   */
  function armPress(tabId: number, sessionId: string): PressWatch {
    const since = now();
    const opened: Array<{ tabId: number; eventUrl: string | undefined }> = [];
    let unsubscribe: (() => void) | undefined = watchTabCreated((tab) => {
      // Only this press's: a tab the pressed tab opened. `openerTabId` is the browser's own link.
      if (tab.openerTabId !== tabId || tab.id === undefined) return;
      opened.push({ tabId: tab.id, eventUrl: tab.pendingUrl || tab.url || undefined });
    });
    const stop = (): void => {
      unsubscribe?.();
      unsubscribe = undefined;
    };
    let facts: Promise<PressFacts> | undefined;
    return {
      stop,
      settle() {
        facts ??= (async (): Promise<PressFacts> => {
          stop();
          const spentMs = Math.max(0, now() - since);
          const seen = opened.slice();
          const [url, newTabs, downloads] = await Promise.all([
            tabUrlOf(tabId),
            Promise.all(
              seen.map(async (tab) => ({
                tabId: tab.tabId,
                // The address now, which a tab opened a moment ago may only have as pending; the
                // event's own as the fallback. Empty rather than cut when neither fits.
                url: boundedUrl((await tabUrlOf(tab.tabId)) ?? tab.eventUrl) ?? boundedUrl(tab.eventUrl) ?? "",
                held: false as const,
              })),
            ),
            (async () => {
              if (!deps.downloads) return [];
              try {
                return await deps.downloads.createdSince(sessionId, since);
              } catch {
                return [];
              }
            })(),
          ]);
          const bounded = boundedUrl(url);
          return {
            ...(bounded === undefined ? {} : { url: bounded }),
            newTabs,
            downloads: downloads.map((record) => ({
              id: record.id,
              filename: record.filename,
              url: record.url,
              state: record.state,
            })),
            downloadsObserved: deps.downloads !== undefined,
            spentMs,
          };
        })();
        return facts;
      },
    };
  }

  /**
   * 004/T128 follow-up (B66): whether a key press's target kept focus, checked more than once
   * rather than sampled after one fixed wait. `Input.dispatchKeyEvent` resolves once Chrome has
   * queued the event, not once the renderer has run the page's own handler and settled focus
   * (measured live, T128/B65) - a constant sleep either over-pays once focus has already settled
   * or still loses the race on a loaded machine. This checks immediately, then again at short
   * intervals up to a ceiling, and stops the moment focus is confirmed.
   */
  async function pollFocusRetained(
    context: AgentToolContext,
    binding: AgentPageBinding,
    ref: string,
    /** The frame that claimed `ref` (004/T155); absent asks the top document. */
    frame?: TargetRect["frame"],
  ): Promise<boolean | undefined> {
    const ceilingMs = 50;
    const intervalMs = 10;
    for (let waited = 0; ; waited += intervalMs) {
      const retained = await confirmFocus({
        context,
        binding,
        ref,
        ...(frame
          ? { frameId: frame.frameId, documentEpoch: frame.documentEpoch, frameOrigin: frame.canonicalOrigin }
          : {}),
      });
      if (retained || waited >= ceilingMs) return retained;
      await sleep(intervalMs);
    }
  }

  /** One picture of a tab, region or whole, through the `screenshot` tool's own lookup. */
  async function photograph(tabId: number, region?: CaptureRegion) {
    return photographTab(
      { tabId, ...(region === undefined ? {} : { region }) },
      {
        ...(deps.capture ? { capture: deps.capture } : {}),
        ...(deps.listTabs ? { listTabs: deps.listTabs } : {}),
        ...(deps.captureDeps ? { captureDeps: deps.captureDeps } : {}),
        // The emulated frame and the way to photograph it (012/T311): the same two facts the
        // `screenshot` tool is given, so the two tools cannot answer different pictures of one tab.
        ...(deps.currentViewport ? { currentViewport: deps.currentViewport } : {}),
        send: (id, method, params) => deps.attachments.send(id, method, params),
        // 012/S2c F2: after an eviction the record says "emulated" while this worker holds no
        // attachment; the emulation's own holder is claimed rather than the picture being refused.
        ensureAttached: (id) => deps.attachments.acquire(id, "viewport"),
      },
    );
  }

  /** Turns one tool call into the runtime action, with every target already a ref. */
  async function planEffect(
    tool: AgentToolName,
    args: Record<string, unknown>,
    context: AgentToolContext,
    binding: AgentPageBinding,
  ): Promise<{ ok: true; plan: EffectPlan } | { ok: false; outcome: AgentNativeResponse["outcome"]; reason: string }> {
    const ref = async (
      target: AgentTarget | undefined,
    ): Promise<{ ok: true; ref: string } | { ok: false; outcome: AgentNativeResponse["outcome"]; reason: string }> => {
      const resolved = await resolveRef(context, binding, target);
      if (resolved.ok) return resolved;
      return resolved.reason === "stale"
        ? { ok: false, outcome: "stale", reason: "stale-context" }
        : { ok: false, outcome: "failed", reason: resolved.reason };
    };

    if (tool === "drag") {
      const from = await ref(args.from as AgentTarget);
      if (!from.ok) return from;
      const to = await ref(args.to as AgentTarget);
      if (!to.ok) return to;
      if (from.ref === to.ref) return { ok: false, outcome: "failed", reason: "same-endpoints" };
      return {
        ok: true,
        plan: {
          capability: "browser.drag",
          args: { targetHandle: from.ref, dropTargetHandle: to.ref },
          repeat: 1,
        },
      };
    }
    if (tool === "form_input") {
      // The one effect whose target is a `ref` and never a point: setting a control's value is
      // about that control's identity, and a coordinate names whatever is painted there when the
      // effect lands (contracts `agentFormInputShape`).
      return {
        ok: true,
        plan: {
          capability: "browser.form-input",
          args: { targetHandle: String(args.ref), value: args.value },
          repeat: 1,
        },
      };
    }
    if (tool === "scroll" && args.target === undefined) {
      return {
        ok: true,
        plan: {
          capability: "browser.scroll",
          args: {
            mode: "viewport",
            direction: (args.direction as "up" | "down" | undefined) ?? "down",
            magnitude: (args.amount as "small" | "medium" | "large" | undefined) ?? "medium",
          },
          repeat: 1,
        },
      };
    }

    const target = await ref(args.target as AgentTarget | undefined);
    if (!target.ok) return target;
    const handle = target.ref;
    switch (tool) {
      case "click":
        return { ok: true, plan: { capability: "browser.click", args: { targetHandle: handle }, repeat: 1 } };
      case "right_click":
        return { ok: true, plan: { capability: "browser.right-click", args: { targetHandle: handle }, repeat: 1 } };
      case "double_click":
        return { ok: true, plan: { capability: "browser.double-click", args: { targetHandle: handle }, repeat: 1 } };
      case "triple_click":
        return { ok: true, plan: { capability: "browser.triple-click", args: { targetHandle: handle }, repeat: 1 } };
      case "hover":
        return { ok: true, plan: { capability: "browser.hover", args: { targetHandle: handle }, repeat: 1 } };
      case "scroll":
        return {
          ok: true,
          plan: { capability: "browser.scroll", args: { mode: "target", targetHandle: handle }, repeat: 1 },
        };
      // `type` and `key` are not here: both leave through the keyboard now (004/T123), and a
      // plan for them would be a second, page-level route to the very input this slice replaces.
      default:
        return { ok: false, outcome: "failed", reason: "tool-not-implemented" };
    }
  }

  /**
   * The verification 003 wrote, over a delivery it did not have (004/T121).
   *
   * Nothing about the rule moves: the settle window, the re-probe of the bound tab, and the same
   * verdicts. What changes is where the evidence comes from. A page-level executor could say what
   * it had just done inside the document; the debugger's dispatch cannot - it returns when the
   * browser has queued the events, not when the page has finished reacting - so the *only* honest
   * synchronous evidence is what this worker measured itself (the box the page reported for the
   * target, and for a drag whether that box then moved). Everything else about the document is the
   * probe's to say, which is why an `ok` here still names something observed rather than sent.
   */
  /**
   * Waits for whatever is in flight, unless a dialog opens on that tab first (008/FR-111).
   *
   * The poll is on this worker's *own* map, never on the page: the dialog is heard as an event and
   * this only asks how the map stands, which costs nothing and cannot itself be blocked by a modal
   * renderer. `before` is what was open when the work started, so a dialog left over from earlier
   * does not end a wait it has nothing to do with.
   */
  function racingDialog<T>(
    tabId: number,
    before: CurrentDialog | undefined,
    work: Promise<T>,
  ): Promise<{ done: T } | { dialog: CurrentDialog }> {
    const look = deps.currentDialog;
    if (!look) return work.then((done) => ({ done }));
    let stopped = false;
    const watch = (async (): Promise<CurrentDialog | undefined> => {
      while (!stopped) {
        const now = look(tabId);
        if (now && now.id !== before?.id) return now;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, DIALOG_RACE_POLL_MS);
          (timer as unknown as { unref?: () => void }).unref?.();
        });
      }
      return undefined;
    })();
    return Promise.race([
      work.then((done) => ({ done }) as { done: T }),
      watch.then((dialog) => (dialog ? ({ dialog } as { dialog: CurrentDialog }) : new Promise<never>(() => {}))),
    ]).finally(() => {
      stopped = true;
      // The loser is still in flight against a page nobody can answer for; its settling - or its
      // failure - is not this call's news any more, and must not surface as an unhandled rejection.
      void work.catch(() => undefined);
    });
  }

  async function verifyDelivered(
    callId: string,
    capability: RuntimeAction,
    evidence: Extract<PageExecutionOutcome, { ok: true }>,
    binding: AgentPageBinding,
    context: AgentToolContext,
    /** The click family's own check on its own arithmetic (004/T128, T129); absent for everything else. */
    pointConfirmation?: TargetConfirmResult,
    /**
     * A press's window and whether its target was a link (015/T406); absent for every effect that
     * is not a press. The caller armed it before the input left and stops it when this returns.
     */
    press?: { watch: PressWatch; link: boolean },
  ): Promise<AgentNativeResponse> {
    // What was open before this effect, so a dialog found afterwards can be told from one that was
    // already there (008/T226): only a *new* one is this call's own doing.
    const dialogBefore = deps.currentDialog?.(binding.tabId);
    // 015/T406: the press's window ends the moment the settle wait does - synchronously, before the
    // re-probe is sent - and what it saw is read then, beside the probe rather than after it.
    let collecting: Promise<PressFacts> | undefined;
    const verifying = verifyPageEffect({
      executed: evidence,
      effect: { documentChanged: false },
      capability,
      tabId: binding.tabId,
      documentEpoch: binding.documentEpoch,
      canonicalOrigin: binding.canonicalOrigin,
      taskId: context.taskId,
      operationId: `verify-${callId}`,
      runtimeEpochId: context.runtimeEpochId,
      nonce: context.nonce,
      settleMs,
      probe,
      tab: binding.tabId,
      ...(pointConfirmation === undefined ? {} : { pointConfirmation: pointConfirmation.outcome }),
      ...(press === undefined
        ? {}
        : {
            onSettled: () => {
              collecting = press.watch.settle();
            },
          }),
    });
    /**
     * The dialog this effect raised, raced against the verification (008/FR-111, US3 scenario 1).
     *
     * Raced rather than awaited, because a page with a dialog open answers *nothing*: the verify
     * asks the content runtime for the document's state, the renderer is stopped behind the box,
     * and the call sat there until the host's own thirty-second bound - measured on the gate, which
     * is exactly the silence this feature exists to end. So the moment a dialog appears on that tab
     * the wait is over and the answer says what is actually known: the input was delivered, nothing
     * was verified, and here is the dialog that is why. The losing verification is left in flight -
     * it settles when the dialog is answered, and by then its verdict is about a page the agent has
     * already been told about.
     */
    const raced = await racingDialog(binding.tabId, dialogBefore, verifying);
    if ("dialog" in raced) {
      const unverified = observationOf(evidence, "target-unconfirmed");
      return unverified === undefined
        ? answer(callId, "failed", "unreadable-evidence")
        : { callId, outcome: "ok", result: { observed: unverified, dialog: raced.dialog } };
    }
    const verdict = raced.done;
    const current = deps.currentDialog?.(binding.tabId);
    /** A dialog that arrived just as the verification finished still belongs to this call. */
    const raised = current && current.id !== dialogBefore?.id ? current : undefined;
    if (verdict !== "verified") deps.bindings.invalidate(binding.tabId);
    const observed = observationOf(evidence, verdict);
    if (!observed) return answer(callId, "failed", "unreadable-evidence");
    // A `target-missed` verdict says what was actually under the point, when the page could say -
    // the same bounded role and name `find` already discloses under this grant (004/T129).
    const described =
      pointConfirmation?.outcome === "missed"
        ? {
            ...(pointConfirmation.role ? { role: pointConfirmation.role } : {}),
            ...(pointConfirmation.label ? { label: pointConfirmation.label } : {}),
          }
        : {};
    // 015/T406: what the press caused, now that the verdict says whether the document moved.
    // A verification that ended without its settle wait still closes the window here.
    const outcomes = press
      ? pressOutcome(await (collecting ?? press.watch.settle()), observed.documentChanged, press.link, settleMs)
      : undefined;
    return {
      callId,
      outcome: "ok",
      result: {
        observed: { ...observed, ...described, ...outcomes?.fields },
        ...(raised === undefined ? {} : { dialog: raised }),
      },
      ...(outcomes?.hint === undefined ? {} : { hint: outcomes.hint }),
    };
  }

  /**
   * One pointer gesture, delivered browser-level (004/T121, US5, G6, FR-064).
   *
   * The order inside is the order the page experiences: the pointer moves to the element's centre
   * and only then presses, so the hover state the page keeps for itself is true when the press
   * lands. A hover is that move and nothing after it.
   *
   * Two refusals come before any of it. A tab the debugger could not be attached to answers
   * `input-unavailable` with Chrome's reason and delivers nothing at all - there is no page-level
   * second route, because those are the events this replaces (R-113). And an element the document
   * can no longer place has no centre to aim at; clicking where it used to be would hit whatever is
   * painted there now, so the effect says it could not be located instead.
   */
  /**
   * Where a named target is, or the answer to give instead - shared by every browser-level effect.
   *
   * An element the document can no longer place has no point to aim at, and acting where it used
   * to be would touch whatever is painted there now, so the effect says it could not be located.
   */
  /**
   * A target's ref, without locating it yet (004/T128, B70). Split out of `locator` below so a
   * multi-point effect can name every point it needs *before* locating any of them - naming a point
   * target resolves it against the page as the page is right now (`content.resolve-point`), and a
   * locate that scrolls moves the page out from under a point not yet named.
   */
  function targetResolver(
    context: AgentToolContext,
    binding: AgentPageBinding,
    callId: string,
  ): (
    target: AgentTarget | undefined,
  ) => Promise<{ ok: true; ref: string } | { ok: false; response: AgentNativeResponse }> {
    return async (target) => {
      const resolved = await resolveRef(context, binding, target);
      if (resolved.ok) return { ok: true, ref: resolved.ref };
      return {
        ok: false,
        response:
          resolved.reason === "stale"
            ? answer(callId, "stale", "stale-context")
            : answer(callId, "failed", resolved.reason),
      };
    };
  }

  function locator(
    locate: TargetLocator,
    context: AgentToolContext,
    binding: AgentPageBinding,
    callId: string,
  ): (
    target: AgentTarget | undefined,
  ) => Promise<{ ok: true; ref: string; rect: TargetRect } | { ok: false; response: AgentNativeResponse }> {
    const resolve = targetResolver(context, binding, callId);
    return async (target) => {
      const resolved = await resolve(target);
      if (!resolved.ok) return resolved;
      // Every caller of this wrapper names and locates one point at a time, so this locate is
      // always the scrolling kind (004/T128, B70) - a drag's two endpoints go through
      // `targetResolver` and this locator's scroll-once rule directly, below, rather than here.
      const rect = await locate({ context, binding, ref: resolved.ref, scroll: true });
      // 004/T161: named ahead of the generic "not located" below - a page this extension may not
      // act on at all is not a ref that reading the page again could ever find.
      if (rect !== undefined && "notActionable" in rect) {
        return { ok: false, response: answer(callId, "not-actionable", "unsupported-page") };
      }
      if (rect === undefined) return { ok: false, response: answer(callId, "failed", "target-not-located") };
      // 004/T136: the ref resolved a moment ago (`targetResolver` above), but the element it names
      // has left the document since - a fact only this locate, which actually asks every frame, can
      // observe. That is a dead reference, not a page this locate simply could not search.
      if ("stale" in rect) return { ok: false, response: staleReferenceAnswer(callId) };
      return { ok: true, ref: resolved.ref, rect };
    };
  }

  async function deliverPointer(
    tool: AgentToolName,
    args: Record<string, unknown>,
    context: AgentToolContext,
    binding: AgentPageBinding,
    callId: string,
  ): Promise<AgentNativeResponse> {
    const acquired = await deps.attachments.acquire(binding.tabId, "input");
    if (!acquired.ok) return inputUnavailable(callId, acquired.unavailableReason);

    // This delivery's locator, and with it this delivery's frame geometry: it goes out of scope
    // when the gesture is answered, which is the whole lifetime an offset is trustworthy for.
    const locate = locators.forDelivery();
    const at = locator(locate, context, binding, callId);

    if (tool === "drag") {
      // Both endpoints are named before either is located (004/T128, B70): naming a point target
      // resolves it against the page as it is *right now* (`content.resolve-point`), and the first
      // endpoint's locate below is the scrolling kind - resolving the second endpoint after that
      // scroll would ask `content.resolve-point` at a coordinate the scroll had already moved the
      // page out from under.
      const resolve = targetResolver(context, binding, callId);
      const from = await resolve(args.from as AgentTarget);
      if (!from.ok) return from.response;
      const to = await resolve(args.to as AgentTarget);
      if (!to.ok) return to.response;
      if (from.ref === to.ref) return answer(callId, "failed", "same-endpoints");
      // A drag scrolls, if at all, once: the first endpoint's locate scrolls it into view, and the
      // second is measured in whatever scroll state that established, or the two coordinates
      // `pointer.drag` is about to use would describe two different scroll positions.
      const fromLocated = await locate({ context, binding, ref: from.ref, scroll: true });
      // 004/T161: named ahead of "not located" for the same reason `locator` above does.
      if (fromLocated !== undefined && "notActionable" in fromLocated) {
        return answer(callId, "not-actionable", "unsupported-page");
      }
      if (fromLocated === undefined) return answer(callId, "failed", "target-not-located");
      if ("stale" in fromLocated) return staleReferenceAnswer(callId);
      const toLocated = await locate({ context, binding, ref: to.ref, scroll: false });
      if (toLocated !== undefined && "notActionable" in toLocated) {
        return answer(callId, "not-actionable", "unsupported-page");
      }
      if (toLocated === undefined) return answer(callId, "failed", "target-not-located");
      if ("stale" in toLocated) return staleReferenceAnswer(callId);
      const fromRect = fromLocated;
      const toRect = toLocated;
      // 004/T151: `createTargetLocator` composes a same-site frame's offset into the page's own
      // coordinates, but a genuine out-of-process (OOPIF) frame gets none - there is nothing above
      // it in this tab's own process to compose with (`TargetRect.frame.sessionId`'s own doc) - so
      // its rect is frame-local, in a coordinate space only its own CDP session can interpret. A
      // gesture delivered through one session can only carry coordinates from one such space; only
      // `from`'s session is ever used below, so endpoints on either side of that boundary would
      // dispatch `to`'s coordinate as if it were `from`'s document's own, landing wherever that
      // document happens to have something, in a completely different document than the one the
      // agent named. Refused before anything is delivered, never guessed at.
      if (fromRect.frame?.sessionId !== toRect.frame?.sessionId) {
        return answer(callId, "failed", "cross-frame-drag");
      }
      // Both ends, for the path a recorded frame draws (008/FR-105); a no-op when nothing records.
      deps.onDelivered?.(callId, { from: centreOf(fromRect), to: centreOf(toRect) });
      await pointer.drag(binding.tabId, centreOf(fromRect), centreOf(toRect), {
        ...(fromRect.frame?.sessionId === undefined ? {} : { sessionId: fromRect.frame.sessionId }),
      });
      // Whether it moved is measured, not assumed: the dragged element's box is asked for again
      // and compared with the one the gesture started from. This locate verifies; it must not
      // scroll (004/T128, B70) - a scroll here would re-centre the element to exactly where the
      // delivering locate above already centred it, normalising away the very difference this
      // check exists to see.
      const after = await locate({ context, binding, ref: from.ref, scroll: false });
      const afterRect = after !== undefined && !("stale" in after) && !("notActionable" in after) ? after : undefined;
      const moved = afterRect !== undefined && (afterRect.x !== fromRect.x || afterRect.y !== fromRect.y);
      return verifyDelivered(
        callId,
        "browser.drag",
        { ok: true, effect: "dragged", moved, documentChanged: false },
        binding,
        context,
      );
    }

    const target = await at(args.target as AgentTarget | undefined);
    if (!target.ok) return target.response;
    const point = centreOf(target.rect);
    // The one place the point a click or a hover was aimed at exists (008/FR-105, R-136).
    deps.onDelivered?.(callId, { point });
    // The one thing this worker can see for itself about a hover: the page gave the element a box
    // with area, so there was something at that point to hover.
    const targetVisible = target.rect.width > 0 && target.rect.height > 0;

    if (tool === "hover") {
      await pointer.hover(binding.tabId, point, {
        ...(target.rect.frame?.sessionId === undefined ? {} : { sessionId: target.rect.frame.sessionId }),
      });
      // 004/T150: hover's entire purpose is to change what is under the pointer, so this worker's
      // own rect arithmetic (`targetVisible` above, kept as it was before the hover) is not evidence
      // that the hover landed - an overlay that steals the pointer leaves that rect untouched. The
      // confirmation asks the same question the click family already does (004/T128, T129): does the
      // delivered point actually resolve to the target now, in the frame that claimed it.
      const pointConfirmation = await confirmPoint({
        context,
        binding,
        ref: target.ref,
        point: target.rect.frame ? centreOf(target.rect.frame.rect) : point,
        ...(target.rect.frame
          ? {
              frameId: target.rect.frame.frameId,
              documentEpoch: target.rect.frame.documentEpoch,
              frameOrigin: target.rect.frame.canonicalOrigin,
            }
          : {}),
      });
      return verifyDelivered(
        callId,
        "browser.hover",
        { ok: true, effect: "hovered", targetVisible, documentChanged: false },
        binding,
        context,
        pointConfirmation,
      );
    }

    const gesture = POINTER_CLICKS[tool as keyof typeof POINTER_CLICKS];
    // 004/T128: the point is this worker's own arithmetic on the rect `at` reported - never page
    // semantics - and it is checked rather than assumed, because the rect it came from is exactly
    // the thing that has been wrong before with nothing to catch it. The confirmation itself has to
    // ask the frame that claimed the target, in that frame's own coordinates (gap 2): frame 0 asked
    // about a page-level point refuses a framed click whether or not the delivered point was right,
    // which is unmeasurable rather than honest.
    //
    // Checked *before* the click leaves, not after (004/T168). The question is whether the point
    // resolves to the target; a click's own effect changes what is under that point - a play
    // button whose click draws the player's controls over it, a toggle that expands into the box it
    // hid - so a hit-test made afterwards answers with whatever the effect put there and reported
    // `target-missed` on clicks that landed exactly where they were aimed. Measured on YouTube's
    // embed: the delivered point was the button's centre to the pixel, the video played, and the
    // post-click hit-test found the control that had replaced the button. `hover` keeps its check
    // after delivery (T150): its whole purpose is to change what is under the pointer.
    const pointConfirmation = await confirmPoint({
      context,
      binding,
      ref: target.ref,
      point: target.rect.frame ? centreOf(target.rect.frame.rect) : point,
      ...(target.rect.frame
        ? {
            frameId: target.rect.frame.frameId,
            documentEpoch: target.rect.frame.documentEpoch,
            frameOrigin: target.rect.frame.canonicalOrigin,
          }
        : {}),
    });
    const evidence = {
      ok: true,
      effect: gesture.effect,
      clicks: gesture.clickCount,
      documentChanged: false,
    } as Extract<PageExecutionOutcome, { ok: true }>;
    /**
     * The dispatch itself is raced, not only the verification (008/FR-111, measured on the gate).
     *
     * `Input.dispatchMouseEvent` waits for the renderer to have handled the event, and a handler
     * that calls `alert` *is* the renderer stopping - so the command that delivered the click never
     * returns while the box is up. A confirm opened a moment later (the ordinary case) returns
     * normally and is caught by the verification's own race below; this is the other case, where
     * the dialog and the click are the same turn.
     */
    const before = deps.currentDialog?.(binding.tabId);
    // 015/T406: armed just before the press leaves, so nothing it opens is created unheard; stopped
    // however this call answers.
    const watch = armPress(binding.tabId, context.sessionId);
    try {
      const delivery = await racingDialog(
        binding.tabId,
        before,
        pointer.click(binding.tabId, point, {
          button: gesture.button,
          clickCount: gesture.clickCount,
          ...(target.rect.frame?.sessionId === undefined ? {} : { sessionId: target.rect.frame.sessionId }),
        }),
      );
      if ("dialog" in delivery) {
        const unverified = observationOf(evidence, "target-unconfirmed");
        return unverified === undefined
          ? answer(callId, "failed", "unreadable-evidence")
          : { callId, outcome: "ok", result: { observed: unverified, dialog: delivery.dialog } };
      }
      return await verifyDelivered(callId, gesture.capability, evidence, binding, context, pointConfirmation, {
        watch,
        link: target.rect.link === true,
      });
    } finally {
      watch.stop();
    }
  }

  /**
   * Typing and a key press, delivered browser-level (004/T123, US5, G7, FR-064).
   *
   * A key event goes wherever the page's focus is, so a named target is *clicked* first - the way a
   * person reaches the field they are about to type in, and the only route the debugger gives us to
   * put the caret somewhere. Without a target the keys go to whatever already has focus, which is
   * what an absent target has meant since 003.
   *
   * What comes back is what this worker measured itself, on B36's rule: the characters it
   * delivered, and the key it pressed. Whether the page's suggestion list opened is the probe's to
   * say - a protocol dispatch returns when the events are queued, not when the page has reacted.
   */
  async function deliverKeyboard(
    tool: AgentToolName,
    args: Record<string, unknown>,
    context: AgentToolContext,
    binding: AgentPageBinding,
    callId: string,
  ): Promise<AgentNativeResponse> {
    const acquired = await deps.attachments.acquire(binding.tabId, "input");
    if (!acquired.ok) return inputUnavailable(callId, acquired.unavailableReason);

    const named = args.target as AgentTarget | undefined;
    // The ref a named target resolved to, kept for the key branch below (004/T128, B65): it is what
    // "the target kept focus" is checked against once the keys have been delivered.
    let clickedRef: string | undefined;
    // The frame that claimed the clicked target (004/T155): the focus check below has to ask that
    // frame's own document, in its own identity - never the tab's, the same distinction the click
    // confirmation already draws for `frameId`, `documentEpoch` and `frameOrigin`.
    let clickedFrame: TargetRect["frame"];
    // The frame's own CDP session, when the click above landed on a genuinely out-of-process frame
    // (004/T129): the keys that follow have to reach the same document the click just focused, not
    // the tab's own top-level session, or they land wherever that session's page has focus instead.
    let sessionId: string | undefined;
    /**
     * A dispatch raced against the worker's dialog map, as the click path's is (016/FR-242, R-208).
     *
     * A key handler - or the focusing click's own handler - that calls `alert` holds the dispatch for
     * as long as the box is up, exactly as a click's does; without the race the call waited out the
     * input deadline and answered page-not-responding for a page that had simply asked the owner
     * something. `evidence` is what this call can say it delivered up to that point, unconfirmed.
     */
    const racedDelivery = async (
      evidence: Extract<PageExecutionOutcome, { ok: true }>,
      work: () => Promise<unknown>,
    ): Promise<AgentNativeResponse | undefined> => {
      const before = deps.currentDialog?.(binding.tabId);
      const delivery = await racingDialog(binding.tabId, before, work());
      if (!("dialog" in delivery)) return undefined;
      const unverified = observationOf(evidence, "target-unconfirmed");
      return unverified === undefined
        ? answer(callId, "failed", "unreadable-evidence")
        : { callId, outcome: "ok", result: { observed: unverified, dialog: delivery.dialog } };
    };
    // What the call had delivered when a dialog took the focusing click: nothing of its own keys.
    const beforeKeys = (): Extract<PageExecutionOutcome, { ok: true }> =>
      (tool === "type"
        ? { ok: true, effect: "text-entered", charactersChanged: 0, documentChanged: false }
        : { ok: true, effect: "key-pressed", key: String(args.key ?? ""), documentChanged: false }) as Extract<
        PageExecutionOutcome,
        { ok: true }
      >;
    if (named !== undefined) {
      const target = await locator(locators.forDelivery(), context, binding, callId)(named);
      if (!target.ok) return target.response;
      clickedRef = target.ref;
      clickedFrame = target.rect.frame;
      sessionId = clickedFrame?.sessionId;
      /**
       * The marker, before the first thing this call puts into the page (014 FR-181).
       *
       * The pointer family writes it with the point it measured, for the ring a recorded frame
       * draws; here there is no point worth drawing - the click is how a caret is placed, not the
       * action the owner asked for - so the record carries nothing and says only what it is for:
       * from this line on, an interrupt cannot honestly say the page was given nothing.
       */
      deps.onDelivered?.(callId, {});
      const focusing = await racedDelivery(beforeKeys(), () =>
        pointer.click(binding.tabId, centreOf(target.rect), {
          button: "left",
          clickCount: 1,
          ...(sessionId === undefined ? {} : { sessionId }),
        }),
      );
      if (focusing !== undefined) return focusing;
    }

    if (tool === "type") {
      const text = String(args.text ?? "");
      // 004/T159 (second review): T146 asked whether the clicked target kept focus, but only after
      // `keyboard.type` had already run - the wrong-field scenario was reported honestly, but
      // `replace` mode's own select-all-and-delete, and the text itself, had already gone into the
      // wrong field by then. Moved to right here, between the click and the typing, so a caret that
      // never landed on the named target refuses *before* a single character is sent. An absent
      // target names nothing to check focus against, so it verifies exactly as before (undefined
      // stays undefined).
      //
      // Checked once, and deliberately not re-checked after typing finishes (decision, T159 second
      // half): a control that moves focus **by design** while it types - an OTP box auto-advancing
      // between digits, a combobox handing focus to its own listbox - would otherwise be reported as
      // `focus-lost` for behaviour that is not a failure at all, and this worker has no way to tell
      // that case apart from a genuine wrong-field click after the fact. The only fact it can stand
      // behind honestly is whether the caret was in the named target *before* typing started, which
      // is also the only moment a wrong-field click can still be refused rather than merely confessed.
      const focusRetained =
        clickedRef === undefined ? undefined : await pollFocusRetained(context, binding, clickedRef, clickedFrame);
      if (focusRetained === false) {
        return verifyDelivered(
          callId,
          "browser.enter-text",
          {
            ok: true,
            effect: "text-entered",
            charactersChanged: 0,
            documentChanged: false,
            focusRetained,
          } as Extract<PageExecutionOutcome, { ok: true }>,
          binding,
          context,
        );
      }
      // The keys themselves, with or without a target above (014 FR-181).
      const typed = {
        ok: true,
        effect: "text-entered",
        // The characters this worker delivered, counted the way it delivered them - by code
        // point, so an emoji is the one character it was typed as.
        charactersChanged: [...text].length,
        documentChanged: false,
        ...(focusRetained === undefined ? {} : { focusRetained }),
      } as Extract<PageExecutionOutcome, { ok: true }>;
      deps.onDelivered?.(callId, {});
      const dialogAnswer = await racedDelivery(typed, () =>
        keyboard.type(binding.tabId, text, {
          replace: args.mode !== "insert",
          ...(sessionId === undefined ? {} : { sessionId }),
        }),
      );
      if (dialogAnswer !== undefined) return dialogAnswer;
      return verifyDelivered(callId, "browser.enter-text", typed, binding, context);
    }

    const key = String(args.key ?? "");
    deps.onDelivered?.(callId, {});
    const pressedDialog = await racedDelivery(beforeKeys(), () =>
      keyboard.press(binding.tabId, key, {
        ...(Array.isArray(args.modifiers) ? { modifiers: args.modifiers as string[] } : {}),
        repeat: Number(args.repeat ?? 1),
        ...(sessionId === undefined ? {} : { sessionId }),
      }),
    );
    if (pressedDialog !== undefined) return pressedDialog;
    // 004/T128, B65: a named target's own document says whether it still has focus, asked the same
    // way the click family confirms its point - fresh, after delivery, never assumed. An absent
    // target names nothing to check focus against, so it verifies exactly as before (undefined
    // stays undefined, the pre-existing behaviour this fix does not touch). `pollFocusRetained`
    // is the bounded poll, not a fixed wait (T128 follow-up, B66).
    const focusRetained =
      clickedRef === undefined ? undefined : await pollFocusRetained(context, binding, clickedRef, clickedFrame);
    return verifyDelivered(
      callId,
      "browser.key-press",
      {
        ok: true,
        effect: "key-pressed",
        key,
        documentChanged: false,
        ...(focusRetained === undefined ? {} : { focusRetained }),
      } as Extract<PageExecutionOutcome, { ok: true }>,
      binding,
      context,
    );
  }

  /**
   * What acting by position establishes *before* the owner is asked (004/T139, US7, FR-070).
   *
   * Every other effect names an element and the worker works out where it is; this one names where,
   * and there may be nothing there at all - so the two facts a coordinate needs are settled first:
   * the attachment the input will leave by, and the tab's own viewport. A point past the edge is
   * refused here, before the gate, for two reasons that point the same way: the owner should not be
   * asked about a click that was never going to be delivered, and the refusal names the viewport,
   * which is what lets the agent aim the next attempt instead of guessing.
   *
   * `screenshot` and `wait` do neither. They land nowhere - the contract forbids them a point - so
   * attaching a debugger for them would put Chrome's "being debugged" bar in front of the owner for
   * a call that touches nothing.
   */
  async function preflightPosition(
    args: Record<string, unknown>,
    binding: AgentPageBinding,
    callId: string,
  ): Promise<
    | { ok: true; point?: PositionPoint; viewport?: Viewport }
    | { ok: false; response: AgentNativeResponse }
  > {
    const action = String(args.action);
    if (action === "screenshot" || action === "wait") return { ok: true };

    const acquired = await deps.attachments.acquire(binding.tabId, "input");
    if (!acquired.ok) return { ok: false, response: inputUnavailable(callId, acquired.unavailableReason) };

    const viewport = await measureViewport(binding.tabId, (tabId, method, params) =>
      deps.attachments.send(tabId, method, params),
    );
    // A tab that will not say how big it is cannot be aimed at. Nothing is delivered on a guess:
    // the same reasoning as an element the document can no longer place.
    if (!viewport) return { ok: false, response: answer(callId, "failed", "viewport-unknown") };

    const point = positionOf(args);
    if (point && !insideViewport(point, viewport)) {
      return { ok: false, response: outsideViewport(callId, viewport) };
    }
    return { ok: true, ...(point === undefined ? {} : { point }), viewport };
  }

  /**
   * The picture the owner decides by (004/T139, FR-069).
   *
   * Taken only when the gate actually asks - a site the owner set to allow never pays for it, and
   * the capture is not free: it brings the agent's tab to the front and puts the owner's back.
   * Reading a tab is ungated by design, so taking it before the answer is not a decision made
   * without consent; delivering anything would be, and nothing is.
   *
   * When the worker could not crop, the crop is left off rather than sent as a whole-viewport
   * picture labelled with a rectangle it is not: the owner then decides on the summary, as they do
   * for every other effect.
   */
  async function promptCrop(
    binding: AgentPageBinding,
    point: PositionPoint,
    viewport: Viewport,
  ): Promise<Pick<Parameters<AgentPromptController["ask"]>[0], "targetCrop">> {
    const region = cropAround(point, viewport);
    const photo = await photograph(binding.tabId, region);
    if (!photo.ok || !photo.image.cropped) return {};
    return { targetCrop: { mimeType: "image/png", data: photo.image.data, ...region } };
  }

  /**
   * One `computer` call, once the owner's decision is in (004/T139, US7, R-120).
   *
   * The two actions that touch nothing are answered here; everything else leaves through
   * `deliverPosition`, which is four calls into the same pointer and keyboard every other effect
   * uses. There is no second dispatcher, and that is the whole design of the tool: a coordinate is
   * a different *address*, never a different way of reaching the page.
   */
  async function runPosition(
    args: Record<string, unknown>,
    point: PositionPoint | undefined,
    context: AgentToolContext,
    binding: AgentPageBinding,
    callId: string,
  ): Promise<AgentNativeResponse> {
    const action = String(args.action);

    if (action === "screenshot") {
      const photo = await photograph(binding.tabId);
      if (!photo.ok) {
        // The attachment's refusal in the attachment's own words (012/S2c F2), exactly as every
        // other action in this file answers one.
        if (photo.reason === "input-unavailable") return inputUnavailable(callId, photo.unavailableReason);
        return answer(callId, photo.reason === "tab-gone" ? "stale" : "not-readable", photo.reason);
      }
      // The `screenshot` tool's own shape, so an agent that took one either way reads one answer.
      // `cropped` is false because this action never asks for a region: the field says whether a
      // requested rectangle was applied, and there was none to apply - which is also why `coverage`
      // is always the viewport here. The rest are 012's fields, carried when they are known: the
      // frame says which pixels the coordinates this tool takes are in, and that is the one thing
      // an agent aiming a click at a picture has to be told.
      return {
        callId,
        outcome: "ok",
        result: {
          mimeType: "image/png",
          data: photo.image.data,
          cropped: false,
          ...(photo.image.width === undefined || photo.image.height === undefined
            ? {}
            : { width: photo.image.width, height: photo.image.height }),
          scale: photo.image.scale,
          ...(photo.frame === undefined ? {} : { frame: photo.frame }),
          coverage: "viewport",
        },
      };
    }

    if (action === "wait") {
      const startedAt = Date.now();
      await sleep(Number(args.ms));
      // 003's `wait` words for a wait that ended the one way a fixed wait can end well, so a
      // position wait and a `wait` call report the same thing.
      return {
        callId,
        outcome: "ok",
        result: { outcome: "condition-met", waitedMs: Math.max(0, Date.now() - startedAt) },
      };
    }

    /**
     * The marker, before the first thing this action puts into the page (014 FR-181, review F5).
     *
     * Every action still here reaches the page - the two that do not were answered above - so this
     * is the line after which an interrupt cannot honestly say the page was given nothing. It
     * carries no point: the ring a recorded frame draws belongs to the gesture families that
     * measured a target's box, and `computer` was aimed by the agent rather than measured here.
     */
    deps.onDelivered?.(callId, {});

    // 015/T406: the four position clicks are presses like any other and report what they caused.
    // Nothing located the point's element, so there is no role to call it a link by: a position
    // press that caused nothing states its window and carries no link hint.
    const watch = isPositionPress(action) ? armPress(binding.tabId, context.sessionId) : undefined;
    try {
      const effect = await deliverPosition({
        tabId: binding.tabId,
        action,
        args,
        point,
        pointer,
        keyboard,
      });
      return await verifyDelivered(
        callId,
        effect.capability,
        { ok: true, ...effect.evidence } as Extract<PageExecutionOutcome, { ok: true }>,
        binding,
        context,
        undefined,
        watch === undefined ? undefined : { watch, link: false },
      );
    } finally {
      watch?.stop();
    }
  }

  /**
   * What the chaining rule may be told about (008/FR-112, S4 review).
   *
   * The record answers one question - "did the owner approve something *on this page* a moment
   * ago" - so only an action that reaches the page may write one. `computer` is the exception in
   * the list of gated tools: a `screenshot` takes a picture and a `wait` sleeps, neither touches
   * the renderer, and a record written for either would hand whatever a timer opens a second later
   * an accept the owner never agreed to.
   */
  function noteApproval(tabId: number, tool: AgentToolName, args: Record<string, unknown>): void {
    if (tool === "computer") {
      const action = String(args.action);
      if (action === "screenshot" || action === "wait") return;
    }
    deps.onApproved?.(tabId, tool);
  }

  async function runEffect(request: AgentToolRequest): Promise<AgentNativeResponse> {
    const { callId, tool } = request;
    const context = deps.context.forCall(request.sessionId, callId);
    const parsed = agentToolArgSchemas[tool].safeParse(request.args);
    if (!parsed.success) {
      return answer(callId, "failed", "invalid-arguments");
    }
    const args = parsed.data as Record<string, unknown>;
    const tabId = typeof args.tabId === "number" ? args.tabId : request.tabId;
    if (tabId === undefined) return answer(callId, "failed", "no-tab");
    const ownership = await deps.tabOwnership(request.sessionId, tabId);
    if (ownership.state !== "this") {
      // FR-034: a tab this session does not hold is not this agent's to touch, whatever the site
      // mode says about it - and the refusal says whether anyone else has it (004/T104).
      return ownershipRefusal(callId, ownership);
    }

    const bound = await deps.bindings.bind(tabId, context);
    if (!bound.ok) {
      // 015/T401 (FR-206): a page that is still open and did not answer in time is `failed`, with
      // the reason and what may help, never the `stale` that sends the agent to re-read a page
      // that never went anywhere.
      return bindingFailureResponse(callId, bound, "not-actionable");
    }
    const binding = bound.binding;

    if (tool === "find") {
      const found = await findOnTab(context, binding, String(args.query), Number(args.maxCandidates ?? 3));
      return found.ok
        ? { callId, outcome: "ok", result: found.result }
        : answer(callId, found.reason === "stale" ? "stale" : "not-readable", found.reason);
    }

    // Acting by position settles its address before anybody is asked about it (004/T139).
    let position: { point?: PositionPoint; viewport?: Viewport } = {};
    if (tool === "computer") {
      const preflight = await preflightPosition(args, binding, callId);
      if (!preflight.ok) return preflight.response;
      position = preflight;
    }

    const record = await deps.siteModes.get(binding.site);
    const decision = decideGate({
      sessionId: context.sessionId,
      tabId,
      site: binding.site,
      mode: record.mode,
      tool,
      args,
      ...(deps.statedPlan ? { plan: deps.statedPlan(binding.site) } : {}),
      // 017: the calling session's own plan, for the site this decision is about.
      sitePlanCovers: (await deps.sitePlanCovers?.(request.sessionId, binding.site)) === true,
    });
    if (decision.decision === "refuse") {
      return answer(callId, "failed", decision.reason);
    }
    if (decision.decision === "admit" && decision.step !== undefined) {
      deps.onAdmitted?.(binding.site, decision.step);
    }
    if (decision.decision === "admit") {
      // 008/R-139: the owner's consent for this tab is now a moment old, and a dialog that opens
      // inside the next second belongs to it. Recorded on admission for the same reason the plan
      // advances there - it is the decision that is being remembered, not the outcome.
      noteApproval(tabId, tool, args);
    }
    if (decision.decision === "prompt") {
      const asked = await deps.prompts.ask({
        // Whose question this is (B5): the host giving up on *this* call takes it down, and a
        // backstop for some other call leaves it standing.
        callId,
        // And which call the host knows it as, when this effect is a batch step (011 review H1).
        hostCallId: request.hostCallId,
        // And whether the owner ended the call while the runner was still getting here (FR-179).
        stopped: request.stopped,
        sessionId: request.sessionId,
        site: binding.site,
        tool,
        argsSummary: summariseToolCall(tool, args),
        // The one target that cannot be described in words: a picture of the place instead.
        ...(position.point && position.viewport
          ? await promptCrop(binding, position.point, position.viewport)
          : {}),
      });
      if (asked.decision === "busy") return answer(callId, "busy", "prompt-pending");
      if (asked.decision === "timed-out") {
        // FR-043: nothing ran. The prompt is dead, so a late Allow cannot start it either. And if
        // it was raised where nobody could see it, the answer says where to click (011 FR-146).
        return noAnswerResponse(callId, asked);
      }
      // 006 FR-087: the owner's Stop reaches a parked call in the same word an in-flight wait gets.
      if (asked.decision === "stopped") return answer(callId, "stopped", "owner-stopped");
      // 014 FR-179: the owner ended this step and kept the session; not a decline, and not a stop.
      if (asked.decision === "interrupted") return answer(callId, "stopped", "owner-interrupted");
      if (asked.decision === "deny") return answer(callId, "denied", "owner-denied");
      /**
       * The lease, read again now that the owner has answered (006 FR-087, S1 review).
       *
       * The check at the top of this call is a fact about the moment the question was raised. The
       * owner may press Release tabs while it stands and then answer "only this time" - or the
       * release itself may be what ended the question - and either way the tab is theirs again, so
       * the effect is refused exactly as any unheld tab is, before anything is delivered.
       */
      const held = await deps.tabOwnership(request.sessionId, tabId);
      if (held.state !== "this") return ownershipRefusal(callId, held);
      if (asked.decision === "released") return ownershipRefusal(callId, { state: "not-yours" });
      if (asked.rememberMode) {
        // FR-042: the owner may set the site's mode from inside the prompt they are answering.
        await deps.siteModes.set(binding.site, { mode: asked.rememberMode as SiteMode });
      }
      // The owner's own yes, which is the other half of "approved" (008/R-139).
      noteApproval(tabId, tool, args);
    }

    if (tool === "computer") {
      const delivered = await answeringInputDeadline(
        callId,
        runPosition(args, position.point, context, binding, callId),
      );
      if (delivered.outcome === "ok") deps.onEffect?.(request.sessionId, binding.tabId);
      return delivered;
    }

    if (isPointerTool(tool) || isKeyboardTool(tool)) {
      // Browser-level from here (004/T121, T123). The gate has already decided, and the refs are
      // resolved inside, so the order every effect keeps - own, bind, gate, resolve, act, verify -
      // is the same one whichever way the input is delivered.
      const delivered = await answeringInputDeadline(
        callId,
        isPointerTool(tool)
          ? deliverPointer(tool, args, context, binding, callId)
          : deliverKeyboard(tool, args, context, binding, callId),
      );
      if (delivered.outcome === "ok") deps.onEffect?.(request.sessionId, binding.tabId);
      return delivered;
    }

    const planned = await planEffect(tool, args, context, binding);
    if (!planned.ok) return answer(callId, planned.outcome, planned.reason);

    /**
     * The marker, before the page is asked to do it (014 FR-181, T369 review F5).
     *
     * `scroll` and `form_input` are the two effects that still run inside the page rather than
     * through the debugger, and they were the two that wrote nothing here - so an interrupt that
     * landed after one had gone out answered "nothing was delivered" about a page that had already
     * been told to scroll or to take a value. Nothing is drawn for them (no point was measured);
     * the record says only what it is for.
     */
    deps.onDelivered?.(callId, {});

    let last: Extract<PageExecutionOutcome, { ok: true }> | undefined;
    for (let attempt = 0; attempt < planned.plan.repeat; attempt += 1) {
      let outcome: PageExecutionOutcome;
      try {
        outcome = await execute({
          taskId: context.taskId,
          operationId: context.operationId,
          runtimeEpochId: context.runtimeEpochId,
          capability: planned.plan.capability,
          arguments: planned.plan.args,
          documentEpoch: binding.documentEpoch,
          canonicalOrigin: binding.canonicalOrigin,
          nonce: context.nonce,
          expectedTabId: binding.tabId,
          // Decision 3: the owner's per-site consent has already decided this call, so the page's
          // classification refusals are skipped. Nothing else is.
          policy: "trusted-agent",
          tab: binding.tabId,
        });
      } catch (error) {
        // The executor threw *after* the effect may have begun, which is the one case where nothing
        // was observed at all. It is never reported as success.
        deps.reportDiagnostic?.("agent.effect.execute-uncertain");
        return answer(callId, "failed", error instanceof Error ? error.message : "execute-failed");
      }
      if (!outcome.ok) {
        const mapped = refusalOutcome(outcome.reason);
        return answer(callId, mapped.outcome, mapped.reason);
      }
      last = outcome;
      if (outcome.documentChanged === true) break;
    }
    if (!last) return answer(callId, "failed", "nothing-executed");

    const dialogBefore = deps.currentDialog?.(binding.tabId);
    const verifying = verifyPageEffect({
      executed: last,
      effect: { documentChanged: last.documentChanged === true },
      capability: planned.plan.capability,
      tabId: binding.tabId,
      documentEpoch: binding.documentEpoch,
      canonicalOrigin: binding.canonicalOrigin,
      taskId: context.taskId,
      operationId: `verify-${callId}`,
      runtimeEpochId: context.runtimeEpochId,
      nonce: context.nonce,
      settleMs,
      probe,
      tab: binding.tabId,
    });
    // The same race the browser-level path runs (008/FR-111): a page holding a dialog open answers
    // no verification at all, so the dialog ends the wait and is what this call reports.
    const raced = await racingDialog(binding.tabId, dialogBefore, verifying);
    if ("dialog" in raced) {
      const unverified = observationOf(last, "target-unconfirmed");
      if (unverified !== undefined) {
        deps.onEffect?.(request.sessionId, binding.tabId);
        return { callId, outcome: "ok", result: { observed: unverified, dialog: raced.dialog } };
      }
      return answer(callId, "failed", "unreadable-evidence");
    }
    const verdict = raced.done;
    if (verdict !== "verified") {
      // The document moved under the effect, or the effect's own evidence says it did not land.
      // Every handle bound to that document is gone with it.
      deps.bindings.invalidate(binding.tabId);
    }
    // A dialog that arrived just as the verification finished is still this effect's news.
    const current = deps.currentDialog?.(binding.tabId);
    const raised = current && current.id !== dialogBefore?.id ? current : undefined;
    const observed = observationOf(last, verdict);
    if (!observed) return answer(callId, "failed", "unreadable-evidence");
    deps.onEffect?.(request.sessionId, binding.tabId);
    return { callId, outcome: "ok", result: { observed, ...(raised === undefined ? {} : { dialog: raised }) } };
  }

  /**
   * An input dispatch the page did not answer (015/T402, FR-206, R-197): the same outcome and reason
   * as a binding that hit the deadline, but not its "retry" - the input was delivered and may have
   * taken effect (review F1), so the hint sends the agent to look first. Anything else a delivery
   * throws goes on exactly as before.
   */
  async function answeringInputDeadline(
    callId: string,
    delivery: Promise<AgentNativeResponse>,
  ): Promise<AgentNativeResponse> {
    try {
      return await delivery;
    } catch (error) {
      if (!isInputDispatchDeadline(error)) throw error;
      return {
        callId,
        outcome: AGENT_015_REASON_OUTCOMES["page-not-responding"],
        reason: "page-not-responding",
        hint: INPUT_NOT_ANSWERED_HINT,
      };
    }
  }

  return {
    handles(tool) {
      return tool === "find" || isAgentEffectTool(tool);
    },
    run: runEffect,
  };
}
