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
  "agent.appTitle",
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
  "agent.status.menu",
  "agent.unpair",
  // The site list (FR-086).
  "agent.sitesTitle",
  "agent.sitesNone",
  "agent.siteModeLabel",
  "agent.siteRevoke",
  "agent.sitePermissive",
  "agent.diagnosticsLabel",
  "agent.diagnosticsGranted",
  // The session cards (FR-087).
  "agent.session.label",
  "agent.session.sites",
  "agent.session.noSites",
  "agent.session.working",
  "agent.session.waiting",
  "agent.session.stop",
  "agent.session.release",
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
  // The picture a session put into one of the owner's pages (013 FR-174), and the panel's own word
  // for a page whose site the worker did not resolve.
  "agent.activity.uploadInput",
  "agent.activity.uploadDrop",
  "agent.activity.unknownSite",
  // The dialog questions and the non-blocking notice (008 FR-114, FR-115).
  "agent.prompt.dialogAccept",
  "agent.prompt.dialogQuote",
  "agent.prompt.beforeunloadForce",
  "agent.notice.dialogAccepted",
  "agent.notice.dialogFollows",
  "agent.notice.dismiss",
  // The prompts (FR-084, FR-085) and the plan card.
  "agent.pairingTitle",
  "agent.pairingBody",
  "agent.pairingOrigin",
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
  ...Object.values(MODE_KEYS),
  ...Object.values(TOOL_SUMMARY_KEYS),
  ...Object.values(ACTIVITY_OUTCOME_KEYS),
  ...Object.values(WINDOW_STATE_KEYS),
];
