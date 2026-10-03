import { AGENT_TOOL_NAMES, type AgentActivityItem, type AgentToolName, type SiteMode } from "@hallpass/contracts";

/**
 * Every message key the agent side panel can put on screen (003/T068, rebuilt in 006 S1).
 *
 * It is a module of its own, and the panel imports it rather than holding the strings inline, for
 * two reasons. The panel's own maps - a site mode, a tool - are lookups keyed by closed contract
 * values, so the compiler can insist there is a key for every value the worker may send. And the
 * list is then something a test can walk without rendering React: the locale contract checks that
 * every key here resolves in both locales, which is the only way a missing zh-TW string is caught
 * before an owner meets it.
 */

/**
 * The three modes, in the order they widen. Each has its own reviewed sentence rather than a
 * transliteration of the contract value: the owner is choosing what an agent may do to their pages,
 * and "skip-checks" is not what that choice sounds like in a person's language.
 */
export const MODE_KEYS: Record<SiteMode, string> = {
  ask: "agent.modeAsk",
  "follow-a-plan": "agent.modeFollowAPlan",
  "skip-checks": "agent.modeSkipChecks",
};

/**
 * One sentence per tool, for the question the owner is actually answering.
 *
 * The worker sends its own summary of a call in the projection, and that summary is written in
 * English by code that has no idea who is reading it. What is *shown* is looked up here instead:
 * the projection names the tool, the tool is a closed set, and every panel sentence then comes from
 * the same reviewed tables as the rest of the section. The price is that the sentence describes the
 * tool rather than its arguments - which is what the panel is allowed to know anyway (FR-035).
 */
export const TOOL_SUMMARY_KEYS: Record<AgentToolName, string> = Object.fromEntries(
  AGENT_TOOL_NAMES.map((tool) => [tool, `agent.summary.${tool}`]),
) as Record<AgentToolName, string>;

/**
 * The two sentences `upload_image` has, when the question knows which one it is (014 FR-196).
 *
 * One tool, two acts the owner would answer differently: handing a screenshot to a file field, and
 * dropping it at a point on the page. The generic sentence above covers both and says neither,
 * which is the right answer only while the projection cannot tell them apart - so these are keyed
 * off `AgentEffectPrompt.delivery` and used exactly when it is present.
 */
export const UPLOAD_DELIVERY_SUMMARY_KEYS: Record<"input" | "drop", string> = {
  input: "agent.summary.upload_image.input",
  drop: "agent.summary.upload_image.drop",
};

/**
 * One reviewed word per outcome an activity item can carry (008 FR-113).
 *
 * Keyed off the contract's own value the same way the tool summaries are, so an outcome added to
 * the projection cannot reach a card with no sentence for it: the compiler asks for the key, and
 * the locale contract test asks for the string in both languages.
 */
export const ACTIVITY_OUTCOME_KEYS: Record<AgentActivityItem["outcome"], string> = {
  accepted: "agent.activity.accepted",
  "accepted-chained": "agent.activity.accepted-chained",
  dismissed: "agent.activity.dismissed",
  refused: "agent.activity.refused",
  "closed-by-owner": "agent.activity.closed-by-owner",
  stayed: "agent.activity.stayed",
  left: "agent.activity.left",
  exported: "agent.activity.exported",
  restored: "agent.activity.restored",
  // 012: the two outcomes a viewport item can carry (FR-159).
  set: "agent.activity.set",
  cleared: "agent.activity.cleared",
  // 013: what became of a picture the session put into a page (FR-174). Delivery, never
  // acceptance: what the page then does with the file is the page's own business.
  delivered: "agent.activity.delivered",
  // 014: the owner ended a step and kept everything else (FR-182).
  interrupted: "agent.activity.interrupted",
  // 017: what became of a session site plan (FR-263).
  approved: "agent.activity.approved",
  replaced: "agent.activity.replaced",
  withdrawn: "agent.activity.withdrawn",
  ended: "agent.activity.ended",
};

/**
 * The two window states `resize_window` can have taken a window out of (008 FR-119).
 *
 * A state word is the browser's, not a sentence, so the card looks it up like every other word it
 * shows: the worker's activity item carries `maximized` or `fullscreen` and the panel says what
 * that means in the owner's language.
 */
export const WINDOW_STATE_KEYS: Record<"maximized" | "fullscreen", string> = {
  maximized: "agent.activity.windowMaximized",
  fullscreen: "agent.activity.windowFullscreen",
};

/**
 * Every key the section looks up, in one list.
 *
 * The static ones are written out; the three keyed maps are expanded from the contract's own closed
 * sets, so a mode or a tool added there arrives here without anybody remembering to add it.
 */
export const AGENT_PANEL_KEYS: readonly string[] = [
  // 016 FR-224: no `agent.appTitle` - the browser's side-panel header already names the product.
  // The not-connected page (FR-082).
  "agent.notPaired.title",
  "agent.notPaired.body",
  "agent.bridgeLost.title",
  "agent.bridgeLost.body",
  "agent.retry",
  "agent.details.title",
  "agent.details.relayPid",
  "agent.details.recordPath",
  "agent.details.lastDisconnect",
  "agent.details.lastDisconnectReason",
  "agent.details.none",
  // The status row (FR-083).
  "agent.status.connected",
  // The session count and the per-agent unpair (016 FR-223).
  "agent.status.sessions",
  "agent.status.sessionsOne",
  "agent.status.sessionsNone",
  "agent.status.unpairAgent",
  "agent.status.menu",
  "agent.unpair",
  // 018 FR-268, FR-279: this browser's name, its inline rename, and how many others are connected.
  "agent.browser.this",
  "agent.browser.rename",
  "agent.browser.renameLabel",
  "agent.browser.nameLabel",
  "agent.browser.save",
  "agent.browser.cancel",
  "agent.browser.nameInvalid",
  "agent.browser.others",
  "agent.browser.othersOne",
  // 018 FR-274: the in-browser choice card ("Use this browser for <agent>?").
  "agent.browserChoice.title",
  "agent.browserChoice.body",
  "agent.browserChoice.confirm",
  "agent.browserChoice.decline",
  // The site list (FR-086).
  "agent.sitesTitle",
  "agent.sitesNone",
  "agent.siteModeLabel",
  "agent.siteRevoke",
  // 016 FR-235 – FR-237: no permissive badge and no "granted" line; the visible texts of the
  // checkbox and the revoke, whose accessible names carry the site.
  "agent.siteRevokeText",
  "agent.diagnosticsLabel",
  "agent.diagnosticsText",
  // The moves the owner remembered, listed in the same place and revoked the same way (014 FR-191).
  "agent.transitionsTitle",
  "agent.transitionRow",
  "agent.transitionLastUsed",
  "agent.transitionNeverUsed",
  "agent.transitionRevoke",
  // The directories the local host may read uploads from, and their revoke (014 FR-191, FR-192).
  "agent.uploadRootsTitle",
  "agent.uploadRootsIntro",
  "agent.uploadRootsEmpty",
  "agent.uploadRootsPath",
  "agent.uploadRootsMalformed",
  "agent.uploadRootsPreserved",
  "agent.uploadRootNotRecorded",
  "agent.uploadRootRevoke",
  "agent.uploadRootPending",
  // The session cards (FR-087).
  // 016 FR-228 – FR-234: title, subtitle, the three states, the last action, the id under technical
  // details, and the controls that are shown only when they would do something.
  "agent.session.started",
  "agent.session.holds",
  "agent.session.holdsOne",
  "agent.session.noSites",
  "agent.session.siteSeparator",
  "agent.session.working",
  "agent.session.waiting",
  "agent.session.idle",
  "agent.session.idleUnknown",
  "agent.session.justNow",
  "agent.session.minutesAgo",
  "agent.session.hoursAgo",
  "agent.session.id",
  "agent.session.stop",
  "agent.session.takeBack",
  // 017 FR-259: the active site plan on the card.
  "agent.session.sitePlan",
  "agent.session.sitePlanOne",
  "agent.session.sitePlanWithdraw",
  // The second control beside Stop, and what it says when nothing was running (014 FR-178).
  "agent.session.interrupt",
  "agent.session.nothingToInterrupt",
  // The recording line (008 FR-109).
  "agent.session.recording",
  "agent.session.recordingFull",
  "agent.session.recordingExported",
  // The activity list (008 FR-113). The outcome words are expanded from the contract's own closed
  // set below, the way the modes and the tools are, so an outcome added there arrives here.
  "agent.activity.title",
  "agent.activity.dialog",
  // The window a session gave back (008 FR-119).
  "agent.activity.restore",
  // The emulated viewport a session gave a tab, and gave back (012 FR-159).
  "agent.activity.viewportSet",
  "agent.activity.viewportCleared",
  // 017 FR-263: the site-plan activity sentence.
  "agent.activity.sitePlan",
  "agent.activity.sitePlanOne",
  // The picture a session put into one of the owner's pages (013 FR-174), and the panel's own word
  // for a page whose site the worker did not resolve.
  "agent.activity.uploadInput",
  "agent.activity.uploadDrop",
  "agent.activity.unknownSite",
  // The step the owner ended themselves (014 FR-182).
  "agent.activity.interrupt",
  // The dialog questions and the non-blocking notice (008 FR-114, FR-115).
  "agent.prompt.dialogAccept",
  "agent.prompt.dialogQuote",
  "agent.prompt.beforeunloadForce",
  // The move a tab made, and the owner's three answers to it (014 FR-187, FR-188).
  "agent.prompt.transition",
  "agent.transitionContinue",
  "agent.transitionAlways",
  "agent.transitionDecline",
  // The files outside the owner's directories, and their three answers (014 FR-193).
  "agent.prompt.uploadDirectory",
  "agent.uploadFileDirectory",
  "agent.uploadOnce",
  "agent.uploadAlways",
  "agent.uploadDecline",
  "agent.notice.dialogAccepted",
  "agent.notice.dialogFollows",
  "agent.notice.dismiss",
  // The prompts (FR-084, FR-085) and the plan card.
  "agent.pairingTitle",
  "agent.pairingBody",
  "agent.pairingOrigin",
  "agent.pairingWaiting",
  "agent.forwardingDisclosure",
  "agent.accept",
  "agent.ignore",
  "agent.promptTitle",
  "agent.consentBody",
  "agent.promptTarget",
  "agent.promptCropAlt",
  "agent.allowOnce",
  "agent.allowAlways",
  "agent.refuse",
  "agent.planTitle",
  "agent.planSite",
  "agent.planExclude",
  "agent.approvePlan",
  "agent.denyPlan",
  // 017 FR-251, FR-252: the site-plan card.
  "agent.sitePlan.title",
  "agent.sitePlan.purpose",
  "agent.sitePlan.originsTitle",
  "agent.sitePlan.alreadyApproved",
  "agent.sitePlan.stepsTitle",
  "agent.sitePlan.warning",
  "agent.sitePlan.approve",
  "agent.sitePlan.decline",
  ...Object.values(MODE_KEYS),
  ...Object.values(TOOL_SUMMARY_KEYS),
  ...Object.values(UPLOAD_DELIVERY_SUMMARY_KEYS),
  ...Object.values(ACTIVITY_OUTCOME_KEYS),
  ...Object.values(WINDOW_STATE_KEYS),
];
