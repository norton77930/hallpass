import { z } from "zod";
import { KEY_PRESS_KEYS, KEY_PRESS_MODIFIERS } from "./action-arguments.js";
import { DEFAULT_BOUNDS } from "./bounds.js";
import {
  AGENT_UPLOAD_MAX_BASE64_CHARS,
  AGENT_UPLOAD_MAX_FILES,
  TARGET_VISIBILITIES,
  WAIT_CONDITIONS,
} from "./common.js";

/**
 * The closed boundaries of the local-agent bridge (003).
 *
 * Three of them live here because three parties have to agree on them and none of the three may
 * decide alone: the MCP host outside the browser, the service worker inside it, and the side panel
 * the owner answers from. Everything is `strictObject`, so a frame carrying a field this file does
 * not declare is refused at the boundary rather than reaching a handler that ignores it - the same
 * rule the 001/002 runtime frames follow.
 *
 * Per-tool argument and result shapes are deliberately stubs at this point: the tool *names* are
 * closed now because the router dispatches on them, while each tool's arguments are pinned by the
 * slice that implements it.
 */

/**
 * How a tool call ended. Closed, and answered exactly once per call.
 *
 * `denied` is the owner's decision, `stopped` is the owner's Stop, `timed-out` is an `ask` prompt
 * that was never answered - three different facts that a single "refused" would have flattened, and
 * the agent behaves differently for each. `not-readable` and `not-actionable` are the same
 * restricted page seen by a read and by an effect.
 */
export const AGENT_TOOL_OUTCOMES = [
  "ok",
  "denied",
  "stale",
  "busy",
  "not-readable",
  "not-actionable",
  "stopped",
  "timed-out",
  "failed",
  /**
   * 017 (data-model "Tool answer"): the owner said no to a whole site plan. Not `denied`, which is
   * a refusal of one action: a declined proposal refused nothing the agent did, it only granted
   * nothing, and the agent carries on asking site by site as before.
   */
  "declined",
  /**
   * 017 FR-265, R-251: the other end cannot do this at all - an extension that never said it
   * supports site plans. Neither a refusal nor a failure of the call: the `hint` says what to update.
   */
  "unavailable",
] as const;

export type AgentToolOutcome = (typeof AGENT_TOOL_OUTCOMES)[number];

export const agentToolOutcomeSchema = z.enum(AGENT_TOOL_OUTCOMES);

/**
 * Every tool the bridge offers. The list is closed at the contract, not at the registry, so a name
 * cannot be dispatched anywhere in the worker before it exists here.
 */
export const AGENT_TOOL_NAMES = [
  // Tabs and windows (US1/US4)
  "tabs_context",
  "tabs_create",
  "tabs_close",
  "tabs_claim",
  "tabs_release",
  "navigate",
  "resize_window",
  // The emulated viewport (012 US1)
  "viewport",
  // Reads (US2)
  "get_page_text",
  "read_page",
  "find",
  "screenshot",
  // Effects (US3)
  "click",
  "right_click",
  "double_click",
  "triple_click",
  "hover",
  "drag",
  "type",
  "key",
  "scroll",
  "form_input",
  "computer",
  // Composition (US5)
  "browser_batch",
  "wait",
  // Diagnostics (US6)
  "read_console",
  "read_network",
  "evaluate",
  // Upload (US7)
  "file_upload",
  // 013 US1: the same delivery, for a picture this session took rather than a file on disk.
  "upload_image",
  // Downloads (005 US2)
  "downloads_context",
  // Recording (008 US1)
  "gif_recorder",
  // Dialogs (008 US3)
  "dialog",
  // Session site plan (017 US1)
  "propose_sites",
  // Several browsers (018 US1, US3): answered by the host, never forwarded to a worker (R-273).
  "list_browsers",
  "select_browser",
  "request_browser_choice",
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export const agentToolNameSchema = z.enum(AGENT_TOOL_NAMES);

/**
 * The tools that change the page, and therefore the tools the owner's per-site decision governs
 * (FR-041).
 *
 * It is a contract value rather than a list inside the gate because two independent places have to
 * agree on it: the worker decides consent from it, and the host describes each tool to the agent
 * from the same table. A tool that changed the page but was missing from this list would run under
 * nobody's consent, so the list is closed here and the gate refuses anything not on it rather than
 * defaulting to admit.
 *
 * Reads and tab management are deliberately absent: reading is ungated by design (US2), and creating
 * or closing the agent's own tabs is bounded by the session's group rather than by a site (FR-034).
 */
export const AGENT_EFFECT_TOOL_NAMES = [
  "click",
  "right_click",
  "double_click",
  "triple_click",
  "hover",
  "drag",
  "type",
  "key",
  "scroll",
  "form_input",
  /**
   * 004: acting by position is an effect like any other (data-model PositionAction). It reaches the
   * page through browser-level input rather than through a ref, which makes it wider than a click,
   * not narrower - a tool that changed the page from outside this list would run under nobody's
   * consent.
   */
  "computer",
] as const satisfies readonly AgentToolName[];

export type AgentEffectToolName = (typeof AGENT_EFFECT_TOOL_NAMES)[number];

export function isAgentEffectTool(value: unknown): value is AgentEffectToolName {
  return (AGENT_EFFECT_TOOL_NAMES as readonly unknown[]).includes(value);
}

/**
 * The page actions an approved session site plan admits without a card (017 FR-254, R-250).
 *
 * The worker gate's own set of gated tools (`requiresGate`) minus the three that keep their own
 * consent (FR-255): page JavaScript (`evaluate`) and putting files or screenshots into a page
 * (`file_upload`, `upload_image`) - and minus the two that are gated only when forced (`navigate`,
 * `tabs_close`): leaving a page that asked to stay throws away the owner's unsaved work, which is
 * not one of FR-254's page actions, so it still asks under a plan (S1 architecture review).
 * Written out rather than derived, so a future gated tool is *uncovered* until someone decides
 * otherwise; a contract test pins it against the gate.
 */
export const AGENT_SITE_PLAN_COVERED_TOOLS = [
  ...AGENT_EFFECT_TOOL_NAMES,
  "dialog",
] as const satisfies readonly AgentToolName[];

export type AgentSitePlanCoveredToolName = (typeof AGENT_SITE_PLAN_COVERED_TOOLS)[number];

/**
 * The placeholder argument shape, until the slice that owns a tool replaces it.
 *
 * It is deliberately permissive rather than empty: an empty strict object would make every call
 * fail today and would hide, behind a schema error, the fact that the shape has not been decided.
 * A tool whose arguments still parse through this stub has no argument contract yet, which is a
 * visible gap rather than a silent one.
 */
const agentToolArgStubSchema = z.looseObject({});

/**
 * The tab an effect lands on. Always named, never inferred: the agent owns several tabs and the one
 * the user is looking at is usually not one of them, so "the active tab" is not a meaning this
 * caller may have. The worker still checks the tab belongs to the session's group (FR-034).
 */
const agentTabIdSchema = z.number().int().nonnegative();

/**
 * A handle the page's own target registry minted (R-106). It is opaque here on purpose: the worker
 * resolves it against the registry, and a value this contract could interpret would be a second
 * addressing scheme beside the registry's.
 */
const agentRefSchema = z.string().min(1).max(256);

/**
 * A frame's label inside one answer: `0` for the top document, `f1`, `f2`… in tree order (004,
 * data-model FrameNode).
 *
 * Opaque and answer-scoped, like a ref. It is not Chrome's frame id and must not become one: a
 * stable browser-wide handle for a document is a thing an agent could keep and re-use after the
 * page it belonged to is gone.
 */
const agentFrameLabelSchema = z.string().min(1).max(32);

/**
 * A viewport coordinate, in CSS pixels, as the page currently renders. It is turned into a ref by
 * `content.resolve-point` before anything acts on it, so a point and a ref have exactly the same
 * lifetime and the same one definition of stale.
 */
const agentPointSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
});

/**
 * What an effect acts on: a ref *or* a point, and never both.
 *
 * A union of two strict objects rather than one object with optional fields, because "both" has no
 * meaning and an agent that sent both would be asking the worker to pick - a choice that belongs to
 * neither of them.
 */
const agentTargetSchema = z.union([z.strictObject({ ref: agentRefSchema }), agentPointSchema]);

/**
 * The native dialog a page has open on one tab (008 US3, data-model CurrentDialog).
 *
 * It sits among the shared shapes because it is not one tool's answer: it rides on whatever call
 * the dialog interrupted, on the refusal of every call the dialog blocks, and on the `dialog`
 * tool's own answer. Three places, one description.
 *
 * `message` is the only page-written text in it, and it is here deliberately (D-008-5): the words
 * on the dialog are what the owner is being asked about and what the agent has to read to answer
 * sensibly, so they are carried whole and bounded rather than summarised into a shape that would
 * hide the question. Nothing else about the page travels with it - no url, no document text.
 *
 * `chainedTo` is the one fact that decides whether answering costs the owner a second decision: a
 * dialog that opened within a second of an effect they just approved is part of that action rather
 * than a new one, and the tool and the time it was approved at are what make that checkable.
 */
export const currentDialogSchema = z.strictObject({
  /** A session counter (`d1`, `d2`…), not anything the page chose. */
  id: z.string().min(1).max(64),
  type: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
  message: z.string().max(4000),
  /** A prompt's pre-filled answer, as the page set it; absent for the other three. */
  defaultValue: z.string().max(4000).optional(),
  openedAt: z.number().int().nonnegative(),
  tabId: agentTabIdSchema,
  chainedTo: z
    .strictObject({ tool: z.string().min(1).max(64), approvedAt: z.number().int().nonnegative() })
    .optional(),
});

export type CurrentDialog = z.infer<typeof currentDialogSchema>;

/** As many frames as one recording holds; the 201st is not dropped, the recording stops (D-008-2). */
export const AGENT_RECORDING_MAX_FRAMES = 200;

/**
 * How a session's recording stands (008 US1, data-model Recording).
 *
 * Optional on every answer a recorded action can produce, so an agent learns the count without
 * asking and learns `full` at the moment it stops being able to record - which is the one thing it
 * would otherwise discover only by finding frames missing from the file at the end.
 *
 * `skipped` is said rather than hidden: a capture that failed is a frame the agent will not find,
 * and a recorder that quietly dropped them would report a run it did not record.
 */
export const recordingStateSchema = z.strictObject({
  state: z.enum(["none", "recording", "stopped"]),
  frames: z.number().int().nonnegative().max(AGENT_RECORDING_MAX_FRAMES),
  skipped: z.number().int().nonnegative(),
  full: z.boolean(),
});

export type RecordingState = z.infer<typeof recordingStateSchema>;

/**
 * What every answer a recording can contain may carry beside its own result (contracts README §2).
 *
 * Both fields optional, and spread into the existing strict shapes rather than wrapping them: a 005
 * caller that never records and never meets a dialog sees exactly the answer it saw before.
 */
const agentAnswerContextShape = {
  recording: recordingStateSchema.optional(),
  dialog: currentDialogSchema.optional(),
};

const pointerToolShape = {
  tabId: agentTabIdSchema,
  target: agentTargetSchema,
};

const pointerToolArgsSchema = z.strictObject(pointerToolShape);

const agentDragShape = {
  tabId: agentTabIdSchema,
  from: agentTargetSchema,
  to: agentTargetSchema,
};

const agentDragArgsSchema = z
  .strictObject(agentDragShape)
  .superRefine((value, ctx) => {
    const ref = (target: unknown): string | undefined =>
      typeof (target as { ref?: unknown }).ref === "string" ? (target as { ref: string }).ref : undefined;
    if (ref(value.from) !== undefined && ref(value.from) === ref(value.to)) {
      // The same rule 002's drag arguments carry: a gesture with one endpoint is not a drag, and
      // the runtime would have nothing to compare a "moved" observation against.
      ctx.addIssue({ code: "custom", message: "A drag needs two distinct endpoints", path: ["to"] });
    }
  });

const agentTypeShape = {
  tabId: agentTabIdSchema,
  /** Absent means the focused element, which is the only target `type` can have without a ref. */
  target: agentTargetSchema.optional(),
  text: z.string().max(DEFAULT_BOUNDS.maxTextEntryChars),
  /** `replace` is the default because it is the one an agent can predict the result of. */
  mode: z.enum(["insert", "replace"]).default("replace"),
};

const agentTypeArgsSchema = z.strictObject(agentTypeShape);

/** The bound on a repeated key. Ten is a navigation gesture; a hundred is a way to hold a page busy. */
const AGENT_KEY_REPEAT_MAX = 10;

const agentKeyShape = {
  tabId: agentTabIdSchema,
  target: agentTargetSchema.optional(),
  key: z.enum(KEY_PRESS_KEYS),
  modifiers: z.array(z.enum(KEY_PRESS_MODIFIERS)).max(1).optional(),
  repeat: z.number().int().min(1).max(AGENT_KEY_REPEAT_MAX).default(1),
};

const agentKeyArgsSchema = z
  .strictObject(agentKeyShape)
  .superRefine((value, ctx) => {
    if (value.modifiers && value.modifiers.length > 0 && value.key !== "Tab") {
      // The same single supported combination the runtime can deliver (002/R-022). Accepting more
      // here would let an agent state a press the page will never see.
      ctx.addIssue({ code: "custom", message: "Shift is supported only with Tab", path: ["modifiers"] });
    }
  });

const agentScrollShape = {
  tabId: agentTabIdSchema,
  /** A target scrolls into view; a direction scrolls the viewport. Exactly one of the two. */
  target: agentTargetSchema.optional(),
  direction: z.enum(["up", "down"]).optional(),
  amount: z.enum(["small", "medium", "large"]).optional(),
};

const agentScrollArgsSchema = z
  .strictObject(agentScrollShape)
  .superRefine((value, ctx) => {
    const viewport = value.direction !== undefined || value.amount !== undefined;
    if (value.target !== undefined && viewport) {
      ctx.addIssue({ code: "custom", message: "a scroll is either into view or by direction" });
    }
    if (value.target === undefined && value.direction === undefined) {
      ctx.addIssue({ code: "custom", message: "a scroll needs a target or a direction", path: ["direction"] });
    }
  });

const agentFormInputShape = {
  tabId: agentTabIdSchema,
  /**
   * A ref, never a point. Setting a control's value is about the control's identity, and a
   * coordinate names whatever happens to be painted there when the effect lands.
   */
  ref: agentRefSchema,
  /** A string for text and select, a boolean for a checkbox or radio. Nothing else is a value. */
  value: z.union([z.string().max(DEFAULT_BOUNDS.maxTextEntryChars), z.boolean()]),
};

const agentFormInputArgsSchema = z.strictObject(agentFormInputShape);

/**
 * Acting where a person would point, for the pages a ref cannot reach (004 US7, FR-070).
 *
 * The nine actions are the reference agent's own, so an agent already trained on them keeps its
 * habits: everything here is delivered as browser-level input at a top-level viewport coordinate,
 * which is why there is no `ref` and no target union. It is the tool of last resort - a canvas, a
 * native-looking menu, anything the accessibility tree does not describe - and every other tool is
 * still the better one where a ref exists.
 */
export const AGENT_COMPUTER_ACTIONS = [
  "screenshot",
  "left_click",
  "right_click",
  "double_click",
  "triple_click",
  "type",
  "key",
  "scroll",
  "wait",
] as const;

export type AgentComputerAction = (typeof AGENT_COMPUTER_ACTIONS)[number];

/** The actions that land somewhere, and therefore the ones a coordinate is required for. */
const AGENT_COMPUTER_POSITION_ACTIONS = [
  "left_click",
  "right_click",
  "double_click",
  "triple_click",
  "scroll",
] as const satisfies readonly AgentComputerAction[];

/** The actions a coordinate would mean nothing to: one photographs the tab, the other waits. */
const AGENT_COMPUTER_POSITIONLESS_ACTIONS = ["screenshot", "wait"] as const satisfies readonly AgentComputerAction[];

/**
 * A top-level viewport coordinate in CSS pixels (data-model PositionAction).
 *
 * Top-level, always: an element inside a frame is turned into one of these by the worker's own
 * frame-offset cache, because browser-level input has no notion of a frame. A point outside the
 * viewport is refused *with the viewport's size*, which is a fact about the browser rather than
 * about the page and is the one thing that lets the agent aim again.
 */
const agentViewportCoordinateSchema = z.number().finite().nonnegative().max(50_000);

const agentComputerShape = {
  /**
   * The tab the point is *in* (004/T139).
   *
   * Every other tool names its tab, and this one has more need of it than most: a coordinate means
   * nothing without the viewport it is measured in, and a session holding three tabs would
   * otherwise be asking the worker to guess which viewport it meant.
   */
  tabId: agentTabIdSchema,
  action: z.enum(AGENT_COMPUTER_ACTIONS),
  x: agentViewportCoordinateSchema.optional(),
  y: agentViewportCoordinateSchema.optional(),
  /** What `type` enters, as keystrokes the page cannot tell from a person's. */
  text: z.string().max(DEFAULT_BOUNDS.maxTextEntryChars).optional(),
  /** What `key` presses. The same closed set every other key press in this repository uses. */
  key: z.enum(KEY_PRESS_KEYS).optional(),
  /** How far `scroll` scrolls, in wheel clicks; negative is up. */
  amount: z.number().int().min(-100).max(100).optional(),
  /** How long `wait` waits. */
  ms: z.number().int().min(1).max(DEFAULT_BOUNDS.maxWaitMs).optional(),
};

const agentComputerArgsSchema = z.strictObject(agentComputerShape).superRefine((value, ctx) => {
  const positional = (AGENT_COMPUTER_POSITION_ACTIONS as readonly string[]).includes(value.action);
  const positionless = (AGENT_COMPUTER_POSITIONLESS_ACTIONS as readonly string[]).includes(value.action);
  const hasX = value.x !== undefined;
  const hasY = value.y !== undefined;
  if (hasX !== hasY) {
    // Half a point is not a point, and the missing half would be filled in by whoever delivered it.
    ctx.addIssue({ code: "custom", message: "a point is both x and y", path: [hasX ? "y" : "x"] });
  }
  if (positional && !(hasX && hasY)) {
    ctx.addIssue({ code: "custom", message: "this action lands at a point", path: ["x"] });
  }
  if (positionless && (hasX || hasY)) {
    ctx.addIssue({ code: "custom", message: "this action lands nowhere", path: ["x"] });
  }
  if (value.action === "type" && value.text === undefined) {
    ctx.addIssue({ code: "custom", message: "typing needs text", path: ["text"] });
  }
  if (value.action === "key" && value.key === undefined) {
    ctx.addIssue({ code: "custom", message: "a key press needs a key", path: ["key"] });
  }
  if (value.action === "scroll" && value.amount === undefined) {
    ctx.addIssue({ code: "custom", message: "a scroll needs an amount", path: ["amount"] });
  }
  if (value.action === "wait" && value.ms === undefined) {
    // A wait of no stated length is a wait nobody can bound, and the call's own timeout is read
    // from its arguments.
    ctx.addIssue({ code: "custom", message: "a wait needs a length", path: ["ms"] });
  }
});

/**
 * A destination an agent may send one of its own tabs to (US4, FR-045).
 *
 * The scheme test is the whole of the policy here, and it is a narrow one: an agent tab may go
 * anywhere the owner's browser can go - `chrome://`, `file://` and a PDF included, because a read
 * has to be able to *reach* a restricted page in order to answer `not-readable` about it - except
 * to the two schemes where "navigate" is a misnomer. A `javascript:` url runs in whatever document
 * is already loaded, and a `data:` url is a document the agent authored; neither is the browser
 * going somewhere, and both would turn a tab tool into a way to put agent-written script inside a
 * site's own context. They are refused here rather than left to whichever Chrome API notices,
 * because "which API refuses this" is not a rule anybody can read.
 */
const AGENT_UNNAVIGABLE_PROTOCOLS = ["javascript:", "data:"];

function isNavigableUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return !AGENT_UNNAVIGABLE_PROTOCOLS.includes(parsed.protocol);
}

const agentNavigableUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(isNavigableUrl, { message: "expected an absolute url the browser can navigate to" });

const agentTabsCreateShape = {
  /** Absent means `about:blank`: a tab the agent owns and has not sent anywhere yet. */
  url: agentNavigableUrlSchema.optional(),
};

const agentTabsCreateArgsSchema = z.strictObject(agentTabsCreateShape);

const agentTabsCloseShape = {
  tabId: agentTabIdSchema,
  /**
   * Leave a page that asked to stay (008 FR-114). Absent means stay, which is the default because
   * the unsaved work a "leave site?" prompt is about is the owner's, not the agent's; forcing is an
   * effect the site's mode governs like any other.
   */
  force: z.boolean().optional(),
};

const agentTabsCloseArgsSchema = z.strictObject(agentTabsCloseShape);

/**
 * Taking one of the owner's own tabs into the session, and giving it back (004 US3, FR-058).
 *
 * A tab and nothing else. A claim carries no session id because the session is the connection the
 * call arrived on: a caller that could name a session would be naming *someone else's*, and the
 * lease table would then be writable from the wrong side of the boundary.
 */
const agentTabsClaimShape = {
  tabId: agentTabIdSchema,
};

const agentTabsClaimArgsSchema = z.strictObject(agentTabsClaimShape);

const agentTabsReleaseShape = {
  tabId: agentTabIdSchema,
};

const agentTabsReleaseArgsSchema = z.strictObject(agentTabsReleaseShape);

/**
 * What a claim answers with: the tab, and the group it now sits in.
 *
 * The group is returned rather than assumed because it is what the *owner* sees - the claimed tab
 * joins the session's group in their tab strip, and an agent that reports having claimed a tab
 * without the group has not said the thing the owner can check.
 */
export const agentTabsClaimResultSchema = z.strictObject({
  tabId: agentTabIdSchema,
  groupId: z.number().int().nonnegative(),
});

/** `released: true` and nothing else, for the reason `tabs_close` answers only `closed: true`. */
export const agentTabsReleaseResultSchema = z.strictObject({ released: z.literal(true) });

const agentNavigateShape = {
  tabId: agentTabIdSchema,
  /** Where to go. Exactly one of this and `direction`. */
  url: agentNavigableUrlSchema.optional(),
  direction: z.enum(["back", "forward"]).optional(),
  /** Leave a page that asked to stay, on the same terms `tabs_close` takes it (008 FR-114). */
  force: z.boolean().optional(),
};

const agentNavigateArgsSchema = z.strictObject(agentNavigateShape).superRefine((value, ctx) => {
  const named = Number(value.url !== undefined) + Number(value.direction !== undefined);
  if (named !== 1) {
    // "Go back to this url" is not something a browser does. Accepting both would leave the worker
    // to pick one, and the agent would be told a navigation happened that never did.
    ctx.addIssue({ code: "custom", message: "navigate takes a url or a direction, never both" });
  }
});

/** Chrome's own floor for a window; below it the browser silently substitutes its minimum. */
const AGENT_WINDOW_MIN_PX = 1;

const AGENT_WINDOW_MAX_PX = 10_000;

const agentResizeWindowShape = {
  tabId: agentTabIdSchema,
  width: z.number().int().min(AGENT_WINDOW_MIN_PX).max(AGENT_WINDOW_MAX_PX),
  height: z.number().int().min(AGENT_WINDOW_MIN_PX).max(AGENT_WINDOW_MAX_PX),
};

const agentResizeWindowArgsSchema = z.strictObject(agentResizeWindowShape);

/**
 * The smallest and largest emulated viewport (012 FR-156, R-169).
 *
 * The floor is a phone standing up; below it no site's own layout is being tested any more, it is
 * the browser's minimum being tested. The ceiling is a wide desktop with room to spare: a picture
 * of one already runs into the frame's own byte bound (R-171), so a larger number would buy the
 * agent nothing but a refusal.
 */
export const AGENT_VIEWPORT_MIN_PX = 320;

export const AGENT_VIEWPORT_MAX_PX = 4096;

const agentViewportSizeSchema = z.number().int().min(AGENT_VIEWPORT_MIN_PX).max(AGENT_VIEWPORT_MAX_PX);

/**
 * Giving a tab a viewport of its own (012 US1, FR-156, FR-157, R-169).
 *
 * The flat field map is what MCP is shown - `inputShape` takes an unrefined shape - and the union
 * below is the authority the worker parses against, which is the same division `navigate`'s
 * "a url or a direction, never both" is enforced by: `width` and `height` are a pair `set` must
 * have and `reset` must not carry, because a reset that accepted a size would read as "put it back
 * to *this*", which is not what it does.
 */
const agentViewportShape = {
  tabId: agentTabIdSchema,
  action: z.enum(["set", "reset"]),
  /** Both, or neither: CSS pixels, and only with `set`. */
  width: agentViewportSizeSchema.optional(),
  height: agentViewportSizeSchema.optional(),
};

const agentViewportArgsSchema = z.discriminatedUnion("action", [
  z.strictObject({
    tabId: agentTabIdSchema,
    action: z.literal("set"),
    width: agentViewportSizeSchema,
    height: agentViewportSizeSchema,
  }),
  z.strictObject({ tabId: agentTabIdSchema, action: z.literal("reset") }),
]);

/**
 * What the tool answers with: the size the page is now laid out at, and whose size it is.
 *
 * `emulated` is required rather than implied by the action, because the two answers an agent must
 * tell apart look identical without it - 375×812 asked for and honoured, and 375×812 that is simply
 * what the owner's window happens to be after a reset.
 */
export const agentViewportResultSchema = z.strictObject({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  emulated: z.boolean(),
});

export type AgentViewportResult = z.infer<typeof agentViewportResultSchema>;

/**
 * One tab of a session, as both the agent and the panel are shown it (FR-044).
 *
 * `active` is required rather than optional because it is the fact that decides what a screenshot
 * can see: `captureVisibleTab` photographs the active tab of a window, so an agent holding three
 * tabs needs to know which one that is. An optional field would let the worker answer "I did not
 * look", which is not an honest answer about a tab it just listed.
 */
export const agentTabViewSchema = z.strictObject({
  tabId: z.number().int().nonnegative(),
  url: z.string().max(2048),
  /**
   * The tab's title as the *browser* records it (004 FR-060), never a word read out of the
   * document: listing is the one thing a session may do to a tab it does not hold, and it stays
   * that way only while the facts it carries are the browser's own.
   *
   * Required for the same reason `active` is - an agent picks a tab out of this list by name, and
   * an absent title would let the worker answer "I did not look" about a tab it just listed. A tab
   * Chrome has no title for yet answers with the empty string, which is a fact rather than a gap.
   */
  title: z.string().max(2048),
  active: z.boolean(),
  /**
   * The window the tab lives in (004 FR-057). `tabs_context` lists every tab in the browser now,
   * not just the session's, and a flat list of tabs from three windows is a list an agent cannot
   * reason about position or activity in - `active` is per window.
   */
  windowId: z.number().int().nonnegative().optional(),
  /**
   * Who holds the tab's lease (004, data-model TabLease): this session, another one - named, so the
   * agent can say *whose* - or nobody.
   *
   * Three cases rather than a boolean, because the agent does something different in each: use it,
   * leave it alone, or claim it. The foreign case carries the session id rather than a second bare
   * word for the same reason a refusal does.
   *
   * Optional until the slice that owns leases fills it (S1/S2); a row without it is a row from the
   * 003 projection, which knew of one session and could not have answered the question.
   */
  holder: z
    .union([z.literal("this"), z.literal("none"), z.strictObject({ sessionId: z.string().min(1).max(128) })])
    .optional(),
});

export type AgentTabView = z.infer<typeof agentTabViewSchema>;

export const agentTabsCreateResultSchema = z.strictObject({ tabId: agentTabIdSchema });

/**
 * `closed: true` and nothing else is expressible: a close that did not happen is an *outcome*
 * (`denied`, `stale`), not an `ok` carrying a quiet no.
 */
export const agentTabsCloseResultSchema = z.strictObject({ closed: z.literal(true) });

export const agentResizeWindowResultSchema = z.strictObject({
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  ...agentAnswerContextShape,
});

/**
 * What a recording may be saved as (008 FR-107, data-model "Export request / result").
 *
 * Letters, digits, space, dot, dash and underscore, and nothing else: a name is a *file name*, so
 * every character a path is built from is absent from the grammar rather than stripped out of the
 * value afterwards. A leading dot is refused beside the pattern because it is the one remaining way
 * a legal name hides the file from the owner, and the owner going to look for what the agent said
 * it wrote is the whole point of naming it.
 */
export const AGENT_RECORDING_FILENAME_PATTERN = /^[A-Za-z0-9 _.-]{1,80}$/;

const AGENT_RECORDING_FILENAME_EXTENSION = ".gif";

const agentRecordingFilenameSchema = z
  .string()
  .regex(AGENT_RECORDING_FILENAME_PATTERN, { message: "letters, digits, space, '.', '-' and '_' only" })
  .refine((value) => !value.startsWith("."), { message: "a name may not start with a dot" })
  .refine((value) => !value.toLowerCase().endsWith(AGENT_RECORDING_FILENAME_EXTENSION), {
    // The tool appends it. A name that carried it would produce `run.gif.gif` or, worse, let the
    // agent believe it chose an extension this tool would have honoured.
    message: "the extension is appended, not given",
  });

const agentGifRecorderShape = {
  action: z.enum(["start", "stop", "export", "clear"]),
  /** Only `export` uses it; a default is minted from the local clock when it is absent. */
  filename: agentRecordingFilenameSchema.optional(),
};

const agentGifRecorderArgsSchema = z.strictObject(agentGifRecorderShape);

/**
 * What `start`, `stop` and `clear` answer with: the recording, as it stands after the call.
 *
 * `alreadyRecording` rides on a second `start` rather than making it a refusal, because an agent
 * that asked twice is in exactly the state it wanted to be in - saying no to it would make it stop
 * and take the recording apart to get there.
 */
export const gifRecorderStatusResultSchema = z.strictObject({
  ...recordingStateSchema.shape,
  alreadyRecording: z.boolean().optional(),
});

export type GifRecorderStatusResult = z.infer<typeof gifRecorderStatusResultSchema>;

/**
 * What `export` answers with: where the file went and what is in it.
 *
 * `downloadId` is the browser's own, so the agent can find the same file again in
 * `downloads_context` with the path the browser decided - which may not be the name that was asked
 * for, because the browser uniquifies a collision and this tool does not argue with it.
 */
export const gifRecorderExportResultSchema = z.strictObject({
  filename: z.string().min(1).max(4096),
  frames: z.number().int().nonnegative().max(AGENT_RECORDING_MAX_FRAMES),
  skipped: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
  downloadId: z.number().int().nonnegative(),
});

export type GifRecorderExportResult = z.infer<typeof gifRecorderExportResultSchema>;

/**
 * Answering the dialog a page opened (008 US3, FR-110..FR-113).
 *
 * The tab is named like every other effect's, because a dialog belongs to one tab and a session
 * holding three would otherwise be asking the worker which one it meant. `promptText` is the answer
 * typed into a prompt; on an alert or a confirm there is nothing to type and the field is simply
 * unused rather than refused, since the agent does not always know which of the three it is
 * answering until the block told it.
 */
const agentDialogShape = {
  tabId: agentTabIdSchema,
  action: z.enum(["accept", "dismiss"]),
  promptText: z.string().max(2000).optional(),
};

const agentDialogArgsSchema = z.strictObject(agentDialogShape);

/**
 * What answering a dialog reports: that it was answered, which one, and what kind it was.
 *
 * The kind travels back because the same call means different things on each - pressing OK on an
 * alert acknowledges, on a confirm it agrees - and an agent that only learned "ok" would have to
 * remember what it was answering.
 */
export const dialogResultSchema = z.strictObject({
  ok: z.literal(true),
  dialogId: z.string().min(1).max(64),
  type: currentDialogSchema.shape.type,
});

export type DialogResult = z.infer<typeof dialogResultSchema>;

/**
 * The deepest nesting a read may be asked for - which is the deepest one the answer can express.
 *
 * It was 32, on the reasoning that deeper than that is a document being copied rather than a
 * structure being read. That reasoning was measured and is wrong for a DOM walk: on the repository
 * page 587 elements matched the same selector an accessibility tree is built from, and a full read
 * at 32 reached 550 of them with 35 deeper still - so the ceiling itself, not the page, decided
 * what an agent could see. The number now equals the depth the collection counts to and the node
 * shape carries (64), so "the maximum" means the whole of what this product can describe.
 */
export const AGENT_READ_PAGE_MAX_DEPTH = 64;

/**
 * What an unasked-for read costs, in the three units a read can run away in (004 FR-064).
 *
 * The depth is a *default* and the other two are ceilings, which is the difference between "how much
 * of the page did you want" and "how much of it may you have". It applies to the working read only:
 * `filter: "interactive"` answers with the elements an effect can be delivered to, and fifteen
 * levels of them is a list an agent can work from rather than an answer whose size depends on the
 * document it landed on. `filter: "all"` is the read that asks for the page, so nothing is put on
 * it the caller did not ask for (004/T137b).
 */
export const AGENT_READ_PAGE_DEFAULT_DEPTH = 15;

export const AGENT_READ_PAGE_MAX_NODES = 10_000;

export const AGENT_READ_PAGE_MAX_CHARS = 50_000;

const agentGetPageTextShape = {
  tabId: agentTabIdSchema,
  /**
   * How much text the answer may carry, across every frame it covered (004/T135a).
   *
   * The same argument and the same ceiling `read_page` has, for one reason: the two reads answer
   * about the same page, and a structured read that returned more of its text than the text read
   * would make "which of these returns more" a thing an agent had to know before choosing. Absent
   * means the ceiling, as it does there.
   */
  max_chars: z.number().int().min(1).max(AGENT_READ_PAGE_MAX_CHARS).optional(),
};

const agentGetPageTextArgsSchema = z.strictObject(agentGetPageTextShape);

/**
 * The page's readable text, and whether the collector's bound cut it (FR-036).
 *
 * `truncated` is required rather than optional because the difference between "this is the page"
 * and "this is the first 50,000 characters of the page" is the difference between an agent that
 * knows what it read and one that believes it read everything.
 */
export const agentPageTextResultSchema = z.strictObject({
  text: z.string().max(AGENT_READ_PAGE_MAX_CHARS),
  truncated: z.boolean(),
  /**
   * Which ceiling ran out, when one of them is what cut it (004/T135a) - the same field, with the
   * same meaning, `read_page` answers with. A text read has exactly one limit, so `chars` is the
   * only thing there is to name; a frame that could not be read also sets `truncated`, and names
   * nothing, because there is no limit the agent could raise to get it.
   */
  truncatedBy: z.enum(["chars"]).optional(),
});

export type AgentPageTextResult = z.infer<typeof agentPageTextResultSchema>;

const agentReadPageShape = {
  tabId: agentTabIdSchema,
  /**
   * `interactive` (the default) is the working answer: the elements an effect could be delivered to.
   * `all` is the whole snapshot the collector took, including the nodes no ref was minted for.
   */
  filter: z.enum(["interactive", "all"]).default("interactive"),
  /**
   * How far below the root to go (004 FR-064). Absent means 15 for the working read and *no limit*
   * for `filter: "all"`; the default is applied by the schema below, where the filter is known.
   */
  depth: z.number().int().min(1).max(AGENT_READ_PAGE_MAX_DEPTH).optional(),
  /**
   * How much *text* the answer may carry, across every frame it covered. Absent means the ceiling:
   * the bound exists so a large page cannot fill the agent's context, not so that it has to be
   * restated on every call.
   */
  max_chars: z.number().int().min(1).max(AGENT_READ_PAGE_MAX_CHARS).optional(),
  /** Roots the read at one element. Absent means the whole document. */
  ref: agentRefSchema.optional(),
};

/**
 * The read's arguments, with the one default that depends on another argument (004/T137b).
 *
 * A depth belongs to the *working* read: `filter: "interactive"` is a list of what can be acted on,
 * and fifteen levels of it is a working list. `filter: "all"` asks what the page contains, and a
 * default depth there answers a question the caller did not ask - it was measured returning 86 of
 * 587 elements while calling itself the whole page. A caller that names a depth gets that depth
 * under either filter; only the absent case differs.
 */
const agentReadPageArgsSchema = z
  .strictObject(agentReadPageShape)
  .transform((args) =>
    args.depth === undefined && args.filter !== "all"
      ? { ...args, depth: AGENT_READ_PAGE_DEFAULT_DEPTH }
      : args,
  );

/**
 * What a form control holds right now, on a read node and on a find match (005/US1, FR-072..FR-074).
 *
 * One shape for both because scenario 8 of US1 is exactly that a `find` answer says what a
 * `read_page` node would. `value` is a text entry's live text or a select's shown option text,
 * bounded like a name; `checked` is a toggle's state and never travels with a `value`, because a
 * toggle's markup `value` is not something the owner sees; `redacted` marks a field whose content
 * the read must not carry (a password, a card number), and a value beside it is a shape the page
 * side can never produce - the refine below makes sure the worker cannot either.
 */
const agentFieldStateShape = {
  value: z.string().max(DEFAULT_BOUNDS.maxLabelChars).optional(),
  checked: z.boolean().optional(),
  redacted: z.boolean().optional(),
  valueTruncated: z.boolean().optional(),
};

function refineFieldState(
  value: { value?: string | undefined; checked?: boolean | undefined; redacted?: boolean | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.value !== undefined && value.redacted !== undefined) {
    ctx.addIssue({ code: "custom", message: "a redacted field carries no value", path: ["value"] });
  }
  if (value.value !== undefined && value.checked !== undefined) {
    ctx.addIssue({ code: "custom", message: "a toggle carries checked, not a value", path: ["value"] });
  }
}

/**
 * One node of a structural read (FR-037).
 *
 * `ref` is optional and that is the honest shape. The page's registry mints a handle only where the
 * runtime could actually deliver an effect - a hidden control, a control the form-value policy
 * refuses, a heading - so a node without a ref is a node this product cannot act on. Minting one
 * anyway so that every node "has" a ref would advertise a capability that is not there, and the
 * agent would find out only when the effect failed.
 *
 * `depth` is the element's nesting under the root of the read, which is what makes a flat list
 * readable as a structure without shipping the document's markup.
 */
const agentReadPageNodeSchema = z.strictObject({
  ref: agentRefSchema.optional(),
  role: z.string().min(1).max(100),
  /** The accessible name the *worker* already holds for the element; never page markup. */
  name: z.string().max(DEFAULT_BOUNDS.maxLabelChars).optional(),
  depth: z.number().int().nonnegative().max(64),
  /**
   * Which frame of the answer the node came from (004 US4, data-model FrameNode).
   *
   * A flat list of nodes drawn from several documents is ambiguous about the one thing an effect
   * depends on - which document the element is in - so the label travels with the node. Optional
   * until the slice that reads frames fills it (S3); a node without one came from the top frame,
   * which is all a 003 read could see.
   */
  frame: agentFrameLabelSchema.optional(),
  /** A link's destination, so an agent can decide about it without navigating to find out. */
  href: z.string().max(2048).optional(),
  /** The control's own type (`email`, `checkbox`, …); what makes a textbox answerable. */
  type: z.string().max(64).optional(),
  placeholder: z.string().max(DEFAULT_BOUNDS.maxLabelChars).optional(),
  /** A select's choices, as the agent would have to name one of them. */
  options: z.array(z.string().max(DEFAULT_BOUNDS.maxLabelChars)).max(200).optional(),
  /**
   * Present and true only on a node the page renders but nobody can see. It is reported rather than
   * dropped because "the button is there but hidden" and "there is no button" lead an agent to two
   * different next moves.
   */
  hidden: z.boolean().optional(),
  ...agentFieldStateShape,
}).superRefine(refineFieldState);

/**
 * One frame the read covered, or could not (004 US4, data-model FrameNode).
 *
 * `readable: false` always carries a reason: a frame that is simply missing from the answer reads
 * as a page that does not contain it, and the agent would go looking for the element it holds in
 * the wrong document. `url` is what the *browser* reports for the frame - never page content.
 */
const agentReadPageFrameSchema = z
  .strictObject({
    frame: agentFrameLabelSchema,
    parent: agentFrameLabelSchema,
    url: z.string().max(2048),
    readable: z.boolean(),
    reason: z.enum(["not-allowed", "no-answer"]).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.readable && value.reason === undefined) {
      ctx.addIssue({ code: "custom", message: "an unreadable frame says why", path: ["reason"] });
    }
    if (value.readable && value.reason !== undefined) {
      ctx.addIssue({ code: "custom", message: "a readable frame has no reason", path: ["reason"] });
    }
  });

export const agentReadPageResultSchema = z.strictObject({
  /**
   * The frames, listed once, before the nodes that came from them. Optional until S3 reads them;
   * a read with no frame list is a read of the top document alone.
   */
  frames: z.array(agentReadPageFrameSchema).max(200).optional(),
  nodes: z.array(agentReadPageNodeSchema).max(AGENT_READ_PAGE_MAX_NODES),
  truncated: z.boolean(),
  /**
   * Which page-wide ceiling the answer ran out of, when one of them is what cut it (004 FR-064).
   *
   * `truncated` alone tells an agent it has not seen the page; this tells it what to do about it -
   * `chars` and `depth` are bounds it may raise on the next call, `nodes` is one it may not, and it
   * should narrow the read instead. It is absent when nothing ran out and when the cut was the
   * filter or the collection rather than a limit, because there would be no limit to name.
   *
   * `depth` is here because it is the limit an agent is most able to act on and the one that was
   * silently deciding full reads (004/T137b): a read that left elements out for being deeper than
   * the depth it was given now says so, instead of saying "truncated" and naming nothing.
   */
  truncatedBy: z.enum(["nodes", "chars", "depth"]).optional(),
});

export type AgentReadPageResult = z.infer<typeof agentReadPageResultSchema>;

/** The largest viewport crop worth naming; beyond it a "region" is the whole screenshot. */
const AGENT_REGION_MAX_PX = 10_000;

/** A tenth: below it the picture is no longer a picture of anything the agent could read. */
const AGENT_SCREENSHOT_MIN_SCALE = 0.1;

const agentScreenshotShape = {
  tabId: agentTabIdSchema,
  /**
   * A rectangle of the viewport, in CSS pixels from its top-left. Absent means the whole visible
   * tab, which is all `captureVisibleTab` can photograph in the first place.
   */
  region: z
    .strictObject({
      x: z.number().int().nonnegative().max(AGENT_REGION_MAX_PX),
      y: z.number().int().nonnegative().max(AGENT_REGION_MAX_PX),
      width: z.number().int().positive().max(AGENT_REGION_MAX_PX),
      height: z.number().int().positive().max(AGENT_REGION_MAX_PX),
    })
    .optional(),
  /**
   * How much of the picture's own pixels to keep (012 FR-162, R-171).
   *
   * A picture is taken at the display's density and an emulated viewport can be 2 560 wide, so the
   * honest picture is routinely larger than the native-messaging frame will carry. `scale` is the
   * one dial that makes it fit, and it only ever shrinks: above 1 it would hand back pixels the
   * capture never took.
   */
  scale: z.number().min(AGENT_SCREENSHOT_MIN_SCALE).max(1).default(1),
};

const agentScreenshotArgsSchema = z.strictObject(agentScreenshotShape);

/**
 * What the *worker* answers a screenshot with; the host turns it into the MCP `image` block the
 * agent actually receives.
 *
 * `cropped` is required and is the whole reason this is a shape rather than a bare string: when the
 * worker cannot crop, it says so and returns the whole viewport instead of silently handing back a
 * picture of something other than the region that was asked for.
 */
export const agentScreenshotResultSchema = z.strictObject({
  mimeType: z.literal("image/png"),
  /** Base64, without a data-url prefix: the host puts it straight into the image block. */
  data: z.string().min(1),
  cropped: z.boolean(),
  /**
   * What the picture is of, in the agent's own terms (012 FR-158, FR-162, data-model CaptureAnswer).
   *
   * Every field is optional and every one of them is new, because this answer crosses a link whose
   * two ends are installed separately: a worker from before this feature answers the three fields
   * above and nothing else, and a host from before it drops what it does not know. That is also why
   * `AGENT_LINK_PROTOCOL` does not move for this - neither end has to agree on anything new.
   *
   * `width`/`height` are the image's own pixels, `frame` is the CSS size of the viewport the
   * picture shows (emulated or real), and `coverage` says which of the two the picture covers. The
   * pair is what makes the density readable at all: `width / frame.width` is the device pixel
   * ratio the capture happened at, and without it an agent measuring a 1 484-pixel picture of an
   * 1 187-pixel page has no way to know which number its coordinates are in.
   */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  scale: z.number().min(AGENT_SCREENSHOT_MIN_SCALE).max(1).optional(),
  frame: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  coverage: z.enum(["viewport", "region"]).optional(),
  /** Echoed when one was asked for, in the CSS pixels of `frame` it was asked in. */
  region: z
    .strictObject({
      x: z.number().int().nonnegative(),
      y: z.number().int().nonnegative(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional(),
  ...agentAnswerContextShape,
});

export type AgentScreenshotResult = z.infer<typeof agentScreenshotResultSchema>;

const agentFindShape = {
  tabId: agentTabIdSchema,
  query: z.string().min(1).max(DEFAULT_BOUNDS.maxLabelChars),
  maxCandidates: z.number().int().min(1).max(DEFAULT_BOUNDS.maxResolutionCandidates).default(3),
};

const agentFindArgsSchema = z.strictObject(agentFindShape);

/**
 * The tools a `browser_batch` step may name (US5, FR-047).
 *
 * Everything the closed list admits, minus three. `browser_batch` itself, because the outer batch is
 * already the one call the tab is busy with and an inner one would be a second call inside the
 * first. `tabs_create` and `tabs_close`, because a batch is about *one* tab: a step that opened or
 * closed a tab would change which tab the remaining steps are about, and the ownership check the
 * batch passed once would no longer be about the same page. `navigate` stays, because it changes
 * what the tab shows rather than which tab is meant, and the steps after it are governed by the
 * destination site's own mode (US5 scenario 3).
 *
 * 008 adds two names to the closed list and neither of them is a step. `gif_recorder` is about the
 * session rather than about a tab and takes no `tabId` at all, so a batch - which puts its own tab
 * on every step - could not express one. `dialog` is about a tab that is *stopped*: a batch is one
 * of the calls a current dialog blocks, and it stops at the step that raised one, so a `dialog`
 * step could never be reached. Both are answered by the call after the batch, which is where the
 * agent is looking anyway.
 */
export const AGENT_BATCH_STEP_TOOL_NAMES = [
  "tabs_context",
  "navigate",
  "resize_window",
  /** 012: a viewport is about one tab, so "set a phone width, read, reset" is one round trip. */
  "viewport",
  "get_page_text",
  "read_page",
  "find",
  "screenshot",
  "click",
  "right_click",
  "double_click",
  "triple_click",
  "hover",
  "drag",
  "type",
  "key",
  "scroll",
  "form_input",
  /** 004: the batch's own tab is the tab a point is in, so acting by position composes like a click. */
  "computer",
  "wait",
  "read_console",
  "read_network",
  "evaluate",
  "file_upload",
  /** 013/R-181: putting a picture into a page is one step like `file_upload`'s, and only differs in
   * where the bytes came from - so it is a step exactly as long as `file_upload` is. */
  "upload_image",
  "downloads_context",
] as const satisfies readonly AgentToolName[];

export type AgentBatchStepToolName = (typeof AGENT_BATCH_STEP_TOOL_NAMES)[number];

/** As many steps as one round trip is worth. Beyond this a "batch" is a script, and it is not one. */
const AGENT_BATCH_MAX_STEPS = 20;

/**
 * One step of a batch: a tool and its arguments, and deliberately not a tab.
 *
 * The batch's own `tabId` governs every step. A step that carried one of its own would be a way to
 * name a second tab inside a call whose ownership was checked once, so it is refused here rather
 * than checked again per step - the contract makes the smuggling unexpressible instead of making
 * the worker vigilant.
 */
export const agentBatchStepSchema = z
  .strictObject({
    tool: z.enum(AGENT_BATCH_STEP_TOOL_NAMES),
    args: z.record(z.string(), z.unknown()),
  })
  .superRefine((value, ctx) => {
    if ("tabId" in value.args) {
      ctx.addIssue({
        code: "custom",
        message: "a batch step runs on the batch's tab",
        path: ["args", "tabId"],
      });
    }
  });

export type AgentBatchStep = z.infer<typeof agentBatchStepSchema>;

const agentBatchShape = {
  tabId: agentTabIdSchema,
  steps: z.array(agentBatchStepSchema).min(1).max(AGENT_BATCH_MAX_STEPS),
};

const agentBatchArgsSchema = z.strictObject(agentBatchShape);

/**
 * What one step of a batch answered, in the position it was sent in.
 *
 * The position is what makes the answer readable at all: the steps are ordered, the batch stops at
 * the first one that did not end `ok`, and an agent reading a list of outcomes with no positions
 * could not tell which of two identical clicks was the one that failed.
 */
export const agentBatchStepResultSchema = z.strictObject({
  index: z.number().int().nonnegative().max(AGENT_BATCH_MAX_STEPS),
  outcome: agentToolOutcomeSchema,
  result: z.unknown().optional(),
  reason: z.string().max(200).optional(),
  /**
   * Where the person has to click, when this step is the one that timed out (011 FR-146).
   *
   * The same optional field a whole call's answer carries, for the same reason and with the same
   * bound: a step that raised a consent card into a panel nobody had open is the commonest way an
   * agent meets this situation, and dropping the sentence here would leave the one answer that
   * could unstick it inside the batch.
   */
  hint: z.string().max(400).optional(),
});

export type AgentBatchStepResult = z.infer<typeof agentBatchStepResultSchema>;

export const agentBatchResultSchema = z.strictObject({
  results: z.array(agentBatchStepResultSchema).max(AGENT_BATCH_MAX_STEPS),
  /**
   * How far a batch got when the owner interrupted it (014 FR-180).
   *
   * Three fields rather than a new result shape, and all three optional, because an ordinary batch
   * still answers exactly what it always did. The per-step list alone cannot say this: a step that
   * never started and a step that failed both read as `not-run` in it, and "how far did it get" is
   * the agent's next question. The indexes are the positions the steps were sent in, the same ones
   * `results[].index` uses.
   */
  completed: z.array(z.number().int().nonnegative().max(AGENT_BATCH_MAX_STEPS)).max(AGENT_BATCH_MAX_STEPS).optional(),
  interruptedAt: z.number().int().nonnegative().max(AGENT_BATCH_MAX_STEPS).optional(),
  /**
   * Where a batch stopped because the *browser* moved, not because the owner did (014 FR-187).
   *
   * Its own field rather than `interruptedAt` reused, because the two say different things to the
   * agent: an interrupt is the owner ending a step, and this is a step that never started because
   * the tab it was about is on a site nobody has decided about yet. The step at this index carries
   * `stopped / site-transition`; the agent's next single call on that tab is what raises the card.
   */
  stoppedAt: z.number().int().nonnegative().max(AGENT_BATCH_MAX_STEPS).optional(),
  notRun: z.array(z.number().int().nonnegative().max(AGENT_BATCH_MAX_STEPS)).max(AGENT_BATCH_MAX_STEPS).optional(),
});

export type AgentBatchResult = z.infer<typeof agentBatchResultSchema>;

/**
 * Download reporting (005/T180, US2, FR-077..FR-080).
 *
 * A record carries what the *browser's* download record carries and nothing from any page: the
 * browser's id, the path it saved to, the source url, the state in our four words, when it started
 * and ended, the bytes, whether the browser flagged it, and which sessions it was attributed to.
 * The extension only observes these (FR-076); nothing here can name an action on one.
 */

/** The browser's own states, reduced to four: its `interrupted` is a failure and reads as one. */
export const AGENT_DOWNLOAD_STATES = ["in_progress", "complete", "failed", "canceled"] as const;

export type AgentDownloadState = (typeof AGENT_DOWNLOAD_STATES)[number];

/** The states a download does not leave; a `download-complete` wait ends on any of them. */
export const AGENT_DOWNLOAD_TERMINAL_STATES = ["complete", "failed", "canceled"] as const;

/**
 * Who a download was reported to (FR-077): this session alone, or every session that held a tab
 * when it began. `shared` is said rather than hidden, so two agents both told about one file know
 * the other may be about to read it too.
 */
export const AGENT_DOWNLOAD_ATTRIBUTIONS = ["session", "shared"] as const;

export type AgentDownloadAttribution = (typeof AGENT_DOWNLOAD_ATTRIBUTIONS)[number];

/** As many records as one session keeps; older ones fall off the end, newest first. */
export const AGENT_DOWNLOADS_KEPT = 20;

const agentDownloadIdSchema = z.number().int().nonnegative();

/** The saved path exactly as the browser reports it; empty until the browser has decided it. */
const agentDownloadFilenameSchema = z.string().max(4096);

const agentDownloadUrlSchema = z.string().max(2048);

export const agentDownloadRecordSchema = z.strictObject({
  id: agentDownloadIdSchema,
  filename: agentDownloadFilenameSchema,
  url: agentDownloadUrlSchema,
  state: z.enum(AGENT_DOWNLOAD_STATES),
  startedAt: z.string().max(64),
  /** Set when the record reaches a terminal state; the wait's watermark is compared against it. */
  endedAt: z.string().max(64).optional(),
  bytesReceived: z.number().int().nonnegative(),
  /** `-1` is the browser's own "not known yet", carried as it is rather than invented. */
  totalBytes: z.number().int().min(-1),
  /** The browser flagged the item; the extension does nothing about it either way (FR-076). */
  danger: z.boolean(),
  attribution: z.enum(AGENT_DOWNLOAD_ATTRIBUTIONS),
});

export type AgentDownloadRecord = z.infer<typeof agentDownloadRecordSchema>;

/** `downloads_context` names no tab: it needs no lease (FR-079), so an argument would be a claim. */
const agentDownloadsContextArgsSchema = z.strictObject({});

export const agentDownloadsContextResultSchema = z.strictObject({
  downloads: z.array(agentDownloadRecordSchema).max(AGENT_DOWNLOADS_KEPT),
});

export type AgentDownloadsContextResult = z.infer<typeof agentDownloadsContextResultSchema>;

/**
 * The download a navigation became (005/US2): a url the browser downloads rather than renders
 * never commits, so the navigation reports the record that appeared instead of running to its
 * bound. The state is the record's own, `in_progress` included, because the answer is given the
 * moment the download *begins*; how it ends is what `wait download-complete` is for.
 */
const agentNavigateDownloadSchema = agentDownloadRecordSchema.pick({ id: true, filename: true, url: true, state: true });

export type AgentNavigateDownload = z.infer<typeof agentNavigateDownloadSchema>;

/** Where the tab actually ended up, read after the navigation settled - never the url asked for. */
export const agentNavigateResultSchema = z.strictObject({
  url: z.string().max(2048),
  download: agentNavigateDownloadSchema.optional(),
  ...agentAnswerContextShape,
});

/**
 * How long a wait may last, on either shape. The protocol's own maximum, not the tool's: a wait
 * that could outlast what 002 already decided a page may be watched for would be a second answer to
 * a question this repository has answered once (`DEFAULT_BOUNDS.maxWaitMs`).
 */
const agentWaitBoundSchema = z.number().int().min(1).max(DEFAULT_BOUNDS.maxWaitMs);

const agentWaitDurationShape = {
  tabId: agentTabIdSchema,
  /** A fixed pause. It observes nothing, which is why the other shape exists. */
  forMs: agentWaitBoundSchema,
};

/**
 * What the agent's wait may observe (005/T180, FR-078): the four page conditions the archived path
 * decides in the content runtime, and one the worker decides alone - the browser reported the
 * session's newest download over (`complete`, `failed` or `canceled`). It is a separate list rather
 * than a fifth member of `WAIT_CONDITIONS`, because that list is the remote path's contract too and
 * the remote path has no downloads to wait for (FR-075).
 */
export const AGENT_WAIT_CONDITIONS = [...WAIT_CONDITIONS, "download-complete"] as const;

export type AgentWaitCondition = (typeof AGENT_WAIT_CONDITIONS)[number];

const agentWaitConditionShape = {
  tabId: agentTabIdSchema,
  condition: z.enum(AGENT_WAIT_CONDITIONS),
  /**
   * The element the condition is about, as a ref.
   *
   * Required for the three conditions that are about one element, and optional for the fourth:
   * `visible-text-changed` is about the page, and without a ref the worker takes the baseline from
   * the tab's current binding rather than from an element the agent had to name first.
   * `download-complete` is about the browser, and a ref beside it is refused: naming an element
   * would claim the wait watches something it does not.
   */
  ref: agentRefSchema.optional(),
  maxMs: agentWaitBoundSchema,
};

/**
 * The two shapes of a wait, as a closed union (FR-048).
 *
 * A union of two strict objects rather than one object with optional fields, because "wait this
 * long" and "wait until this holds" are different questions: an argument object that could be read
 * as both would leave the worker to choose which one the agent meant, and that choice belongs to
 * neither of them.
 */
const agentWaitArgsSchema = z.union([
  z.strictObject(agentWaitDurationShape),
  z.strictObject(agentWaitConditionShape).superRefine((value, ctx) => {
    if (value.condition === "download-complete") {
      if (value.ref !== undefined) {
        ctx.addIssue({ code: "custom", message: "this condition is about the browser, not an element", path: ["ref"] });
      }
      return;
    }
    if (value.condition !== "visible-text-changed" && value.ref === undefined) {
      ctx.addIssue({ code: "custom", message: "this condition is about one element", path: ["ref"] });
    }
  }),
]);

/**
 * The download a `download-complete` wait ended on (005/FR-078): the record's identity and the
 * terminal state it reached. `in_progress` is not expressible here, because a wait that answered
 * on a download still running would be a wait that did not wait.
 */
const agentWaitDownloadSchema = z.strictObject({
  id: agentDownloadIdSchema,
  filename: agentDownloadFilenameSchema,
  url: agentDownloadUrlSchema,
  state: z.enum(AGENT_DOWNLOAD_TERMINAL_STATES),
});

export type AgentWaitDownload = z.infer<typeof agentWaitDownloadSchema>;

/**
 * What a wait can end as. Reaching the bound is still not one of them: it is an outcome - `failed`
 * with `bound-reached` - because nothing was observed, and a shape that could carry "did not
 * happen" beside `waitedMs` would let a wait report its own failure as an answer.
 *
 * `download` rides beside `waitedMs` only for a `download-complete` wait: it is what the agent
 * waited to learn (the saved path and how it ended), and the four page conditions have nothing
 * of the kind to say.
 *
 * 008 adds the second ending, and it is here rather than among the outcomes for the same reason
 * `condition-met` is: something *was* observed. A native dialog holds the page still, so a wait on
 * it would run to its bound and report a timeout for a page that is not slow but stopped - which
 * is a different next move. `condition-unmet` says the condition did not hold and names the dialog
 * that is why, so the agent answers the dialog instead of waiting again.
 */
export const agentWaitResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("condition-met"),
    waitedMs: z.number().int().nonnegative(),
    download: agentWaitDownloadSchema.optional(),
  }),
  z.strictObject({
    outcome: z.literal("condition-unmet"),
    waitedMs: z.number().int().nonnegative(),
    dialog: currentDialogSchema,
  }),
]);

export type AgentWaitResult = z.infer<typeof agentWaitResultSchema>;

/**
 * The diagnostics tools (US6, FR-049, FR-050).
 *
 * All three read through the DevTools protocol, which is why they sit behind a grant of their own
 * rather than behind the site mode: attaching a debugger to a page is a different, wider act than
 * clicking something on it, and Chrome tells the owner about it in its own bar while it lasts.
 *
 * What they may answer with is deliberately narrow. A console message is a level, a text and a
 * time; a network record is a method, a url, a status, a kind and a time. There is no field for a
 * header, a cookie, a request body or a response body, and there never was one to remove: the same
 * rule the redacting proxy applies to the remote path, applied here at the shape.
 */

/** How many records one read may return. The default keeps an unasked-for read small. */
const AGENT_DIAGNOSTICS_DEFAULT_LIMIT = 100;

export const AGENT_DIAGNOSTICS_MAX_LIMIT = 1_000;

const agentDiagnosticsLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(AGENT_DIAGNOSTICS_MAX_LIMIT)
  .default(AGENT_DIAGNOSTICS_DEFAULT_LIMIT);

/**
 * A regular expression the *worker* applies to what it buffered. It never reaches the page, and a
 * pattern the engine refuses is answered `failed`/`invalid-pattern` rather than ignored - a filter
 * that silently matched everything would be a read the agent misreads as complete.
 */
const agentDiagnosticsPatternSchema = z.string().min(1).max(200);

const agentReadConsoleShape = {
  tabId: agentTabIdSchema,
  pattern: agentDiagnosticsPatternSchema.optional(),
  /** Errors and exceptions only; the usual reason a test looks at the console at all. */
  onlyErrors: z.boolean().default(false),
  limit: agentDiagnosticsLimitSchema,
};

const agentReadConsoleArgsSchema = z.strictObject(agentReadConsoleShape);

/** The console levels Chrome reports, mapped onto one closed set the agent can branch on. */
export const AGENT_CONSOLE_LEVELS = ["log", "info", "warning", "error", "debug"] as const;

const agentConsoleMessageSchema = z.strictObject({
  level: z.enum(AGENT_CONSOLE_LEVELS),
  /** The message as the page produced it, bounded. Never its arguments, and never a stack. */
  text: z.string().max(DEFAULT_BOUNDS.maxNarrativeChars),
  /** When the page logged it, in epoch milliseconds. */
  ts: z.number().nonnegative(),
});

export const agentConsoleResultSchema = z.strictObject({
  messages: z.array(agentConsoleMessageSchema).max(AGENT_DIAGNOSTICS_MAX_LIMIT),
  truncated: z.boolean(),
});

export type AgentConsoleResult = z.infer<typeof agentConsoleResultSchema>;

const agentReadNetworkShape = {
  tabId: agentTabIdSchema,
  pattern: agentDiagnosticsPatternSchema.optional(),
  limit: agentDiagnosticsLimitSchema,
};

const agentReadNetworkArgsSchema = z.strictObject(agentReadNetworkShape);

const agentNetworkRecordSchema = z.strictObject({
  method: z.string().min(1).max(16),
  url: z.string().min(1).max(2_048),
  /** Absent until the response arrives: a request in flight has no status yet, and says so. */
  status: z.number().int().nonnegative().max(999).optional(),
  /** Chrome's own resource kind (`document`, `xhr`, `script`, …), passed through bounded. */
  type: z.string().min(1).max(32),
  ts: z.number().nonnegative(),
});

export const agentNetworkResultSchema = z.strictObject({
  requests: z.array(agentNetworkRecordSchema).max(AGENT_DIAGNOSTICS_MAX_LIMIT),
  truncated: z.boolean(),
});

export type AgentNetworkResult = z.infer<typeof agentNetworkResultSchema>;

/** The largest evaluated value the worker will carry back; beyond it the answer says `truncated`. */
export const AGENT_EVALUATE_MAX_CHARS = 65_536;

const agentEvaluateShape = {
  tabId: agentTabIdSchema,
  /**
   * The expression, evaluated in the page's own world. How it is evaluated - by value, awaiting a
   * promise, under a deadline - is the worker's decision and is deliberately not expressible here:
   * a caller that could turn `awaitPromise` off would be asking for a result nobody waited for.
   */
  expression: z.string().min(1).max(DEFAULT_BOUNDS.maxNarrativeChars),
};

const agentEvaluateArgsSchema = z.strictObject(agentEvaluateShape);

/**
 * The value, as text. Always text: a structured value would let a page choose the *shape* of what
 * the agent receives, and JSON of unbounded depth is a shape the worker would have to walk.
 */
export const agentEvaluateResultSchema = z.strictObject({
  value: z.string().max(AGENT_EVALUATE_MAX_CHARS),
  truncated: z.boolean(),
});

export type AgentEvaluateResult = z.infer<typeof agentEvaluateResultSchema>;

/**
 * File upload (US7, FR-051), and the boundary it is built around.
 *
 * The agent names *paths*; the worker is handed *bytes*. Between them is the host, which is the
 * owner's own process and the only part of this system that may touch a disk: it checks each path
 * against the roots the owner configured, refuses everything else before reading anything, and puts
 * the allowed files into the frame as base64. So there are two shapes here rather than one, and the
 * worker's has no field for a path - not "must not carry one", but cannot.
 *
 * The bounds are the native-messaging frame's own. A file this link could not carry is refused
 * before it is read, because a refusal that has already read the file has already done the thing
 * the allowed-roots rule exists to prevent.
 */

/** A file name as the page will show it. A separator would make it a path, which it is not. */
const agentFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !/[\\/]/u.test(value), "a file name, never a path");

const agentUploadFileSchema = z.strictObject({
  name: agentFileNameSchema,
  /** The MIME type the host inferred, or `application/octet-stream` when it could not. */
  type: z.string().min(1).max(128),
  bytesBase64: z.string().min(1).max(AGENT_UPLOAD_MAX_BASE64_CHARS),
});

/** What the *agent* sends: paths, because it is asking for the owner's own files. */
const agentFileUploadShape = {
  tabId: agentTabIdSchema,
  /** The `<input type="file">` to set, named the way every other target is (R-106). */
  ref: agentRefSchema,
  paths: z.array(z.string().min(1).max(4_096)).min(1).max(AGENT_UPLOAD_MAX_FILES),
};

/**
 * What reaches the *worker*: the bytes the host was allowed to read, and nothing about where they
 * came from. The total is bounded as well as each file, because ten allowed files can still add up
 * to a frame the relay cannot carry.
 */
const agentFileUploadArgsSchema = z
  .strictObject({
    tabId: agentTabIdSchema,
    ref: agentRefSchema,
    files: z.array(agentUploadFileSchema).min(1).max(AGENT_UPLOAD_MAX_FILES),
  })
  .superRefine((value, ctx) => {
    const total = value.files.reduce((sum, file) => sum + file.bytesBase64.length, 0);
    if (total > AGENT_UPLOAD_MAX_BASE64_CHARS) {
      ctx.addIssue({ code: "custom", message: "more than one frame can carry", path: ["files"] });
    }
  });

/**
 * What the page reports back: the names and sizes the `<input>` is holding *now*.
 *
 * Read from the input rather than echoed from the request, because that is the evidence FR-040's
 * rule asks for - what the page has, not what it was sent. No path travels back either: the agent
 * asked with one and does not need it returned to know what happened.
 */
export const agentUploadResultSchema = z.strictObject({
  files: z
    .array(z.strictObject({ name: agentFileNameSchema, size: z.number().int().nonnegative() }))
    .max(AGENT_UPLOAD_MAX_FILES),
  ...agentAnswerContextShape,
});

export type AgentUploadResult = z.infer<typeof agentUploadResultSchema>;

/**
 * `upload_image` (013 US1): the picture *this session already took*, put into a page.
 *
 * Two shapes again, for `file_upload`'s reason and one more. The agent names an `imageId` it was
 * handed with a screenshot; the worker is handed bytes. Between them is the host, which is the only
 * end that ever held the picture - so the id is not a field the worker-facing schema is merely
 * uninterested in, it is one it cannot express, and a worker that never stores a picture cannot be
 * asked to hand one to the wrong session.
 *
 * `AGENT_LINK_PROTOCOL` does not move for any of this: an older worker is simply never sent the
 * tool (the host offers what it can honour), and an older host never mints an id, so neither end
 * has to agree on anything it does not already know.
 */

/**
 * The picture's handle, opaque here exactly as a ref is.
 *
 * The host mints it and the host resolves it; a value this contract could interpret would be a
 * second place the format is written down, and the two would drift.
 */
const agentImageIdSchema = z.string().min(1).max(64);

/** What the *agent* sends: a picture it was given, and one place to put it. */
const agentUploadImageShape = {
  tabId: agentTabIdSchema,
  imageId: agentImageIdSchema,
  /** A `<input type="file">` or any other element, named the way every other target is (R-106). */
  ref: agentRefSchema.optional(),
  /** A drop point in the top-level viewport's CSS pixels, for a page that takes dragged files. */
  coordinate: agentPointSchema.optional(),
  filename: agentFileNameSchema.default("screenshot.png"),
};

/**
 * The same fields with the rule the MCP input schema cannot carry: exactly one target.
 *
 * `inputShape` is the unrefined map because that is what an MCP `inputSchema` takes, so this is
 * where "both or neither" becomes a refusal - checked by the host, which is where the call is
 * turned into bytes and is therefore the last place the id still exists.
 */
export const agentUploadImageRequestSchema = z
  .strictObject(agentUploadImageShape)
  .superRefine((value, ctx) => {
    if ((value.ref === undefined) === (value.coordinate === undefined)) {
      // Both is asking the host to pick, which is a choice that belongs to neither of them; neither
      // names no target at all. One refusal for one mistake: `invalid-arguments`.
      ctx.addIssue({ code: "custom", message: "exactly one of ref / coordinate", path: ["ref"] });
    }
  });

export type AgentUploadImageRequest = z.infer<typeof agentUploadImageRequestSchema>;

/**
 * What reaches the *worker*: a target and the bytes, and nothing about which picture they were.
 *
 * `target` is its own union rather than two optional fields for `agentTargetSchema`'s reason - a
 * request carrying both would be asking the worker to choose - and it is spelled `coordinate`
 * rather than a bare `{x, y}` because a drop point is named in the arguments the agent wrote.
 */
export const agentUploadImageArgsSchema = z.strictObject({
  tabId: agentTabIdSchema,
  target: z.union([z.strictObject({ ref: agentRefSchema }), z.strictObject({ coordinate: agentPointSchema })]),
  file: agentUploadFileSchema,
});

/**
 * What the page reports back: how the picture was delivered, and the file the page now holds.
 *
 * `name`/`size` are read from the `<input>` on the input path, which is the evidence FR-040's rule
 * asks for; a drop has nothing to read back, so they are echoed from the delivered `File` and the
 * point the events landed at rides with them.
 */
export const agentUploadImageResultSchema = z.strictObject({
  delivery: z.enum(["input", "drop"]),
  file: z.strictObject({ name: agentFileNameSchema, size: z.number().int().nonnegative() }),
  point: agentPointSchema.optional(),
  ...agentAnswerContextShape,
});

export type AgentUploadImageResult = z.infer<typeof agentUploadImageResultSchema>;

/**
 * `propose_sites` (017 FR-249, FR-250, R-248): the sites a session asks to work across, and why.
 *
 * Bounds only in the shape the agent is shown; the origin rules live in the schema the worker
 * parses with, so a refusal can name the entry and the rule it broke (FR-250) rather than arriving
 * as the MCP layer's generic complaint. Nothing here grants anything: only the owner's press in the
 * side panel turns a proposal into a plan (FR-253).
 */
export const AGENT_SITE_PLAN_MAX_ORIGINS = 10;
export const AGENT_SITE_PLAN_MAX_PURPOSE_CHARS = 200;
export const AGENT_SITE_PLAN_MAX_STEPS = 10;
export const AGENT_SITE_PLAN_MAX_STEP_CHARS = 120;

/**
 * Why an entry is not a plan origin, or `undefined` when it is one (FR-250).
 *
 * http or https, and exactly what `new URL(x).origin` gives back: no path (not even `/`), query,
 * fragment, user info, wildcard, upper case or default port. One function so the schema below and
 * the worker's own named refusal cannot disagree about the rule.
 */
export function sitePlanOriginProblem(value: string): string | undefined {
  if (value.includes("*")) {
    return "wildcards are not allowed";
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "not a URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "only http and https origins are allowed";
  }
  if (parsed.origin !== value) {
    return "must be an exact origin (scheme://host[:port], no path, query or fragment)";
  }
  return undefined;
}

/** One origin of a plan, as every party that holds one states it (proposal, card, store). */
export const sitePlanOriginSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => sitePlanOriginProblem(value) === undefined, { message: "expected an http(s) origin" });

const agentProposeSitesShape = {
  origins: z.array(z.string().min(1).max(256)).min(1).max(AGENT_SITE_PLAN_MAX_ORIGINS),
  purpose: z.string().min(1).max(AGENT_SITE_PLAN_MAX_PURPOSE_CHARS),
  steps: z.array(z.string().min(1).max(AGENT_SITE_PLAN_MAX_STEP_CHARS)).max(AGENT_SITE_PLAN_MAX_STEPS).optional(),
};

export const agentProposeSitesArgsSchema = z.strictObject(agentProposeSitesShape).superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.origins.forEach((origin, index) => {
    const problem = sitePlanOriginProblem(origin);
    if (problem !== undefined) {
      ctx.addIssue({ code: "custom", message: problem, path: ["origins", index] });
    } else if (seen.has(origin)) {
      ctx.addIssue({ code: "custom", message: "listed twice", path: ["origins", index] });
    }
    seen.add(origin);
  });
});

export type AgentProposeSitesArgs = z.infer<typeof agentProposeSitesArgsSchema>;

/**
 * What kind of browser a Hallpass browser is (018 data-model, R-268).
 *
 * Computed by the worker from the user-agent brands and never stored, because a profile does not
 * change browser. `unknown` is the word for an extension older than 018, which says nothing about
 * itself, and for a brand the worker cannot place - it is a fact, not a fault.
 */
export const AGENT_BROWSER_KINDS = ["chrome", "edge", "brave", "chromium", "unknown"] as const;

export type AgentBrowserKind = (typeof AGENT_BROWSER_KINDS)[number];

export const agentBrowserKindSchema = z.enum(AGENT_BROWSER_KINDS);

/**
 * A browser's identifier as every party but the worker sees it (018 data-model, R-268, R-276).
 *
 * The minted identity is a random UUID, but a record for an extension older than 018 is named
 * `run-<browserRunId>` or `pid-<pid>` by its relay, so the floor is one character rather than the
 * identity's eight. The character set is closed because the relay names a file after it
 * (`browsers/<browserId>.json`): an id that could hold a separator could name a file anywhere.
 */
export const agentBrowserIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9-]+$/u, { message: "letters, digits and '-' only" });

/**
 * The identity a worker mints and sends on `relay-ack` (018 data-model "Browser identity"). Eight
 * characters at least: a minted id is a UUID, and only a relay invents the short legacy forms.
 */
const agentMintedBrowserIdSchema = agentBrowserIdSchema.min(8);

/**
 * A browser's name as the owner chose it or the host derived it (018 FR-268, R-269): 1-40
 * characters and no control characters.
 *
 * Control characters are refused rather than stripped here because the name travels into a file,
 * into the agent's hint sentence and onto the panel, and a newline in any of them would read as a
 * second line nobody wrote. The panel's own rename command is laxer on purpose - the worker strips
 * what the owner pasted (T501) - so every name past the worker already fits this.
 */
export const AGENT_BROWSER_NAME_MAX_CHARS = 40;

export const agentBrowserNameSchema = z
  .string()
  .min(1)
  .max(AGENT_BROWSER_NAME_MAX_CHARS)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), { message: "no control characters" });

/** At most this many browsers in any list an agent is given (018 contracts/browser-tools.md). */
export const AGENT_BROWSER_LIST_MAX = 16;

/**
 * One browser as an agent is told about it in a refusal or a selection (018 contracts
 * "BrowserSummary"): the id it must act on, the name it shows the person, and the kind. Nothing
 * about the browser's tabs or pairings - a list is answered without any pairing (R-273), so it may
 * not carry anything a pairing would have guarded.
 */
export const agentBrowserSummarySchema = z.strictObject({
  browserId: agentBrowserIdSchema,
  name: agentBrowserNameSchema,
  kind: agentBrowserKindSchema,
});

export type AgentBrowserSummary = z.infer<typeof agentBrowserSummarySchema>;

const agentBrowserListSchema = z.array(agentBrowserSummarySchema).max(AGENT_BROWSER_LIST_MAX);

/** `list_browsers` takes nothing (018 contracts/browser-tools.md); closed, so a filter is refused. */
const agentListBrowsersShape = {};

export const agentListBrowsersArgsSchema = z.strictObject(agentListBrowsersShape);

/**
 * `select_browser` names one browser by id (018 FR-270, D-018-14). Plain 1-64 rather than the id's
 * own character set: an id that cannot exist is simply not connected, and the answer to that is the
 * connected list (`browser-not-chosen`), which helps the agent more than "invalid arguments".
 */
const agentSelectBrowserShape = { browserId: z.string().min(1).max(64) };

export const agentSelectBrowserArgsSchema = z.strictObject(agentSelectBrowserShape);

/** `request_browser_choice` takes nothing: the owner picks, so the agent has nothing to propose. */
const agentRequestBrowserChoiceShape = {};

export const agentRequestBrowserChoiceArgsSchema = z.strictObject(agentRequestBrowserChoiceShape);

/**
 * The `list_browsers` answer (018 FR-269). `connectedSince` is the record's `startedAt`; `current`
 * is true for the session's bound or resolved browser, so the agent can tell which one its calls run
 * in without comparing names that can renumber (R-269).
 */
export const agentListBrowsersResultSchema = z.strictObject({
  browsers: z
    .array(
      agentBrowserSummarySchema.extend({
        connectedSince: z.string().min(1).max(64),
        current: z.boolean(),
      }),
    )
    .max(AGENT_BROWSER_LIST_MAX),
});

export type AgentListBrowsersResult = z.infer<typeof agentListBrowsersResultSchema>;

/** The `select_browser` answer: the browser now selected, as a summary (018 FR-270). */
export const agentSelectBrowserResultSchema = agentBrowserSummarySchema;

/**
 * The `request_browser_choice` answer (018 FR-274): the browser the owner confirmed, or
 * `chosen: false` when every card was declined or the bound ran out - and then the earlier choice
 * stands. There is no `chosen: true` without a browser: a yes that named nothing is not an answer.
 */
export const agentRequestBrowserChoiceResultSchema = z.union([
  agentBrowserSummarySchema,
  z.strictObject({ chosen: z.literal(false) }),
]);

export type AgentRequestBrowserChoiceResult = z.infer<typeof agentRequestBrowserChoiceResultSchema>;

/**
 * How long the owner has to answer the in-browser choice (018 data-model "Browser choice request",
 * FR-274): the same two minutes a closed panel gives every other question (011 R-162).
 */
export const AGENT_BROWSER_CHOICE_BOUND_MS = 120_000;

/**
 * One browser's record in `%LOCALAPPDATA%\hallpass\browsers\<browserId>.json` (018 data-model,
 * R-266). One writer: that browser's relay.
 *
 * It repeats the address fields of `agentBridgeRecordSchema` rather than extending it, because
 * `bridge.json` stays exactly as 0.10.0 servers parse it (R-277) and the two must be free to move
 * apart. `browserRunId` is what tells a worker restart (same run: replace) from a copied profile
 * (another run: collision, R-276); `legacy` marks a record a relay named for an extension that sent
 * no identity, which is never offered the in-browser choice.
 */
export const agentBrowserRecordSchema = z.strictObject({
  browserId: agentBrowserIdSchema,
  browserRunId: z.string().min(1).max(64).optional(),
  kind: agentBrowserKindSchema,
  name: agentBrowserNameSchema.optional(),
  legacy: z.boolean(),
  features: z.array(z.string().min(1).max(64)).max(16),
  relayPid: z.number().int().positive(),
  port: z.number().int().positive().max(65_535),
  token: z.string().min(32).max(128),
  startedAt: z.string().min(1).max(64),
  protocol: z.number().int().min(1),
});

export type AgentBrowserRecord = z.infer<typeof agentBrowserRecordSchema>;

/**
 * The browser an agent chose last, in `%LOCALAPPDATA%\hallpass\choices\<agentId>.json` (018
 * data-model, R-271, D-018-5, D-018-11). One file per agent so a later key cannot lose an update;
 * written temp-then-rename, last writer wins.
 */
export const agentBrowserChoiceRecordSchema = z.strictObject({
  browserId: agentBrowserIdSchema,
  chosenAt: z.string().min(1).max(64),
});

export type AgentBrowserChoiceRecord = z.infer<typeof agentBrowserChoiceRecordSchema>;

/**
 * What post-effect verification concluded, in the attention causes' own words (003/B2).
 *
 * A subset of `ATTENTION_REQUIRED_CAUSES` plus `verified`, and not the whole set: `execute-uncertain`
 * is the answer when nothing was observed at all, which is a `failed` outcome rather than an
 * observation, and `grant-revoked` is a remote-path fact the agent has no grants to lose.
 */
export const AGENT_EFFECT_VERDICTS = [
  "verified",
  "document-changed",
  "focus-lost",
  "target-not-visible",
  "not-moved",
  "target-missed",
  "target-unconfirmed",
] as const;

export type AgentEffectVerdict = (typeof AGENT_EFFECT_VERDICTS)[number];

/**
 * What the page was seen to do, in the executor's own words (FR-040).
 *
 * `verified` is the whole point of the shape: it is post-effect verification's verdict, and it is
 * required, so an `ok` that claims an effect nobody confirmed cannot be built. `documentChanged` is
 * kept beside it because the two answer different questions - the document moving under an effect is
 * a fact the agent needs whether or not the effect itself was observed.
 */
export const agentEffectObservationSchema = z.strictObject({
  effect: z.enum([
    "activated",
    "context-activated",
    "double-activated",
    "triple-activated",
    "hovered",
    "dragged",
    "text-entered",
    "key-pressed",
    "scrolled",
    "value-set",
  ]),
  /**
   * Whether the document the effect ran against was replaced - by the effect's own evidence *or* by
   * the verification that followed it (003/B2).
   *
   * The two are one fact and are reported as one. A navigation a click starts asynchronously is
   * invisible to the executor and visible only to the post-effect probe; splitting them would let
   * an observation say the document held while the verdict beside it said it had not, and every ref
   * the agent holds depends on which of those is true.
   */
  documentChanged: z.boolean(),
  verified: z.boolean(),
  /** Why `verified` is what it is: the post-effect verdict, in the causes' own closed words. */
  verdict: z.enum(AGENT_EFFECT_VERDICTS),
  /** `form_input`'s own evidence: the control holds the stated value now. False is never success. */
  valueMatched: z.boolean().optional(),
  clicks: z.number().int().nonnegative().optional(),
  charactersChanged: z.number().int().nonnegative().optional(),
  focusRetained: z.boolean().optional(),
  targetVisible: z.boolean().optional(),
  moved: z.boolean().optional(),
  scrollTop: z.number().finite().optional(),
  targetVisibility: z.enum(TARGET_VISIBILITIES).optional(),
  key: z.string().max(32).optional(),
  /**
   * What a `target-missed` verdict found under the delivered point instead (004/T129): the role
   * and name a plain read already discloses under the same grant, nothing more - length-bounded
   * the way `find`'s own `role`/`label` are. Absent for every other verdict, and for a
   * `target-unconfirmed` one: that cause means the point was never asked about, so there is
   * nothing here to report.
   */
  role: z.string().max(100).optional(),
  label: z.string().max(DEFAULT_BOUNDS.maxLabelChars).optional(),
  /**
   * Where the tab is after the settle wait, when the document changed and the URL could be read
   * (015 FR-200). Omitted rather than guessed when the tab's URL is unknown.
   */
  url: z.string().max(2048).optional(),
  /**
   * Tabs the press opened during the settle wait, opener = the pressed tab (015 FR-200). `held` is
   * always `false`: seeing a tab open does not make it the session's - `tabs_claim` does.
   */
  newTabs: z
    .array(
      z.strictObject({
        tabId: z.number().int().nonnegative(),
        url: z.string().max(2048),
        held: z.literal(false),
      }),
    )
    .min(1)
    .max(10)
    .optional(),
  /** Downloads this session's observer recorded during the settle wait, in `downloads_context`'s identity (015 FR-200). */
  downloads: z
    .array(
      z.strictObject({
        id: z.number().int().nonnegative(),
        filename: z.string().max(1024),
        url: z.string().max(2048),
        state: z.string().max(32),
      }),
    )
    .min(1)
    .max(10)
    .optional(),
  /** The settle wait actually spent, present only when none of the three above happened (015 FR-202). */
  observedForMs: z.number().finite().nonnegative().optional(),
});

export type AgentEffectObservation = z.infer<typeof agentEffectObservationSchema>;

export const agentEffectResultSchema = z.strictObject({
  observed: agentEffectObservationSchema,
  ...agentAnswerContextShape,
});

export type AgentEffectResult = z.infer<typeof agentEffectResultSchema>;

/**
 * What `find` answers with. Handles, plus the role and label the *worker* already holds for them -
 * never a selector and never page text the resolution matched on, which would make `find` a read
 * that reports whatever the agent phrased its query to reach.
 */
export const agentFindResultSchema = z.strictObject({
  outcome: z.enum(["resolved", "no-match", "too-broad"]),
  matches: z.array(
    z.strictObject({
      ref: agentRefSchema,
      role: z.string().max(100).optional(),
      label: z.string().max(DEFAULT_BOUNDS.maxLabelChars).optional(),
      /**
       * Which frame of the page the match was found in (004 US4), labelled as `read_page` labels
       * it. Optional and absent for a page of one document, which is every match a 003 find made.
       */
      frame: agentFrameLabelSchema.optional(),
      ...agentFieldStateShape,
    }).superRefine(refineFieldState),
  ),
});

export type AgentFindResult = z.infer<typeof agentFindResultSchema>;

/**
 * What the host tells the agent about one tool, and what the agent may send it (003/T029).
 *
 * A table rather than a hand-written `registerTool` per tool. The host used to repeat the name, the
 * prose and the schema for each one, which is three chances per tool for the description an agent
 * reads to drift from the arguments the worker will actually accept. Here the name is the contract's
 * name, the shape is the contract's shape, and the description is written once beside them.
 *
 * `inputShape` is the *unrefined* field map, because that is what an MCP `inputSchema` takes. The
 * refinements - a drag's two distinct endpoints, Shift only with Tab, a scroll that is either into
 * view or by direction - are enforced where they matter, when the worker parses the call against
 * `agentToolArgSchemas`. The shape is the agent's guide; the schema is the authority.
 */
export type AgentToolDescriptor = {
  name: AgentToolName;
  title: string;
  description: string;
  inputShape: Record<string, z.ZodType>;
};

const POINTER_NOTE =
  "The target is a ref from `find`, or a viewport point {x, y} which the page resolves to an element.";

/**
 * What an agent has to know before it moves a tab (014 FR-186, contracts/transitions.md).
 *
 * On the two tools that most often take a tab somewhere nobody has decided about - a `navigate`
 * the agent chose and a `click` the page answered with a redirect - because this is the one
 * product behaviour an agent cannot discover from a refusal after the fact: a
 * `denied / site-transition-declined` with no warning reads as a bug in the agent's own plan
 * rather than as a person saying no.
 */
const TRANSITION_NOTE =
  "If the tab lands on a site the owner has not decided about, the answer says so and the next call " +
  "on that tab asks the owner (continue / always / decline).";

export const AGENT_TOOL_DESCRIPTORS: readonly AgentToolDescriptor[] = [
  {
    name: "tabs_create",
    title: "Open a tab for this session",
    description:
      "Opens a new tab in this session's own tab group and returns its tabId. The group is titled \"Agent\" in the " +
      "owner's tab strip, so they can see which tabs you are driving. Without a url the tab opens blank. " +
      "Every other tool works only on tabs in this group.",
    inputShape: agentTabsCreateShape,
  },
  {
    name: "tabs_close",
    title: "Close one of this session's tabs",
    description:
      "Closes a tab this session owns. A tab outside the group is refused, and a tab that is already gone " +
      "answers `stale`. A page with unsaved work can ask to stay: without `force` the tab is left open and " +
      "the call answers `blocked-by-beforeunload`; `force: true` closes it anyway and is an effect the " +
      "site's mode governs.",
    inputShape: agentTabsCloseShape,
  },
  {
    name: "tabs_claim",
    title: "Take one of the owner's tabs",
    description:
      "Takes a tab that already exists - one the owner opened - into this session, and returns it with the " +
      "group it joined. The tab is marked in the owner's tab strip and shows a small indicator while you " +
      "hold it, so they can see and take it back. A tab another session holds is refused, naming that " +
      "session. Claim before you read or act on a tab you did not create; `tabs_context` lists every tab in " +
      "the browser and says who holds each one.",
    inputShape: agentTabsClaimShape,
  },
  {
    name: "tabs_release",
    title: "Give a tab back to the owner",
    description:
      "Releases a tab you hold: it leaves this session's group, loses the indicator, and stays open where " +
      "the owner left it. Release what you are finished with - a held tab is one the owner cannot use " +
      "without taking it back.",
    inputShape: agentTabsReleaseShape,
  },
  {
    name: "navigate",
    title: "Navigate a tab",
    description:
      "Sends one of this session's tabs to a url, or back/forward through its history, and returns the url it " +
      "actually settled on. Navigating never asks the owner for anything; the site mode of wherever you land " +
      "governs what you may then do there. Refs from before the navigation are stale afterwards. A url the " +
      "browser downloads rather than renders answers ok with `download` (its id, path, url and state) the moment " +
      "the download begins; wait for `download-complete` to learn how it ends. A page with unsaved work can " +
      "ask to stay: without `force` the tab does not leave and the call answers `blocked-by-beforeunload`; " +
      "`force: true` leaves anyway and is an effect the site's mode governs. " +
      TRANSITION_NOTE,
    inputShape: agentNavigateShape,
  },
  {
    name: "resize_window",
    title: "Resize the window holding a tab",
    description:
      "Resizes the browser window that contains one of this session's tabs, and returns the size it ended up with. " +
      "The browser may clamp what you ask for to what fits on the screen. " +
      "For viewing a page at a size, use `viewport` instead - it does not disturb the owner's window. " +
      "Use this only when the real window must change (another program will look at it, or the site measures " +
      "the window). It does not change an emulated viewport.",
    inputShape: agentResizeWindowShape,
  },
  {
    name: "viewport",
    title: "Give a tab an emulated viewport",
    description:
      "Gives one of your tabs an emulated viewport of `width`x`height` CSS pixels for viewing a page at a size - " +
      "phone, tablet, wide desktop - without changing the browser window. Screenshots, reads and clicks then use " +
      "that size. Prefer this over `resize_window` for any layout or breakpoint check. `reset` puts the page back " +
      "to the window's real size; the emulation is also cleared when you release the tab, so reset before " +
      "finishing unless the owner asked to keep it. The two tools are independent: resizing the window does not " +
      "change an emulated viewport.",
    inputShape: agentViewportShape,
  },
  {
    name: "downloads_context",
    title: "List the downloads this session caused",
    description:
      "Lists the browser downloads that began while this session held a tab, newest first, at most twenty: " +
      "the browser's id, the path it saved the file to (`filename`, empty until the browser has decided it), " +
      "the source url, the state (`in_progress`, `complete`, `failed`, `canceled`), start and end times, " +
      "bytes, and whether the browser flagged it as dangerous. `attribution` is `shared` when another " +
      "session also held a tab at the time and was told too. Needs no tab. The file stays where the browser " +
      "put it; read it from there with your own file access. Nothing here starts, opens, moves or removes a download.",
    inputShape: {},
  },
  {
    name: "get_page_text",
    title: "Read a tab's text",
    description:
      "Returns the readable text of one of this session's tabs: the whole document's visible text, with " +
      "the contents of form controls left out. `max_chars` bounds the text the answer carries and is the " +
      "same ceiling `read_page` uses; says `truncated` when the text was longer than the bound, and " +
      "`truncatedBy: \"chars\"` when that bound is what cut it. Reading never asks the owner for anything.",
    inputShape: agentGetPageTextShape,
  },
  {
    name: "read_page",
    title: "Read a tab's structure",
    description:
      "Returns the page's elements as { ref, role, name, depth }. `filter: \"interactive\"` (the default) keeps " +
      "the ones an action can be delivered to; `filter: \"all\"` keeps everything the snapshot saw. `depth` limits " +
      "how far below the root to go, and `ref` roots the read at one element. A node that carries a ref can be " +
      "used directly by `click` and the other effect tools; a node without one cannot be acted on. " +
      "The read covers every readable frame of the page, and each node says which frame it came from. " +
      "`depth` defaults to 15 for the interactive read and is unlimited for `filter: \"all\"`, and " +
      "`max_chars` bounds the text the answer carries; says `truncated` when something was left out and " +
      "`truncatedBy` (`depth`, `chars`, `nodes`) which bound to raise. A ref keeps working for as long as " +
      "its element is on the page, so refs from an earlier read on the same tab are still good. " +
      "A form field also carries what it holds: `value` for a text entry or a select (the shown option's text), " +
      "`checked` for a checkbox or radio; a password or payment field says `redacted: true` instead of a value.",
    inputShape: agentReadPageShape,
  },
  {
    name: "screenshot",
    title: "Screenshot a tab",
    description:
      "Returns a PNG of one of this session's tabs as an image. The browser can only photograph the tab that is " +
      "active in its window, so if yours is not, it is brought to the front for the capture and the previously " +
      "active tab is put back afterwards. `region` crops the result to a rectangle of the viewport, and is " +
      "refused when it is not wholly inside it. `scale` (0.1 to 1) shrinks the returned image, which is how a " +
      "picture too large for one answer is made to fit; it changes the image only - a region, and every " +
      "coordinate you act on, stay in the unscaled viewport the answer's `frame` names. " +
      // 013 FR-176: the id is on the answer whether or not the agent was looking for it, so the
      // sentence that makes it usable belongs where the agent reads before it calls.
      "The answer carries an `imageId` that `upload_image` accepts for 5 minutes.",
    inputShape: agentScreenshotShape,
  },
  {
    name: "find",
    title: "Find elements by description",
    description:
      "Finds elements on a tab matching a plain description and returns refs for them. " +
      "Answers `no-match` when nothing matches and `too-broad` when too many do - it never picks one for you. " +
      "It searches every readable frame and inside open shadow roots. Reading never prompts the owner, and " +
      "refs from an earlier `find` or `read_page` on the same tab keep working. A match that is a form field " +
      "carries the same `value` / `checked` / `redacted` as a `read_page` node.",
    inputShape: agentFindShape,
  },
  {
    name: "click",
    title: "Click",
    description: `Activates one element. ${POINTER_NOTE} ${TRANSITION_NOTE}`,
    inputShape: pointerToolShape,
  },
  {
    name: "right_click",
    title: "Right-click",
    description:
      "Delivers a right-button press, release and `contextmenu` to the page's own handlers. " +
      `The browser's native context menu does not open; a menu the page opens itself does. ${POINTER_NOTE}`,
    inputShape: pointerToolShape,
  },
  {
    name: "double_click",
    title: "Double-click",
    description: `Two activations and the \`dblclick\` the page listens for. ${POINTER_NOTE}`,
    inputShape: pointerToolShape,
  },
  {
    name: "triple_click",
    title: "Triple-click",
    description:
      "Three activations, the third carrying `detail: 3`, delivered to the page's own handlers. " +
      `The browser's own text selection is a default action and does not happen. ${POINTER_NOTE}`,
    inputShape: pointerToolShape,
  },
  {
    name: "hover",
    title: "Hover",
    description:
      "Delivers pointer and mouse enter/over/move events. A menu the page opens in script opens; " +
      `one that opens purely through CSS \`:hover\` does not. ${POINTER_NOTE}`,
    inputShape: pointerToolShape,
  },
  {
    name: "drag",
    title: "Drag and drop",
    description:
      "Drags one element onto another using the HTML drag-and-drop events. Each endpoint is a ref or a point, " +
      "and they must be different. The result says whether the dragged element actually moved.",
    inputShape: agentDragShape,
  },
  {
    name: "type",
    title: "Type text",
    description:
      "Types into a text input or textarea. Without a target it types into the focused element. " +
      "`replace` (the default) sets the value; `insert` appends to it.",
    inputShape: agentTypeShape,
  },
  {
    name: "key",
    title: "Press a key",
    description:
      "Presses one of the supported keys as keyboard events the page handles itself; no browser default action runs. " +
      "Shift is supported only with Tab. Without a target the key goes to the focused element.",
    inputShape: agentKeyShape,
  },
  {
    name: "scroll",
    title: "Scroll",
    description:
      "Scrolls the viewport by a direction and amount, or brings one target into view. One or the other, never both.",
    inputShape: agentScrollShape,
  },
  {
    name: "form_input",
    title: "Set a form control",
    description:
      "Sets one control to a value: text for an input or textarea, an option's value or label for a select, " +
      "true/false for a checkbox or radio. The result says whether the control holds that value afterwards.",
    inputShape: agentFormInputShape,
  },
  {
    name: "computer",
    title: "Act at a point in the viewport",
    description:
      "Delivers input where a person would put the pointer: `left_click`, `right_click`, `double_click`, " +
      "`triple_click` and `scroll` at an {x, y} in the visible page, `type` and `key` to whatever has focus, " +
      "`screenshot` for a picture to aim by, and `wait` to let the page settle. Coordinates are CSS pixels " +
      "from the top-left of the top-level viewport, the same ones a screenshot shows you; a point outside it " +
      "is refused with the viewport's size. Use it for what the page's structure does not describe - a " +
      "canvas, a drawn menu - and prefer the ref-based tools everywhere else, because they say what they " +
      "acted on. Acting at a point changes the page, so the site's mode applies as it does to a click. " +
      // 013 FR-176: the screenshot action answers the same shape the `screenshot` tool does, so it
      // carries the same id - and an agent that only ever aims by point must be told so here.
      "A `screenshot` answer carries an `imageId` that `upload_image` accepts for 5 minutes.",
    inputShape: agentComputerShape,
  },
  {
    name: "browser_batch",
    title: "Run several steps on one tab in one call",
    description:
      "Runs the given steps in order on one tab and answers with every step's outcome, in order. The batch " +
      "stops at the first step that does not end `ok`; the steps after it are reported as not run. A step " +
      "names no tab of its own - they all run on this call's tab - and cannot be another batch, tabs_create or " +
      "tabs_close. Each step that changes the page is subject to the site's mode exactly as if you had sent it " +
      "alone; on a site the owner set to follow-a-plan you are asked once about the whole batch instead. A " +
      "navigate step moves the tab, and the steps after it are governed by the destination site.",
    inputShape: agentBatchShape,
  },
  {
    name: "wait",
    title: "Wait for a page condition or a fixed time",
    description:
      "Waits either a fixed number of milliseconds, or until one condition holds on the tab: an element is " +
      "present, absent or enabled, or the visible text changed. A condition wait needs `maxMs` and, except for " +
      "`visible-text-changed`, a `ref`. It ends as soon as the condition holds and reports how long it waited, " +
      "or ends at `maxMs` with `bound-reached`. It changes nothing on the page and never asks the owner " +
      "anything; the owner's Stop ends it at once. `download-complete` (no `ref`) waits for the next download " +
      "this session caused to finish - complete, failed or canceled - and answers with its `download` " +
      "{id, filename, url, state}, where `filename` is the path the browser saved it to. A download that " +
      "finished before you called is still answered once; call `downloads_context` to list them all.",
    inputShape: {
      tabId: agentTabIdSchema,
      forMs: agentWaitBoundSchema.optional(),
      condition: z.enum(AGENT_WAIT_CONDITIONS).optional(),
      ref: agentRefSchema.optional(),
      maxMs: agentWaitBoundSchema.optional(),
    },
  },
  {
    name: "read_console",
    title: "Read a tab's console",
    description:
      "Returns what the page logged - level, text and time - since diagnostics were granted for this site. " +
      "`pattern` is a regular expression matched against the text, `onlyErrors` keeps errors and uncaught " +
      "exceptions, and `limit` bounds how many of the most recent messages come back. The owner must have " +
      "granted diagnostics for the site the tab is on; without that this answers `denied`, and while it is " +
      "granted the browser tells the owner an extension is debugging it. Messages logged before the grant, " +
      "or on a page the tab has since left, are not kept.",
    inputShape: agentReadConsoleShape,
  },
  {
    name: "read_network",
    title: "Read a tab's network records",
    description:
      "Returns the requests the page made since diagnostics were granted for this site: method, url, status, " +
      "kind and time. Never headers, cookies or bodies - those are not recorded at all. `pattern` is a " +
      "regular expression matched against the url. Needs the owner's diagnostics grant for the site, and " +
      "records are dropped when the tab leaves it.",
    inputShape: agentReadNetworkShape,
  },
  {
    name: "evaluate",
    title: "Evaluate an expression in a tab",
    description:
      "Evaluates one expression in the page and returns its value as text, awaiting a promise if the " +
      "expression produces one. Needs the owner's diagnostics grant for the site *and*, because a script " +
      "can change the page like any other action, the site's own mode: on a site set to ask, the owner is " +
      "asked before it runs. Long values are cut and the answer says so.",
    inputShape: agentEvaluateShape,
  },
  {
    name: "file_upload",
    title: "Put files into a file input",
    description:
      "Sets one or more of the owner's own files on a `<input type=\"file\">` named by `ref`, and answers with " +
      "the names and sizes the input is holding afterwards. The paths are read by the local host, not by the " +
      "browser, and only inside the directories the owner listed as upload roots - anything past the size " +
      "bound is refused before it is read. " +
      // 014 FR-197: outside those directories is no longer the end of the call, and the two
      // refusals that remain mean two different things - an extension that predates the question,
      // and a host that does. An agent told only "not allowed" reports a broken tool for what is,
      // either way, an owner with something to install.
      "A file outside the directories the owner allowed makes the owner's panel ask (this file once / its " +
      "directory from now on / decline). `upload-outside-allowed-directories` means the owner's extension " +
      "predates that question; `upload-not-allowed` for such a file means the owner's host does " +
      "(reinstall it). " +
      "Setting files changes the page, so the site's mode applies exactly as it does to a click. " +
      // 013 FR-176: the one thing an agent cannot discover by trying is that a picture it already
      // has needs no path at all - it would otherwise write the screenshot to disk to upload it.
      "For a screenshot this session took, use `upload_image` with its `imageId` instead: there is no path.",
    inputShape: agentFileUploadShape,
  },
  {
    name: "upload_image",
    title: "Put a screenshot this session took into a page",
    description:
      "Puts a screenshot *this session took* into a page, quoting the `imageId` from the screenshot's answer - " +
      "no path, no file on disk. Name a `<input type=\"file\">` by `ref` (a hidden one works too) or a drop " +
      "`coordinate` for a page that takes dragged files; exactly one of the two. The picture is kept 5 minutes " +
      "after the screenshot, so take one and upload it in the same stretch of work; after that, take a new " +
      "screenshot and quote the new id. `filename` is what the page will show, `screenshot.png` by default. " +
      "For a file of the owner's own, on their disk, use `file_upload`. Putting a file into a page changes it, " +
      "so the site's mode applies exactly as it does to a click.",
    inputShape: agentUploadImageShape,
  },
  {
    name: "gif_recorder",
    title: "Record this session as a GIF",
    description:
      "Record this session's actions as an animated GIF. `start` takes an initial frame and then one frame " +
      "after every page-changing action (each batch step counts) and every screenshot; a second `start` is a " +
      "no-op. The recording holds at most 200 frames - when full, recording stops and every answer carries " +
      "`recording.full: true` until you `export` or `clear`. `export` writes `<filename>.gif` into the " +
      "browser's download folder (filename: letters, digits, space, `-`, `_`, `.`; no folders; default " +
      "`agent-recording-<timestamp>`) and lists it in `downloads_context`; the recording is then cleared. " +
      "If the session ends while recording, the recording is exported for you. Each frame is labelled with " +
      "the action, a step counter, a click marker, a progress bar and the extension's name.",
    inputShape: agentGifRecorderShape,
  },
  {
    name: "dialog",
    title: "Answer a page's dialog",
    description:
      "Answer a native dialog (alert, confirm, prompt) that a page opened on one of your tabs. While a " +
      "dialog is open, other tools on that tab answer `blocked-by-dialog` with the dialog's type and text. " +
      "`dismiss` presses Cancel and never needs the owner's consent; `accept` presses OK (with `promptText` " +
      "for a prompt) and is subject to the site's mode like a click, except when the dialog followed an " +
      "action the owner just approved. A `beforeunload` (leave site?) prompt is not answered here: " +
      "`navigate` / `tabs_close` stay on the page by default and take `force: true` to leave.",
    inputShape: agentDialogShape,
  },
  {
    name: "propose_sites",
    title: "Propose the sites this session will work on",
    // 017 contracts/propose-sites.md, FR-249: who decides, and what still asks.
    description:
      "Before working across several sites, propose them here with a short purpose. The owner approves or " +
      "declines in the browser's side panel; approved sites then need no consent card for page actions in " +
      "this session. Page JavaScript and file uploads still ask. Sites not approved behave as before.",
    inputShape: agentProposeSitesShape,
  },
  /**
   * 018 (contracts/browser-tools.md, R-273): answered by the host, need no pairing, and say in their
   * own words that the owner decides and that a browser is named by id - the two things an agent
   * would otherwise get wrong by guessing (D-018-4, R-269).
   */
  {
    name: "list_browsers",
    title: "List the connected browsers",
    description:
      "List the browsers running Hallpass on this computer. When several are connected and none is chosen, ask the " +
      "user which one to use and call select_browser with its browserId; never pick one yourself. Refer to " +
      "browsers by browserId, not by name.",
    inputShape: agentListBrowsersShape,
  },
  {
    name: "select_browser",
    title: "Use one browser for this session",
    description:
      "Use the connected browser with this browserId for this session; the choice is remembered for your next " +
      "sessions. Select only the browser the user named. You must be paired in that browser to act there: the " +
      "next call asks the owner for pairing as usual. A browserId that is not connected is refused with the " +
      "connected list.",
    inputShape: agentSelectBrowserShape,
  },
  {
    name: "request_browser_choice",
    title: "Ask the user to choose a browser in the browser",
    description:
      "Ask the user to choose the browser for this session from inside the browsers: each connected browser that " +
      "can show it asks \"Use this browser?\" in its side panel, and the first confirm selects it as select_browser " +
      "does. Waits up to 2 minutes. If every browser declines or nobody answers, the answer is `chosen: false` " +
      "and the earlier choice is unchanged.",
    inputShape: agentRequestBrowserChoiceShape,
  },
];

/**
 * The host's flat backstop for one call (003 D-M3-1), and how a batch or a wait moves it.
 *
 * Most tools answer in seconds or not at all, so one bound fits them: it exists to stop a worker
 * that was torn down mid-call from hanging the agent's session, and every deadline that means
 * something to the owner is the worker's own. A wait and a batch are the two calls whose *stated
 * arguments* say how long they will legitimately take, so their bound is read from those arguments
 * instead - otherwise the transport would give up on a call that is doing exactly what it was
 * asked. The cap is what keeps "legitimately" bounded: no call waits past it, whatever it asked for.
 */
export const AGENT_CALL_TIMEOUT_MS = 30_000;

/** Room for the round trip either side of the bound the arguments named, never for a second wait. */
export const AGENT_CALL_TIMEOUT_SLACK_MS = 5_000;

export const AGENT_MAX_CALL_TIMEOUT_MS = 300_000;

/**
 * A recording's export encodes up to 200 frames in the offscreen document before the browser writes
 * the file (008 FR-100, FR-104). Measured on the owner's branded Chrome 153 on 2026-09-19: 14 frames
 * took 3.3 s, so a full recording is ~50 s of honest work and the flat 30 s bound gave up on it
 * (gate T223, cap scenario). Like a wait, the call says what it is doing; unlike a wait it cannot
 * name a duration, so the bound is the encoder's worst case with room, under the hard cap.
 */
export const AGENT_EXPORT_CALL_TIMEOUT_MS = 180_000;

function statedBoundMs(tool: AgentToolName, args: Record<string, unknown>): number {
  if (tool === "gif_recorder" && args.action === "export") {
    return AGENT_EXPORT_CALL_TIMEOUT_MS;
  }
  if (tool === "wait") {
    const parsed = agentWaitArgsSchema.safeParse(args);
    if (!parsed.success) return AGENT_CALL_TIMEOUT_MS;
    const stated = "forMs" in parsed.data ? parsed.data.forMs : parsed.data.maxMs;
    return stated + AGENT_CALL_TIMEOUT_SLACK_MS;
  }
  if (tool === "browser_batch") {
    const parsed = agentBatchArgsSchema.safeParse(args);
    if (!parsed.success) return AGENT_CALL_TIMEOUT_MS;
    let total = AGENT_CALL_TIMEOUT_SLACK_MS;
    for (const step of parsed.data.steps) {
      // The step's own arguments, on the batch's tab: a step's bound is read exactly as it would be
      // if the agent had sent that step by itself.
      total += statedBoundMs(step.tool, { ...step.args, tabId: parsed.data.tabId });
    }
    return total;
  }
  return AGENT_CALL_TIMEOUT_MS;
}

/**
 * How long the host waits for one call's answer, from the call's own validated arguments.
 *
 * Arguments the schema would refuse decide nothing: they get the flat backstop, because a call the
 * worker is about to reject as invalid must not be able to buy itself five minutes of the agent's
 * session by claiming a bound.
 */
export function agentCallBoundMs(tool: AgentToolName, args: Record<string, unknown>): number {
  return Math.min(AGENT_MAX_CALL_TIMEOUT_MS, statedBoundMs(tool, args));
}

/**
 * Written out one tool at a time rather than generated from the name list, so the compiler is the
 * thing that keeps the two in step: a new tool name is a type error here until it has an argument
 * schema, and a later slice replaces one entry without touching the others.
 */
export const agentToolArgSchemas: Record<AgentToolName, z.ZodType> = {
  tabs_context: agentToolArgStubSchema,
  tabs_create: agentTabsCreateArgsSchema,
  tabs_close: agentTabsCloseArgsSchema,
  tabs_claim: agentTabsClaimArgsSchema,
  tabs_release: agentTabsReleaseArgsSchema,
  navigate: agentNavigateArgsSchema,
  resize_window: agentResizeWindowArgsSchema,
  viewport: agentViewportArgsSchema,
  get_page_text: agentGetPageTextArgsSchema,
  read_page: agentReadPageArgsSchema,
  find: agentFindArgsSchema,
  screenshot: agentScreenshotArgsSchema,
  click: pointerToolArgsSchema,
  right_click: pointerToolArgsSchema,
  double_click: pointerToolArgsSchema,
  triple_click: pointerToolArgsSchema,
  hover: pointerToolArgsSchema,
  drag: agentDragArgsSchema,
  type: agentTypeArgsSchema,
  key: agentKeyArgsSchema,
  scroll: agentScrollArgsSchema,
  form_input: agentFormInputArgsSchema,
  computer: agentComputerArgsSchema,
  browser_batch: agentBatchArgsSchema,
  wait: agentWaitArgsSchema,
  read_console: agentReadConsoleArgsSchema,
  read_network: agentReadNetworkArgsSchema,
  evaluate: agentEvaluateArgsSchema,
  file_upload: agentFileUploadArgsSchema,
  upload_image: agentUploadImageArgsSchema,
  downloads_context: agentDownloadsContextArgsSchema,
  gif_recorder: agentGifRecorderArgsSchema,
  dialog: agentDialogArgsSchema,
  propose_sites: agentProposeSitesArgsSchema,
  list_browsers: agentListBrowsersArgsSchema,
  select_browser: agentSelectBrowserArgsSchema,
  request_browser_choice: agentRequestBrowserChoiceArgsSchema,
};

/**
 * One tool call travelling worker ⇄ host as a native-messaging frame.
 *
 * `callId` is the correlation across the MCP call and the frame, bounded because it is echoed back
 * and a host that could name a call with unbounded text could push page-derived data through a
 * field that is supposed to be an identifier. `tabId` is absent for the tools that concern no tab;
 * where it is present the worker still checks the tab belongs to the caller's session group - the
 * frame declares the shape, never the authority.
 */
export const agentNativeRequestSchema = z.strictObject({
  callId: z.string().min(1).max(64),
  /**
   * Which agent session the call belongs to (004 US2).
   *
   * Required, and required on *every* call: 003 had one session per browser, so the connection was
   * the session and the field would have been ceremony. With several servers behind one relay the
   * frame is the only thing that says whose call this is, and the worker's lease table, tab group
   * and indicator are all keyed by it. A call that named no session would have to be attributed by
   * whichever socket it arrived on, which is exactly the guess the relay must not make.
   */
  sessionId: z.string().min(1).max(128),
  tool: agentToolNameSchema,
  tabId: z.number().int().nonnegative().optional(),
  args: z.record(z.string(), z.unknown()),
});

export type AgentNativeRequest = z.infer<typeof agentNativeRequestSchema>;

/**
 * Why a call was refused, with the evidence the agent needs to do something about it (004 README §2).
 *
 * 003 answered ownership with one code, `tab-owned-by-another-session`, because a tab was either the
 * one session's or nothing to do with the agent at all. 004 has several sessions and the owner's own
 * tabs, so there are two different facts - *that* session holds it, or nobody does - and they lead to
 * two different next moves: wait, or claim. The first carries the session id for the same reason
 * `outside-viewport` carries the viewport: a refusal an agent cannot act on is a refusal it will
 * simply repeat.
 *
 * A discriminated union on `reason`, which is also the response frame's own field, so a refusal can
 * be carried whole. `input-unavailable`'s own cause is spelled `unavailableReason` rather than
 * `reason` for that reason - the discriminant is taken - and it is the same word the worker's input
 * attachment records it under (data-model InputAttachment).
 */
export const agentRefusalSchema = z.discriminatedUnion("reason", [
  z.strictObject({
    reason: z.literal("held-by-session"),
    sessionId: z.string().min(1).max(128),
  }),
  z.strictObject({ reason: z.literal("not-yours") }),
  z.strictObject({
    reason: z.literal("input-unavailable"),
    unavailableReason: z.enum(["devtools-open", "restricted-page", "detached"]),
  }),
  z.strictObject({ reason: z.literal("bridge-lost") }),
  z.strictObject({
    reason: z.literal("outside-viewport"),
    width: z.number().int().positive().max(50_000),
    height: z.number().int().positive().max(50_000),
  }),
  z.strictObject({ reason: z.literal("stale-reference") }),
  z.strictObject({ reason: z.literal("tab-gone") }),
  z.strictObject({ reason: z.literal("restricted-page") }),
  /**
   * 008 (contracts README §3). Every one of these is a refusal an agent can act on, which is why
   * the two that have somewhere to point carry it: a blocked call says *which* dialog is in the
   * way, so the next call is `dialog` rather than the same call again, and a page that asked to
   * stay says which page, so `force` is aimed at something.
   */
  z.strictObject({ reason: z.literal("blocked-by-dialog"), dialog: currentDialogSchema }),
  z.strictObject({ reason: z.literal("blocked-by-beforeunload"), url: z.string().max(2048) }),
  z.strictObject({ reason: z.literal("no-dialog") }),
  z.strictObject({ reason: z.literal("page-unresponsive") }),
  z.strictObject({ reason: z.literal("invalid-filename") }),
  z.strictObject({ reason: z.literal("empty-recording") }),
  /**
   * The browser's own word for why it did not save the file. It is spelled `downloadReason` rather
   * than `reason` for the reason `input-unavailable` spells its cause `unavailableReason`: the
   * discriminant is taken.
   */
  z.strictObject({ reason: z.literal("download-failed"), downloadReason: z.string().min(1).max(200) }),
  /** The owner pressed refuse on a dialog accept; the dialog was dismissed rather than left open. */
  z.strictObject({ reason: z.literal("refused") }),
  /**
   * 018 (FR-272, D-018-13, contracts/browser-tools.md): several browsers are connected and this
   * agent has no connected choice - or its remembered browser is offline, or `select_browser` named
   * one that is not connected. Refused before anything reaches any worker, with the connected list,
   * because "ask the user which one" is the agent's next move and it needs the ids to make it.
   */
  z.strictObject({ reason: z.literal("browser-not-chosen"), browsers: agentBrowserListSchema }),
  /**
   * 018 (FR-277, D-018-8, R-278): the session's bound browser has been gone longer than the attach
   * bound. It names the lost browser and the others, and never falls back to one of them: which
   * browser acts is the owner's decision, not an availability accident.
   */
  z.strictObject({
    reason: z.literal("browser-disconnected"),
    browser: agentBrowserSummarySchema,
    browsers: agentBrowserListSchema,
  }),
]);

export type AgentRefusal = z.infer<typeof agentRefusalSchema>;

/**
 * The two words the owner's own controls end a call with (014 data-model "Stop flag").
 *
 * Closed, and pinned here rather than written as a literal in each runner, because a runner asks
 * the stop handle what ended it and answers that word verbatim (FR-180): a synonym invented in one
 * of the seven runners would reach an agent as a reason nothing documents. Stop is the session
 * ending; interrupt is this one step ending and nothing else.
 */
export const AGENT_STOP_REASONS = ["owner-stopped", "owner-interrupted"] as const;

export type AgentStopReason = (typeof AGENT_STOP_REASONS)[number];

/**
 * The reasons that name a decision of the owner's - made, declined, not yet made, or interrupted
 * (014 data-model "Reasons").
 *
 * They are a list rather than six literals because three processes say them: the worker composes
 * the interrupt and the transition answers, the host composes the upload ones, and the panel and
 * the gates assert both. `reason` is the short stable code an agent branches on, so the one thing
 * that must not happen is two spellings of the same fact.
 */
export const AGENT_CONSENT_REASONS = [
  /** The owner ended this step and kept everything else (FR-180); also one of `AGENT_STOP_REASONS`. */
  "owner-interrupted",
  /** The owner said no to a move from one origin to another (FR-188). */
  "site-transition-declined",
  /** A batch stopped before a step whose tab has a move nobody has decided about yet (FR-190). */
  "site-transition",
  /** The owner said no to reading a file from outside the directories they listed (FR-193). */
  "upload-declined",
  /** Nobody answered that question inside its bound (FR-193). */
  "upload-not-answered",
  /**
   * There was no way to ask: the file is outside every listed directory and this link cannot raise
   * the card (an extension that predates the feature). It replaces the opaque `upload-not-allowed`
   * for that one code alone - the size, count and not-a-file refusals keep the word they had.
   */
  "upload-outside-allowed-directories",
  /**
   * The owner said "from now on" and the host could not write it down (014 FR-194, S3 review F2).
   *
   * Separate from the refusal above, because the two ask for opposite things. That one means this
   * browser cannot raise the question at all - reinstall the extension. This one means the question
   * was asked and answered *yes*: the list is exactly as it was, nothing was uploaded, and what the
   * owner can do about it is on their own disk. The `hint` beside it carries the store's own
   * refusal, which is the only place the reason for it exists.
   */
  "upload-directory-not-recorded",
] as const;

export type AgentConsentReason = (typeof AGENT_CONSENT_REASONS)[number];

/**
 * The reasons 015 adds, each with the one outcome it answers with (015 data-model "Binding failure
 * reason", contracts/batch-upload.md).
 *
 * `reason` is a free bounded string on the answer, so this is the one place the spelling and its
 * outcome are pinned for the worker, the host and the gates.
 */
export const AGENT_015_REASON_OUTCOMES = {
  /** The page binding's probe hit the content deadline; the page is still open (015 FR-205, FR-206). */
  "page-not-responding": "failed",
  /** A batch's uploads together exceed `AGENT_UPLOAD_MAX_BASE64_CHARS`; nothing was sent (015 FR-212). */
  "batch-upload-too-large": "denied",
} as const satisfies Record<string, AgentToolOutcome>;

export type Agent015Reason = keyof typeof AGENT_015_REASON_OUTCOMES;

/**
 * What an interrupted call is told, in the only two ways this product can say it honestly
 * (FR-180, FR-181, Constitution XI).
 *
 * Here beside `ATTENTION_SENTENCES` and for the same reason: the worker composes the sentence, the
 * agent reads it and the gate asserts it, and a third copy is how the one that matters - *it may
 * have taken effect and was not verified* - quietly becomes *nothing happened*. Which of the two
 * is sent is a fact, not a guess: the operation marker for the call is written before an effect's
 * input is dispatched, so its presence at the moment of the interrupt says whether the page was
 * given anything.
 *
 * Neither sentence has a hole to fill: no session id, no tool name, no page text (FR-151).
 */
export const INTERRUPT_HINTS = {
  nothingDelivered:
    "The owner interrupted this step. Nothing refused it; the session and its tabs are still held. " +
    "Re-run it if still needed.",
  mayHaveTakenEffect:
    "The owner interrupted this step after its input was delivered; it may have taken effect and was " +
    "not verified. Read the page before re-running it.",
} as const;

/**
 * What an upload says about a directory it would not remember (014 FR-194, S3 review F7).
 *
 * Here for the reason `INTERRUPT_HINTS` is here: the host composes it, the agent reads it and the
 * gate asserts it. One sentence, no holes - it names a rule, not a path of the owner's.
 */
export const UPLOAD_HINTS = {
  rootNotRemembered:
    "Drive and share roots are not remembered: those files were uploaded this once and no directory " +
    "was added. Move them into a folder if the owner should be able to allow it for good.",
} as const;

/**
 * What a call refused for want of a pairing tells the agent about *why* (003 FR-032a).
 *
 * `reason` stays `not-paired` on both - every client and gate since 003 branches on it - and the
 * difference rides in `hint`, which is where a sentence the agent relays to the person belongs. The
 * two are opposite instructions: a decline answered one request, so the agent must not simply ask
 * again but the session is not dead; an unpair ended the session's standing, so nothing but a
 * reconnect helps. Here for the reason `ATTENTION_SENTENCES` is here - the host composes them and
 * the gates assert them - and like those they carry no hole to fill (FR-151).
 */
export const PAIRING_REFUSAL_HINTS = {
  declined:
    "The owner declined this pairing request in Chrome. Do not call Hallpass tools again unless the person asks you to; " +
    "the next call will show them a new request.\n" +
    "擁有者在 Chrome 拒絕了這次配對要求。除非使用者要求,否則不要再呼叫 Hallpass 工具;下一次呼叫會再顯示新的配對要求。",
  unpaired:
    "The owner unpaired this agent in Hallpass, so every call in this session is refused until it reconnects. " +
    "In Claude Code: run /mcp and reconnect the hallpass server.\n" +
    "擁有者已在 Hallpass 取消這個 agent 的配對,這個工作階段在重新連線前的每個呼叫都會被拒絕。Claude Code:執行 /mcp 並重新連線 hallpass 伺服器。",
} as const;

/**
 * What the two browser refusals tell the agent to do (018 contracts/browser-tools.md, FR-272,
 * FR-277), English line then zh-TW line as `PAIRING_REFUSAL_HINTS`.
 *
 * Here for the reason those are: the host composes them, the agent relays them to the person and
 * the gates assert them. `disconnected` has one hole, the browser's name, because "which browser"
 * is the whole of what the person is being asked about; the name is the owner's own text, already
 * free of control characters (`agentBrowserNameSchema`), and at 40 characters the sentence stays
 * inside the response's 400-character `hint`.
 */
export const BROWSER_REFUSAL_HINTS = {
  notChosen:
    "Several browsers are running Hallpass. Ask the user which one to use, then call select_browser with its " +
    "browserId (or request_browser_choice to let them pick it in the browser).\n" +
    "有多個瀏覽器正在執行 Hallpass。請問使用者要用哪一個,再用它的 browserId 呼叫 select_browser(或呼叫 request_browser_choice 讓使用者在瀏覽器裡選)。",
  disconnected: (name: string): string =>
    `The browser this session was using (${name}) is no longer connected. Ask the user whether to wait for it ` +
    "or to use another browser.\n" +
    `這個工作階段使用的瀏覽器(${name})已經沒有連線。請問使用者要等它回來,還是改用另一個瀏覽器。`,
} as const;

/**
 * Whether a directory is a whole drive or a whole share (014 FR-194, S3 review F7).
 *
 * The card's "from now on" adds the file's own parent, and for a file sitting at `D:\` or at
 * `\\server\share` that parent is everything on the drive or the share: one press and every file on
 * it is uploadable, unasked, for as long as the row stands. The host refuses to write such a root
 * and the worker has to know the same rule - it must not then report the answer as one the host
 * failed to record - so the rule lives here, where both of them read it from one place.
 *
 * Spelt as shapes rather than with `node:path`, because the worker has no `node:path`: a drive
 * letter with only separators after it, a UNC `\\server\share` with nothing below it, and the
 * POSIX root, which this product does not ship on but which the path schema accepts.
 */
export function isRootDirectory(path: string): boolean {
  return /^[A-Za-z]:[\\/]*$/u.test(path) || /^\\\\[^\\/]+[\\/][^\\/]+[\\/]*$/u.test(path) || /^\/+$/u.test(path);
}

/**
 * What the call the tab moved during tells the agent (014 FR-186, contracts/transitions.md).
 *
 * A sentence with two holes rather than a constant, because the two origins *are* the notice: an
 * agent told only that "the tab moved" would have to spend a call finding out where to, which is a
 * call this feature would then hold behind a card.
 *
 * It rides in `hint` - the response frame is a strict object and a new key makes the whole frame
 * fail to parse on an older host (R-187 §6) - and it is composed here so that the worker that
 * writes it and the gate that reads it cannot drift into two sentences.
 */
export function transitionNoticeText(from: string, to: string): string {
  return `The tab moved from ${from} to ${to}; the next call on this tab will ask the owner.`;
}

/**
 * A path on the owner's own machine, as the two processes that pass one around may state it.
 *
 * Absolute only, and checked at the shape rather than where it is used: a relative path is a path
 * whose meaning depends on which process resolves it, and the host, the relay and the browser have
 * three different working directories. Windows drive-rooted, UNC and POSIX forms are all accepted -
 * the product is Windows-only today, and the check is about rootedness rather than about a
 * platform.
 */
export const absolutePathSchema = z
  .string()
  .min(2)
  .max(4096)
  .refine((value) => /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/"), {
    message: "expected an absolute path",
  });

/**
 * The one answer to one call. `reason` is a short stable code, never page text: the host logs
 * outcomes, and an unbounded reason is how page-derived content reaches a log (FR-035).
 */
export const agentNativeResponseSchema = z.strictObject({
  callId: z.string().min(1).max(64),
  outcome: agentToolOutcomeSchema,
  result: z.unknown().optional(),
  reason: z.string().max(200).optional(),
  /**
   * The same refusal, with the evidence the code alone cannot carry (004; see `agentRefusalSchema`).
   *
   * Beside `reason` rather than instead of it: `reason` stays the short stable code every 003 log
   * line and every panel string is written against, and this is the structured form the slices fill
   * where the agent needs more than the code - which session holds the tab, how big the viewport is.
   */
  refusal: agentRefusalSchema.optional(),
  /**
   * Where the person has to click, when that is why this answer is a `timed-out` (011 FR-146).
   *
   * It is beside `reason` for the reason `refusal` is: `reason` stays the short stable code the
   * agent branches on, and this is the sentence it relays to the person at the terminal. Present
   * only when the question was raised with no side panel connected - a prompt nobody could see is a
   * different fact from a prompt somebody ignored, and only the first one has an instruction that
   * would have helped. The text is never page-derived: it is one of `ATTENTION_SENTENCES`, and the
   * bound is the length of the longer of them with room to spare.
   */
  hint: z.string().max(400).optional(),
});

export type AgentNativeResponse = z.infer<typeof agentNativeResponseSchema>;

/**
 * The mark a worker puts on a pairing refusal that is the owner's decline of *this* request
 * (003 FR-032a).
 *
 * A refusal without it is an unpair: every later call of the session is refused unasked until it
 * reconnects. That default is the spec's own rule for an extension that predates the amendment,
 * and it is why the mark goes on the decline rather than on the unpair - the frame nobody marked
 * keeps meaning what it always meant.
 *
 * It rides in `pair-result.features` rather than in a key of its own, and that is a compatibility
 * decision, not a taxonomy one. Every frame here is a `z.strictObject`, so a new key makes an older
 * host reject the whole answer and drop it (R-187 §6) - and the frame it would drop is the unpair
 * FR-032 says takes effect at once. `features` has been an open list of short strings since 0.6.0,
 * so a 0.6.0 host parses a marked answer, ignores the member it does not know, and settles it as
 * the sticky refusal it has always been: never worse than before, only not yet better. Hosts older
 * than 0.6.0 already refuse `features` itself, which is 014's documented "reinstall the host" case.
 */
export const PAIRING_DECLINED_MARKER = "declined-this-request";

/**
 * The capability a worker advertises in `pair-result.features` when it can raise the site-plan
 * card (017 R-248, R-251), exactly as `upload-consent` says it can raise the directory card.
 *
 * A host never forwards `propose_sites` to a worker that did not say so: the tool is listed before
 * any pairing says which extension is on the other side, and an older worker would answer an
 * unknown tool with nothing the agent could act on.
 */
export const SITE_PLAN_FEATURE = "site-plan";

/**
 * The capability a worker advertises in `relay-ack.features` when it can show the "Use this browser
 * for <agent>?" card (018 R-273, R-279).
 *
 * On the ack rather than on `pair-result`, because the choice is asked of browsers the agent may not
 * be paired in yet; and read from the worker rather than from the relay's version, because a new
 * host beside an old extension is routine. The relay copies it into its record, and a server opens
 * a choose-only link (`hello.intent: "choose"`) only to a browser whose record carries it.
 */
export const BROWSER_CHOICE_FEATURE = "browser-choice";

/**
 * What a `propose_sites` call that cannot be asked says (017 FR-265): outcome `unavailable`, this
 * reason, and this hint. Here for the reason `UPLOAD_HINTS` is: the host composes it and the gates
 * assert it. No hole to fill (FR-151).
 */
export const SITE_PLAN_UNAVAILABLE = {
  reason: "extension-too-old",
  hint:
    "The Hallpass extension in this browser does not support site plans yet. Ask the owner to reload the " +
    "extension on the browser's extensions page, then propose again; until then each site asks as before.",
} as const;

/**
 * The frames that are about the connection rather than about a page. They share the channel with
 * tool calls and share nothing else: a control frame is recognised by its `type`, and a tool
 * response can never be mistaken for one.
 *
 * `stop` without a `sessionId` is the owner stopping everything - the widest reading of Stop, which
 * is the safe one when the owner has just asked for it.
 */
export const agentControlFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("pair-request"),
    agentId: z.string().min(1).max(128),
    displayName: z.string().min(1).max(128),
    origin: z.string().min(1).max(256),
    /**
     * The session this connection belongs to, minted once by the host at MCP `initialize`
     * (003 D-M3-3).
     *
     * It comes from the host rather than the worker because the *agent session* is what a session
     * is: the worker sees relay connections come and go while one agent session runs, and a worker
     * that minted its own id per connection would strand the tab group the previous id owned. One
     * id per agent session is what lets a reconnect reconcile the record it already has.
     */
    sessionId: z.string().min(1).max(128),
    /**
     * The host-minted id of this pairing exchange (015 FR-216, FR-219). Optional: a 0.7.0 host
     * never sends it, and the worker then behaves as before.
     */
    requestId: z.string().min(1).max(128).optional(),
  }),
  z.strictObject({
    type: z.literal("pair-result"),
    agentId: z.string().min(1).max(128),
    /**
     * The session whose `pair-request` this answers (004 T094a).
     *
     * Required, and the field the answer is *routed* by: the relay delivers a worker frame to the
     * server that owns its `callId` or its `sessionId` and never broadcasts, so before this field
     * existed the answer named nobody and was dropped as unaddressed - pairing could not complete
     * over the real link at all. It is echoed from the request rather than chosen by the worker,
     * because the session is the host's (D-M3-3) and an answer that renamed it would settle the
     * wrong session's question.
     *
     * `agentId` stays beside it and is still what the server checks: one browser holds several
     * pairings, and an unpair travels this same shape to every live session of that agent.
     */
    sessionId: z.string().min(1).max(128),
    accepted: z.boolean(),
    /**
     * Which run of the browser is answering (013/R-184, FR-168).
     *
     * An opaque id the worker mints once per browser start and keeps in `chrome.storage.session`,
     * so it survives the worker being recycled and dies when the browser exits - the two halves of
     * FR-168's retention promise, as one fact. It rides *this* frame because a pairing answer is
     * what the first call on every (re)established link asks for (004 FR-059a: the link itself asks
     * nothing), and because the host awaits it before that call reads its screenshot cache: a run
     * that changed means the browser restarted and the cache goes, while a run that did not means
     * only the port went away and the pictures stay.
     *
     * Optional in the shape, and additive: a worker from before this field says nothing about its
     * run and the host falls back to clearing on the link, which is what it did in S1. The link
     * protocol floor does not move - this is the worker's answer, not the greeting the relay checks.
     */
    browserRunId: z.string().min(1).max(64).optional(),
    /**
     * What this worker can be asked to do, beyond answering calls (014/R-187 §1).
     *
     * `upload-consent` is the only member today: it says the worker can raise the directory card,
     * so the host may hold a `file_upload` open and ask instead of refusing it. The host must know
     * before it asks, because a request a worker does not recognise is dropped as an unknown frame
     * type and the call would then hang until its own bound - an old worker answered nothing and a
     * new one answers "no such frame" the same way.
     *
     * Added exactly as `browserRunId` above was (013/R-184): optional, on the frame the worker
     * sends on every established link, so a host that predates the field parses the answer and a
     * worker that predates it simply advertises nothing. The link protocol floor does not move.
     *
     * 003 FR-032a adds one member that is about this answer rather than about the worker:
     * `PAIRING_DECLINED_MARKER` on a refusal says the owner declined this one request, and its
     * absence says unpair. It lives here because this is the one field of this frame a 0.6.0 host
     * already accepts arbitrary members of (see the marker's own comment).
     */
    features: z.array(z.string().min(1).max(64)).max(16).optional(),
    /**
     * Echoes the `requestId` of the `pair-request` this answers (015 FR-218). A host ignores an
     * answer naming an exchange it withdrew; an answer without one is handled as in 0.7.0.
     */
    requestId: z.string().min(1).max(128).optional(),
  }),
  /**
   * The host stopped waiting for this session's pairing answer - its bound expired or the session
   * closed (015 FR-216, FR-217). The worker drops the session from the card's waiting list. A new
   * frame `type`, so an older worker drops it and falls back on its own bound (FR-219).
   */
  z.strictObject({
    type: z.literal("pair-withdraw"),
    agentId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    requestId: z.string().min(1).max(128).optional(),
  }),
  z.strictObject({
    type: z.literal("unpair"),
    agentId: z.string().min(1).max(128),
  }),
  z.strictObject({
    type: z.literal("stop"),
    sessionId: z.string().min(1).max(128).optional(),
    /**
     * The one call this stop ends (003 D-M3-1).
     *
     * The host sends it when its own backstop fires: the agent has already been told the call timed
     * out, so anything the worker is still holding for it - an `ask` prompt in particular - is a
     * question about an answer that has already been given. Absent means the owner stopped
     * everything, which is the widest reading and the safe one when they have just asked for it.
     */
    callId: z.string().min(1).max(64).optional(),
  }),
  /**
   * The relay's first frame on the loopback link to the MCP server (R-102). It proves the relay
   * read `bridge.json` - that is, that it is running as the same user - and it proves nothing else:
   * the token is not the pairing, which is the owner's accept in the panel. It carries no identity,
   * so a peer cannot smuggle an `agentId` past the pairing prompt by putting it in the greeting.
   */
  z.strictObject({
    type: z.literal("hello"),
    token: z.string().min(1).max(128),
  }),
  /**
   * The relay's only answer when there is no MCP server to reach. It is a fact about the link, not
   * an error the owner has to act on, so it carries no prose: the worker turns it into the panel's
   * "unavailable" status and retries on its alarm (FR-033).
   */
  z.strictObject({
    type: z.literal("bridge-unavailable"),
  }),
  /**
   * The host asking the owner about a file outside the directories they listed (014/R-187 §1).
   *
   * It goes the direction nothing else on this link goes - host to worker, *during* a call the
   * host is holding - because the paths are the host's to see and nobody else's: the worker never
   * reads a file and the page is never told a file name. The card the worker raises from this
   * shows the owner their own paths in full, and the answer comes back on the frame below.
   *
   * `directory` is the file's own parent as the host resolved it, carried beside the path because
   * it is what the owner's "from now on" would add - the card must not make the panel derive a
   * directory from a path with string arithmetic the host has already done properly.
   */
  z.strictObject({
    type: z.literal("upload-consent-request"),
    sessionId: z.string().min(1).max(128),
    callId: z.string().min(1).max(64),
    files: z
      .array(z.strictObject({ path: absolutePathSchema, directory: absolutePathSchema }))
      .min(1)
      .max(AGENT_UPLOAD_MAX_FILES),
  }),
  /**
   * The owner's answer, once per request (014/R-187 §1).
   *
   * Six words rather than a boolean and a flag, because six different things happened: these
   * files this once, these directories from now on, no, nobody answered, the owner interrupted the
   * step the question belonged to (R-185 §3), and - since S3 review F3 - the owner was already
   * being asked something else, so this card was never raised. The host maps each to what the call
   * answers, and `busy` is the one that must not be dressed up as any of the others: an agent told
   * `owner-interrupted` about a card nobody ever saw learns the owner did something they did not.
   */
  z.strictObject({
    type: z.literal("upload-consent-result"),
    callId: z.string().min(1).max(64),
    decision: z.enum(["once", "always", "deny", "timed-out", "interrupted", "busy"]),
    /**
     * Where the person has to click, when this question expired with nobody able to see it
     * (011 FR-146, S3 review F1).
     *
     * The worker is the only end that knows: it chose the bound from whether a panel was connected
     * when the card was raised, and it is the side that owns the sentence. Without it the host's
     * `upload-not-answered` would be the one unanswered question in the product that does not tell
     * the person how to answer it. Optional on a frame type this feature introduced, so no older
     * side can meet it; the text is one of `ATTENTION_SENTENCES` and never page-derived.
     */
    hint: z.string().max(400).optional(),
  }),
]);

export type AgentControlFrame = z.infer<typeof agentControlFrameSchema>;

/**
 * The frames of the loopback link between the relay and an mcp-server (004 README §1).
 *
 * They live here, beside the tool frames, because three parties have to agree on them: the relay
 * Chrome spawns, every server an agent spawns, and the worker the control frames end up at. The
 * relay is a pump that re-sends what it decoded, so a shape only two of the three knew about would
 * travel one hop and be dropped at the next.
 *
 * A union of its own rather than more members on `agentControlFrameSchema`, for the length of one
 * slice: 003's link is still the one running, and its `hello` means something else - the *relay*
 * greeting the *server*. The slice that inverts the link (S1) folds these in and retires that one,
 * and until it does the two shapes are separately named rather than silently overlapping.
 */
/**
 * The version of the two cross-process contracts below: the link greeting and the bridge record
 * (004/T099j).
 *
 * Chrome spawns the relay and keeps it for the life of the browser, so a host upgrade routinely
 * leaves an old relay running against new servers. Without a stamp that met as an endless dial loop
 * with no log naming the cause, or as a record the other side read as absent and reported
 * `bridge-unavailable` for. A small integer is enough: nothing here negotiates, and the only
 * question either side asks is "is this stamp mine".
 *
 * It is a floor, not a counter. 004 raises it once for every change it makes to these two shapes,
 * and the next bump belongs to the next release that changes them.
 */
/**
 * It stays at 2 for the `prompt-waiting` frame of 011, deliberately (plan.md "Constraints").
 *
 * The stamp is a floor for shapes both sides must agree on. This one they need not: a tick is a
 * keep-alive, every end of it is already handled, and both ends drop a type they do not know - the
 * relay logs it as unaddressed, the host as a rejected frame. So an old relay in front of a new
 * host loses the ticks and the call falls back to the bound it had before, while a bump would have
 * refused that pair outright and broken a browser the owner had not restarted yet.
 */
/**
 * It stays at 2 for 012 as well (012/T304, contracts/viewport-and-capture.md).
 *
 * Everything this feature adds is additive in the one direction that matters: every new field on
 * the screenshot answer is optional, so a worker that predates them answers what it always did and
 * a host that predates them drops what it does not know; and `viewport` is simply absent from an
 * older offering, which is the ordinary "tool not offered" an agent already handles. A bump would
 * refuse the pair outright and break a browser the owner had not restarted yet, for a change
 * neither end has to agree on.
 */
/**
 * It stays at 2 for 014, and the measurement says why (T349, R-187 §6).
 *
 * Every frame schema on this link is `z.strictObject`, so an addition can take exactly two forms
 * and this feature uses both: a **new frame type**, which an old side logs as unexpected and drops
 * (`upload-consent-request`, `upload-consent-result`, `upload-roots-list`, `upload-roots-remove`,
 * `upload-roots`), and an **optional field on a frame the other end is the one that predates**
 * (`pair-result.features`, added exactly as 013 added `browserRunId`). Neither end has to agree on
 * anything new: a host without the feature never asks, a worker without it never advertises, and
 * an old relay simply drops a list request. The transition notice is not a field at all - it rides
 * in the existing `hint`, because a new key would make the whole answer fail to parse.
 *
 * A bump would refuse every pair outright until the owner restarted a browser they have no reason
 * to restart, for a change nothing has to negotiate.
 */
export const AGENT_LINK_PROTOCOL = 2;

/**
 * The questions the side panel can be holding (011 data-model "Pending question").
 *
 * Pairing is one of them here even though it lives in a different controller: from the person's
 * side it is the same situation - something is waiting in a panel they cannot see - and the kind is
 * what picks which of the two sentences they are told.
 */
/**
 * 014: two more, and both are questions about something that has *already* happened rather than
 * about a call's arguments - a tab that moved to an origin the session has not been on (FR-186),
 * and a file the host is holding from a directory the owner has not listed (FR-192). They are
 * kinds rather than two more `ask` prompts because the card is a different sentence with different
 * buttons, and because the tick that says a question is still waiting names its kind.
 */
export const AGENT_PROMPT_KINDS = [
  "pairing",
  "ask",
  "plan",
  "dialog",
  "diagnostics",
  "transition",
  "upload-directory",
  /**
   * 018 FR-274: "Use this browser for <agent>?". A kind of its own because the card is a different
   * sentence with different buttons, and because the tick that keeps the requesting call alive for
   * its two minutes names its kind.
   */
  "browser-choice",
] as const;

export type AgentPromptKind = (typeof AGENT_PROMPT_KINDS)[number];

/**
 * What the agent says to the person when the panel that holds their question is closed (011 R-164).
 *
 * Three fixed strings, English line then zh-TW line, and no third party in the sentence: no page
 * text, no tool arguments, no session id (FR-151), so there is nothing to template and no `{` in
 * them. Each travels as a `hint` (at most 400 characters) and as progress text. They live in the
 * contracts package because three parties have to say the same words - the worker that raises the
 * question, the host that relays it as progress and as a `timed-out` hint, and the tests that
 * assert what the person was told.
 *
 * `consent` covers ask, plan, dialog and diagnostics: the person is being asked to answer a card,
 * and which card it is is on the card, not in a sentence read from a terminal.
 *
 * `choice` (018 US3 AS4, T515 m3 follow-up) has a sentence of its own because the consent one would
 * be wrong for it twice over: it speaks of a consent card, where this is a question about which
 * browser to use, and it says "Chrome's side panel", where the choice spans every connected
 * browser (Chrome, Edge, Brave) and the person must open the panel in the one they want. So it
 * names no card and no browser, and says where the answer is given: in the browser they pick.
 */
export const ATTENTION_SENTENCES = {
  pairing:
    "Hallpass is waiting for you to accept the pairing in Chrome's side panel, which is closed. Click the Hallpass icon in the toolbar or press Alt+A to open it.\n" +
    "Hallpass 正在等你在 Chrome 側欄接受配對,但側欄沒有打開。請點工具列的 Hallpass 圖示或按 Alt+A 打開它。",
  consent:
    "Hallpass is waiting for your answer to a consent card in Chrome's side panel, which is closed. Click the Hallpass icon in the toolbar or press Alt+A to open it.\n" +
    "Hallpass 正在等你回答側欄裡的同意卡,但側欄沒有打開。請點工具列的 Hallpass 圖示或按 Alt+A 打開它。",
  choice:
    "Hallpass is waiting for you to choose which browser to use, and the side panel that asks is closed. In the browser you want, click the Hallpass icon in the toolbar or press Alt+A, then confirm there.\n" +
    "Hallpass 正在等你選擇要用哪個瀏覽器,但詢問的側欄沒有打開。請在你要用的瀏覽器點工具列的 Hallpass 圖示或按 Alt+A,然後在那裡確認。",
} as const;

/**
 * "This question is still waiting", sent every five seconds while one is (011 R-162, FR-148).
 *
 * It exists because three bounds are in play and only the worker knows the one that matters. The
 * worker fixes the question's bound when it raises it - 120 s when no panel is connected, the
 * ordinary 25 s / 45 s when one is - and the host's own per-call backstop is 30 s, so without this
 * the transport would give up on a call while the person was still walking to their browser. The
 * tick carries the arithmetic rather than a command: `waitedMs` and `boundMs` let the router
 * re-arm its backstop statelessly, and `panelConnected` is what picks between the neutral progress
 * text and one of `ATTENTION_SENTENCES`.
 *
 * `callId` is absent for pairing alone: the pairing exchange belongs to the server, not to any one
 * call, and a tick that named a call would tie it to whichever call happened to arrive first.
 */
export const promptWaitingFrameSchema = z.strictObject({
  type: z.literal("prompt-waiting"),
  sessionId: z.string().min(1).max(128),
  callId: z.string().min(1).max(64).optional(),
  kind: z.enum(AGENT_PROMPT_KINDS),
  panelConnected: z.boolean(),
  waitedMs: z.number().int().nonnegative(),
  boundMs: z.number().int().positive(),
});

export type PromptWaitingFrame = z.infer<typeof promptWaitingFrameSchema>;

export const agentLinkFrameSchema = z.discriminatedUnion("type", [
  /**
   * A server announcing itself, on both legs of the trip (004/T099i).
   *
   * From the server it carries the token from the relay's own record - proof it runs as this user
   * and may reach the browser at all - and the identity the owner will be asked about, so the relay
   * never has to invent one for a peer that did not state it. The relay then forwards the same
   * frame to the worker as *the* announcement of a live session, and strips the token on the way:
   * the token is the relay's own admission check and nothing in the extension has a use for it, so
   * it stops at the process that minted it.
   *
   * That is why `token` is optional in the shape and required by the relay's own check. Session
   * liveness rides on this frame rather than on `pair-request`, because a greeting is what every
   * attach sends by definition, while when a pairing request is sent is a decision pairing gets to
   * change (FR-058).
   */
  z.strictObject({
    type: z.literal("hello"),
    sessionId: z.string().min(1).max(128),
    agentId: z.string().min(1).max(128),
    displayName: z.string().min(1).max(128),
    token: z.string().min(1).max(128).optional(),
    /**
     * The protocol this server speaks (T099j). Optional in the shape and checked by the relay, so
     * a greeting from before the stamp existed is refused with a code that names the reason rather
     * than failing to parse as "some frame".
     */
    protocol: z.number().int().min(1).optional(),
    /**
     * 018 R-273, R-279: this link exists only to ask "Use this browser?" - the worker raises the
     * choice card for it and creates no session card and no tab group. Optional, and sent only to a
     * relay whose record advertises `BROWSER_CHOICE_FEATURE`: an older relay parses `hello` strictly
     * and would refuse the whole greeting. The session id on such a link is derived from the
     * requesting session's, because a `hello` naming a live session replaces that connection.
     */
    intent: z.literal("choose").optional(),
  }),
  /**
   * The relay's acknowledgement, and the whole of it: its pid. That is what lets a server tell a
   * relay that restarted from the one it greeted, which is the fact the 15 s reconciliation turns on.
   */
  z.strictObject({
    type: z.literal("hello-ack"),
    relayPid: z.number().int().positive(),
  }),
  /**
   * One server's socket closed. The worker ends that session and nothing else: with several sessions
   * live, a link event that did not name one would end the wrong agent's work.
   */
  z.strictObject({
    type: z.literal("session-ended"),
    sessionId: z.string().min(1).max(128),
  }),
  /**
   * The relay's first frame after Chrome opened the native port. The worker starts its 15 s
   * reconciliation from it: the sessions that greet again inside the window survive, and the ones
   * that do not are ended - which is why this frame is about the relay alone and may not carry a
   * session.
   */
  z.strictObject({
    type: z.literal("relay-started"),
    relayPid: z.number().int().positive(),
    /**
     * Where this relay writes its record, as the host resolved it (006 FR-082): the one fact of
     * the not-connected page's technical details the worker cannot know on its own. Optional
     * rather than a protocol bump - a greeting without it is still a greeting.
     */
    recordPath: z.string().min(1).max(1024).optional(),
  }),
  /**
   * The worker's answer to `relay-started`: this relay has a live owner (004/T169, protocol 2).
   *
   * A relay publishes its record - and so can take the bridge over from the relay that was serving
   * - only once this has arrived. Chrome spawns a host for every `connectNative`, including ones
   * from a worker instance that is on its way out and will never read a frame; such a host used to
   * take the record the moment it listened, and the relay serving a live call was drained and
   * closed under it. A host nobody acknowledges now never publishes and leaves on a bound. Both
   * reference extensions run a handshake before treating a port as their connection; this is ours.
   */
  z.strictObject({
    type: z.literal("relay-ack"),
    relayPid: z.number().int().positive(),
    /**
     * Which run of the browser is answering (013/R-184), so a relay can tell its own browser's
     * previous relay from another browser's (two browsers, 2026-10-02). Optional: a relay from
     * before it reads only `type` and `relayPid`, and a worker from before it leaves it off, which
     * the relay reads as "unknown" and takes the record over exactly as it always has.
     */
    browserRunId: z.string().min(1).max(64).optional(),
    /**
     * Who this browser is (018 data-model, R-268): its minted id, its kind, the name the owner set
     * (absent = the default name, R-269) and what it can be asked (`BROWSER_CHOICE_FEATURE`). The
     * relay writes them into its own `browsers/<browserId>.json`. All optional, exactly as
     * `browserRunId` was added: a 0.10.0 relay reads only `type`/`relayPid`/`browserRunId`, and a
     * worker older than 018 sends none, which the relay records as a legacy browser.
     */
    browserId: agentMintedBrowserIdSchema.optional(),
    browserKind: agentBrowserKindSchema.optional(),
    browserName: agentBrowserNameSchema.optional(),
    features: z.array(z.string().min(1).max(64)).max(16).optional(),
  }),
  // `relay-standby` (two browsers, 2026-10-02) is gone: 018 serves every browser through its own
  // record, so no relay stands aside (R-274, FR-280). A 0.10.x relay that still sends it to a newer
  // worker is refused at this union and dropped, which is all it needs.
  /** The worker's "still waiting" tick (011); see `promptWaitingFrameSchema` for why it is here. */
  promptWaitingFrameSchema,
  /**
   * The worker asking what the owner's upload directories are (014/R-187 §4).
   *
   * It carries nothing: there is one list per machine, the relay is the one process that both
   * talks to this worker and can read the file, and a request that named a session would imply a
   * list per agent - which is the opposite of what this list is. Sent on `relay-ack` and after
   * every answer, so the panel's rows are a picture of the file rather than of what the panel last
   * did to it.
   */
  z.strictObject({
    type: z.literal("upload-roots-list"),
  }),
  /**
   * The owner revoking one directory from the panel (014 FR-194).
   *
   * Remove only. There is deliberately no `add` on this link: the list grows by exactly one route,
   * the owner answering "from now on" on a card the *host* raised about a file it already has in
   * hand (FR-195). A browser-side add would be a way for anything that reached this port to widen
   * what the host may read.
   */
  z.strictObject({
    type: z.literal("upload-roots-remove"),
    root: absolutePathSchema,
  }),
  /**
   * The relay's answer to either of the two above: the list as the file now reads.
   *
   * `path` is where the file lives, for the panel's own row - the owner may want to open it, and
   * it is a fact about *their* machine shown to *them*. It never travels the other way: no tool
   * argument, answer or description names it (T381).
   *
   * `malformed` is the one thing the list cannot say by being empty: a config file that could not
   * be read as a list is treated as `[]`, exactly as the host has always treated it, and the panel
   * says so rather than showing "no directories" about a file that may hold ten.
   */
  z.strictObject({
    type: z.literal("upload-roots"),
    roots: z.array(absolutePathSchema).max(256),
    path: absolutePathSchema,
    malformed: z.boolean().optional(),
    /**
     * The name of the copy the host kept of a document it could not read (S3 review F4).
     *
     * A file that will not parse is read as no directories at all, and the first write after that
     * used to go straight over it. It is moved aside instead, and this says where to - a file name
     * beside the `path` already on the frame, never a second path. Optional on a frame type this
     * feature introduced, so there is no older side that could meet it.
     */
    preserved: z.string().min(1).max(64).optional(),
  }),
  /**
   * The name of the folder a session works in, as its own host read it (016 FR-226, R-203, R-204).
   *
   * Sent by the host once after every `hello-ack`, and only when it has a label: the last segment
   * of the first `file://` root the client advertised, or of its working directory. A frame of its
   * own rather than a field on `hello`, because a 0.8.0 relay parses `hello` strictly and would
   * refuse the whole greeting; a 0.8.0 relay forwards this one like any greeted frame, and a 0.8.0
   * worker drops it as unknown. Remote input: the panel renders it as inert text, nothing logs it.
   */
  z.strictObject({
    type: z.literal("session-label"),
    sessionId: z.string().min(1).max(128),
    label: z.string().min(1).max(64),
  }),
  /**
   * 018 (contracts/browser-tools.md "Link frames"). New frame types, so an older side drops them as
   * unknown and the protocol stays 2 (R-267); each is sent only to a peer known to read it.
   *
   * The owner renamed this browser in its panel (FR-268): worker to relay, which rewrites its own
   * record. Nothing else on the machine may name a browser.
   */
  z.strictObject({
    type: z.literal("browser-name"),
    name: agentBrowserNameSchema,
  }),
  /**
   * How many other browsers are connected, and this browser's default name, from the relay's 1 s
   * directory poll (FR-268, R-269): relay to worker, for the panel's "This browser" row. The default
   * name comes from the relay because numbering depends on the others, which only the host can see.
   */
  z.strictObject({
    type: z.literal("browser-peers"),
    others: z.number().int().nonnegative().max(1_000),
    defaultName: agentBrowserNameSchema,
  }),
  /**
   * Another live browser of another run already holds this browser's id (a copied profile, R-276):
   * relay to worker, which mints a new identity. It carries nothing - the worker knows its own id,
   * and naming the other browser's run would tell one profile about another for no use.
   */
  z.strictObject({
    type: z.literal("browser-identity-conflict"),
  }),
  /**
   * The in-browser choice (FR-274, R-273): the requesting server asks every browser that advertised
   * `BROWSER_CHOICE_FEATURE`, on a choose-only link (`hello.intent: "choose"`).
   *
   * `sessionId` is the choose link's own (derived) session id. It is not in the contract table, and
   * it is on these three frames because the relay routes nothing without it: a server frame whose
   * `sessionId` is not its greeting's is refused (`relay-mux.ts`, T099e), and a worker frame is
   * delivered to the server that owns its session. Echoed, never chosen, as on `pair-withdraw`.
   */
  z.strictObject({
    type: z.literal("browser-choice-request"),
    sessionId: z.string().min(1).max(128),
    requestId: z.string().min(1).max(128),
    agentName: z.string().min(1).max(128),
    boundMs: z.number().int().positive().max(AGENT_MAX_CALL_TIMEOUT_MS),
  }),
  /** The owner's answer on one browser's card; the first confirm anywhere settles the request. */
  z.strictObject({
    type: z.literal("browser-choice-result"),
    sessionId: z.string().min(1).max(128),
    requestId: z.string().min(1).max(128),
    decision: z.enum(["confirm", "decline"]),
  }),
  /** The request was settled elsewhere or ran out: the worker takes its card down (as 015's withdraw). */
  z.strictObject({
    type: z.literal("browser-choice-withdraw"),
    sessionId: z.string().min(1).max(128),
    requestId: z.string().min(1).max(128),
  }),
]);

export type AgentLinkFrame = z.infer<typeof agentLinkFrameSchema>;

/**
 * The rendezvous file in the host data directory (004 R-111, data-model BridgeRecord).
 *
 * 003 had the server publish it and the relay dial; 004 turns that around, because there is one
 * relay and several servers now and only the singular side can own a listening port. So the pid in
 * the file is the *relay's*, and it is named `relayPid` rather than kept as `pid`: the two records
 * live at the same path, and a strict shape is what stops a server left over from 003 being dialled
 * as though it were the relay. The token is per relay start; a wrong one closes the socket.
 */
export const agentBridgeRecordSchema = z.strictObject({
  port: z.number().int().positive().max(65_535),
  token: z.string().min(32).max(128),
  relayPid: z.number().int().positive(),
  startedAt: z.string().min(1).max(64),
  /**
   * The protocol the relay that wrote this record speaks (T099j). Required: a record without it was
   * written by a build from before the stamp, and reading it as an address is exactly the silent
   * failure the stamp exists to name.
   */
  protocol: z.number().int().min(1),
});

export type AgentBridgeRecord = z.infer<typeof agentBridgeRecordSchema>;

/**
 * Which browser run the relay named in the record belongs to (two browsers, 2026-10-02).
 *
 * A file of its own beside the record rather than a field on it: the record is parsed strictly by
 * every MCP server already running, and a field they do not know would read to them as no record
 * at all. Only relays read this one. It is written by the relay that owns the record, right after
 * the record, and retracted with it; a sidecar that names a different pid than the record is stale
 * and means nothing.
 */
export const agentBridgeOwnerSchema = z.strictObject({
  relayPid: z.number().int().positive(),
  /** Absent when the owning worker did not say (a worker from before `relay-ack` carried it). */
  browserRunId: z.string().min(1).max(64).optional(),
});

export type AgentBridgeOwner = z.infer<typeof agentBridgeOwnerSchema>;

/** The owner's standing decision for one site (R-107). The agent can never set its own. */
export const SITE_MODES = ["ask", "follow-a-plan", "skip-checks"] as const;

export type SiteMode = (typeof SITE_MODES)[number];

export const siteModeSchema = z.enum(SITE_MODES);

/**
 * A site is scheme + host, with the port kept because the fixtures live on one (R-108).
 *
 * `new URL(value).origin === value` is what rules out a path, a trailing slash, credentials, a
 * query and a default port written out - the same test the build config applies to an endpoint, and
 * for the same reason: a record keyed by anything but the origin would either apply one page's
 * decision to another page or fail to apply the owner's decision at all. The wildcard is checked
 * separately because the URL parser accepts `*` as an ordinary host character.
 */
function isSiteOrigin(value: string): boolean {
  if (value === "" || value.includes("*")) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.origin !== "null" && parsed.origin === value;
}

export const siteOriginSchema = z.string().refine(isSiteOrigin, { message: "expected scheme://host[:port]" });

/** The per-site projection the worker sends the side panel, and the panel's commands act on. */
export const siteModeRecordSchema = z.strictObject({
  site: siteOriginSchema,
  mode: siteModeSchema,
  diagnosticsGranted: z.boolean(),
});

export type SiteModeRecord = z.infer<typeof siteModeRecordSchema>;

/**
 * The agent path's own side-panel port (003/T019).
 *
 * A second port, not a second message type on the archived control port: the remote path's schemas
 * are closed and frozen, and widening them would make the archived artefact carry shapes only the
 * agent build can produce. Two ports, two closed unions, no shared surface to drift.
 */
export const AGENT_PANEL_PORT_NAME = "hallpass-panel";

/**
 * How the link to the local agent host looks to the owner. Closed states, no free text.
 *
 * (`standby`, from the two-browser stop-gap of 2026-10-02, went with 018: every browser is served.)
 */
export const AGENT_BRIDGE_STATUSES = ["connected", "unavailable", "disconnected"] as const;

export type AgentBridgeStatusValue = (typeof AGENT_BRIDGE_STATUSES)[number];

export const agentBridgeStatusSchema = z.enum(AGENT_BRIDGE_STATUSES);

const agentIdentitySchema = z.strictObject({
  agentId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(128),
  origin: z.string().min(1).max(256),
});

/**
 * When a question reached the owner (006 FR-085): the panel shows the questions it holds one at a
 * time, in arrival order, and this is the order. Optional on every question because a 004 worker
 * never stamped one; the panel falls back to its fixed precedence for an undated projection.
 */
const questionArrivalSchema = z.string().min(1).max(64).optional();

/** A pairing request as the owner is shown it, with the moment it arrived. */
const pendingPairingSchema = agentIdentitySchema.extend({
  requestedAt: questionArrivalSchema,
  /**
   * How many connections are waiting on this one card (item 2, 2026-09-24): every session of the
   * agent joins the same card, and without the number a second request looked like nothing at all.
   * Optional because an older worker never counted; the panel then shows no count.
   */
  waitingSessions: z.number().int().min(1).max(1024).optional(),
});

const pairedAgentSchema = z.strictObject({
  agentId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(128),
  origin: z.string().min(1).max(256),
  acceptedAt: z.string().min(1).max(64),
});

/**
 * What a session is doing, as the owner reads it on its card (006 FR-087): working, or waiting on them.
 *
 * 016 FR-230: `idle` joins them - a session with nothing in flight and no question waiting is not
 * working, and a card that said so invited an interrupt into an empty session.
 */
export const AGENT_SESSION_STATES = ["working", "waiting", "idle"] as const;

export type AgentSessionState = (typeof AGENT_SESSION_STATES)[number];

/**
 * The colours sessions are given, in the order they are handed out (016 FR-240, R-205).
 *
 * Chrome's tab-group colour names, so the card's stripe and the session's tab group can be the same
 * colour; red and yellow are left out because they read as warnings. A session keeps its colour for
 * its whole life (`colourIndex % length`), across a worker restart.
 */
export const AGENT_SESSION_COLOURS = ["cyan", "green", "purple", "pink", "orange", "grey", "blue"] as const;

export type AgentSessionColour = (typeof AGENT_SESSION_COLOURS)[number];

/** How many things a session card remembers having happened (008 FR-113, data-model ActivityItem). */
export const AGENT_ACTIVITY_KEPT = 20;

/**
 * One thing that happened, as the session's card lists it (008 FR-113, data-model ActivityItem).
 *
 * The list exists because a dialog is answered in a moment and the owner may be looking elsewhere:
 * every dialog's text appears here whatever the mode decided, so "the agent pressed OK on something
 * while I was away" is a fact they can read afterwards rather than one only the agent knows.
 *
 * The item carries the *pieces*, not a sentence: `site` and `message` are put together by the panel
 * in the owner's own language, as every other string there is. `message` is page-authored text and
 * is the same bounded field `CurrentDialog` carries it in - shown, never interpreted.
 */
export const agentActivityItemSchema = z.strictObject({
  at: z.number().int().nonnegative(),
  /**
   * 012: `viewport` is the emulated size a session gave a tab, and gave back (FR-159).
   * 013: `upload` is a picture the session put into the owner's page (FR-174).
   * 017: `site-plan` is the owner's approval of a session site plan, its replacement, its withdrawal
   * and its end (FR-263); `message` is the number of sites, never the origins themselves.
   */
  kind: z.enum(["dialog", "export", "restore", "viewport", "upload", "interrupt", "site-plan"]),
  outcome: z.enum([
    "accepted",
    "accepted-chained",
    "dismissed",
    "refused",
    "closed-by-owner",
    "stayed",
    "left",
    "exported",
    "restored",
    "set",
    "cleared",
    "delivered",
    /** 014 FR-182: the owner ended a step; one line per press, whatever it was in flight. */
    "interrupted",
    /** 017 FR-263: a session site plan was approved, replaced, withdrawn by the owner, or ended. */
    "approved",
    "replaced",
    "withdrawn",
    "ended",
  ]),
  /** The host the dialog belonged to; absent when the item is not about a page. */
  site: z.string().max(256).optional(),
  /**
   * 012: `"WxH"` for a viewport that was set, and absent for one that was cleared.
   * 013: `"input"` or `"drop"` for an upload - how the page received the picture, which is the one
   * thing that makes the owner's line a different sentence rather than a different word.
   */
  message: z.string().max(4000).optional(),
});

export type AgentActivityItem = z.infer<typeof agentActivityItemSchema>;

/**
 * The one thing the panel says without asking anything (008 FR-114, data-model "Panel messages").
 *
 * A chained accept costs the owner no decision - they approved the click a moment ago - but it is
 * still something that happened to their page, so it is *told* rather than asked. Non-blocking:
 * the card carries no button but a dismiss, and the panel hides it on its own after a few seconds.
 * `action` is the tool the dialog followed, so the notice can say which approval it rode on in the
 * panel's own words rather than in the worker's.
 */
const agentNoticeSchema = z.strictObject({
  at: z.number().int().nonnegative(),
  kind: z.literal("dialog-accepted"),
  dialogText: z.string().max(4000),
  action: agentToolNameSchema,
});

export type AgentNotice = z.infer<typeof agentNoticeSchema>;

const agentSessionViewSchema = z.strictObject({
  sessionId: z.string().min(1).max(128),
  agentId: z.string().min(1).max(128),
  /**
   * The name this session's own greeting carried (006 FR-087). One agent id serves every MCP
   * client on a machine, so the paired record's name is whichever client paired first; the card
   * reads this one and falls back to the paired name only when a projection did not carry it.
   */
  agentName: z.string().min(1).max(128).optional(),
  tabs: z.array(agentTabViewSchema),
  /**
   * The hosts of the tabs it holds, deduped (006 R-127). The card names *sites*, never titles: a
   * title is a word the page chose, and the panel shows nothing a page authored (Constitution VI).
   * Optional because a 004 projection did not carry it; the panel reads an absent list as empty.
   */
  sites: z.array(z.string().min(1).max(256)).optional(),
  /**
   * `waiting` exactly when the pending prompt is this session's; otherwise `working` while a call
   * is in flight and `idle` when none is (016 FR-230). A 0.8.0 worker never sends `idle`.
   */
  state: z.enum(AGENT_SESSION_STATES).optional(),
  /**
   * The folder the session's host reported (016 FR-226, FR-227): remote input, shown as inert text.
   * Absent until a `session-label` frame arrives, and always from a 0.8.0 host.
   */
  label: z.string().min(1).max(64).optional(),
  /** When the worker first saw this session (016 FR-228): written once, kept across re-greetings. */
  startedAt: z.string().min(1).max(64).optional(),
  /** The session's colour, the same one its tab group wears (016 FR-240, R-205). */
  colour: z.enum(AGENT_SESSION_COLOURS).optional(),
  /** Its last greeting or effect, for ordering the cards newest first. */
  lastActivityAt: z.string().min(1).max(64).optional(),
  /**
   * How many of this session's calls the stop registry is holding right now (014 FR-178).
   *
   * The card's 中斷 control is enabled by this and by nothing else: "is there anything to
   * interrupt" is a fact the worker already has, and a button enabled on a guess would let the
   * owner press it into an empty session and be told nothing happened. Optional because a
   * projection from before this slice carried no count, which the panel reads as zero.
   */
  inFlight: z.number().int().nonnegative().optional(),
  /**
   * How the session's recording stands, for the card's own line (008 FR-109, data-model "Panel
   * messages").
   *
   * It rides on the projection rather than arriving as a message of its own: the panel holds one
   * picture and re-renders it, and a second channel for one line of text would be a second source
   * of truth about the same session. `lastExport` is the file the last export wrote - the card
   * names it after the recording itself is gone (FR-108) - and it is a name this extension chose or
   * the agent passed the filename grammar, never a page's word.
   */
  recording: recordingStateSchema.extend({ lastExport: z.string().min(1).max(4096).optional() }).optional(),
  /**
   * What has happened on this session's tabs that the owner may have missed (008 FR-113), newest
   * first and bounded: a card is a card, and a session that answers forty dialogs must not turn it
   * into a log file.
   */
  activity: z.array(agentActivityItemSchema).max(AGENT_ACTIVITY_KEPT).optional(),
  /** The non-blocking thing the panel is telling the owner about this session right now (FR-114). */
  notice: agentNoticeSchema.optional(),
  /**
   * The site plan the owner approved for this session, if any (017 FR-259, R-252). Absent from a
   * 0.9.0 projection and whenever no plan is active.
   */
  sitePlan: z
    .strictObject({ origins: z.array(sitePlanOriginSchema).min(1).max(AGENT_SITE_PLAN_MAX_ORIGINS) })
    .optional(),
});

/**
 * The technical facts the not-connected page folds away (006 FR-082): which relay last greeted
 * this worker, where its record lives, and why the native port last closed - the 004/T169 rings,
 * read for the owner rather than for the gate. Every field is optional because each is a fact the
 * worker may simply not have yet; an empty object is "nothing known", not an error.
 */
const agentBridgeDiagnosticsSchema = z.strictObject({
  relayPid: z.number().int().positive().optional(),
  recordPath: z.string().min(1).max(1024).optional(),
  lastDisconnect: z
    .strictObject({
      at: z.string().min(1).max(64),
      reason: z.string().max(512).optional(),
    })
    .optional(),
});

export type AgentBridgeDiagnostics = z.infer<typeof agentBridgeDiagnosticsSchema>;

/**
 * Everything the panel is told about the agent path, in one projection.
 *
 * One projection rather than several messages because the panel renders one consistent picture:
 * the pending prompt, the paired list and the live sessions are read together, and delivering them
 * separately is how a panel ends up showing an accept button for an agent that has already gone.
 */
/**
 * The live `ask` prompt, as the owner is shown it (FR-042).
 *
 * It carries a *summary* rather than the call's arguments. The panel's job is to let the owner
 * decide, not to interpret a tool call: a projection that carried raw arguments would put page-
 * derived strings and page handles in front of rendering code, and the panel could then act on a
 * handle it was never meant to hold. The label and role are the ones the worker already minted for
 * that target, the same values a 001/002 review card is built from.
 */
export const agentEffectPromptSchema = z.strictObject({
  promptId: z.string().min(1).max(128),
  raisedAt: questionArrivalSchema,
  site: siteOriginSchema,
  tool: agentToolNameSchema,
  /**
   * Which question this is, when the tool name alone would not say (008 FR-114, FR-115).
   *
   * Two of them are about something the page put on the screen rather than about an element: an
   * accept on a dialog, and leaving a page that asked to stay. Both are `dialog` and `navigate`
   * calls whose ordinary sentence ("press OK on…", "go to…") would hide what the owner is actually
   * deciding, so the panel picks its wording from this. Absent for every other prompt, which is
   * every prompt a 004 worker raises.
   */
  /**
   * 014: two more kinds, and the same rule - the tool name would hide what is being decided. A
   * `transition` card is about a tab that has moved, raised by whatever call names that tab next
   * (FR-187); an `upload-directory` card is about the owner's own files, raised by a `file_upload`
   * the host is holding (FR-192).
   */
  kind: z.enum(["dialog-accept", "beforeunload-force", "transition", "upload-directory"]).optional(),
  /**
   * The move the owner is being asked about (014 FR-187): where the tab was, and where it is.
   *
   * Both origins, because both of them are the question - "it was on your bank and is now on
   * somewhere else" is a different decision from "it is on somewhere else". Origins as `siteOfUrl`
   * mints them, never urls: a path is a page's own word, and the decision is about the site.
   */
  transition: z.strictObject({ from: siteOriginSchema, to: siteOriginSchema }).optional(),
  /**
   * The files the host is holding and the directories they are in (014 FR-192).
   *
   * Shown to the owner in full and to nobody else: these are their own file names, they never
   * reach a page, and they are the only thing that makes the decision meaningful - a card saying
   * "a file outside your directories" is a card about nothing in particular. Absolute, because the
   * host resolved them (`absolutePathSchema`).
   */
  files: z
    .array(z.strictObject({ path: absolutePathSchema, directory: absolutePathSchema }))
    .min(1)
    .max(AGENT_UPLOAD_MAX_FILES)
    .optional(),
  /**
   * How a picture would be put into the page (013 tail, FR-196): handed to an input, or dropped at
   * a point. The panel picks one of two sentences from it; absent leaves the generic one.
   */
  delivery: z.enum(["input", "drop"]).optional(),
  /**
   * The dialog's own words, quoted to the owner beneath the question (D-008-5, FR-114).
   *
   * It is the one page-authored string the panel shows, and it is shown as a quotation rather than
   * as part of the sentence: the owner is deciding about text the page wrote, and the card has to
   * carry it for that decision to mean anything.
   */
  dialogText: z.string().max(4000).optional(),
  /** A short, worker-built description of what would happen. Never the arguments themselves. */
  argsSummary: z.string().max(200),
  targetLabel: z.string().max(200).optional(),
  targetRole: z.string().max(100).optional(),
  /**
   * The place a position effect would land, as a picture (004/T139, US7, FR-069).
   *
   * A label and a role are what an effect on a *named element* can be described with; a `computer`
   * call has neither, and the two numbers it does have are not something an owner can decide about.
   * So this one prompt carries a crop of the tab around the point instead - the same worker-minted
   * PNG a screenshot answers with, never page markup or a page-chosen string, so the panel still
   * renders it without interpreting anything the page authored.
   *
   * Present only when the worker actually cropped: a whole-viewport picture labelled with a
   * rectangle it is not would be the one answer that misleads, so the crop is absent instead and
   * the owner decides on the summary, as they do for every other effect.
   */
  targetCrop: z
    .strictObject({
      mimeType: z.literal("image/png"),
      /** Base64, without a data-url prefix - the same encoding `screenshot` answers with. */
      data: z.string().min(1),
      x: z.number().int().nonnegative().max(AGENT_REGION_MAX_PX),
      y: z.number().int().nonnegative().max(AGENT_REGION_MAX_PX),
      width: z.number().int().positive().max(AGENT_REGION_MAX_PX),
      height: z.number().int().positive().max(AGENT_REGION_MAX_PX),
    })
    .optional(),
});

export type AgentEffectPrompt = z.infer<typeof agentEffectPromptSchema>;

/**
 * A whole batch, as the owner is asked about it once (US3 scenario 5, FR-041).
 *
 * This is what "the agent states a plan" means in this feature: on a site the owner set to
 * `follow-a-plan`, a `browser_batch` is projected here as one question, and their yes admits its
 * steps one by one afterwards. Each step is a tool name and the same worker-built summary an `ask`
 * prompt carries - never the arguments, for the same reason: the panel decides nothing about a
 * call, so it is never handed a handle or a page-derived string to interpret.
 */
const agentPlanPromptSchema = z.strictObject({
  planId: z.string().min(1).max(128),
  raisedAt: questionArrivalSchema,
  site: siteOriginSchema,
  steps: z
    .array(
      z.strictObject({
        tool: agentToolNameSchema,
        summary: z.string().max(200),
      }),
    )
    .max(AGENT_BATCH_MAX_STEPS),
});

export type AgentPlanPrompt = z.infer<typeof agentPlanPromptSchema>;

/**
 * A session's proposed site plan, as the owner is asked about it once (017 FR-251, R-247).
 *
 * The proposal's own words - purpose and steps are the agent's text, shown as inert text - and the
 * sites already in the session's active plan, so a replacing proposal can mark them (FR-260).
 */
const agentSitePlanPromptSchema = z.strictObject({
  proposalId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  origins: z.array(sitePlanOriginSchema).min(1).max(AGENT_SITE_PLAN_MAX_ORIGINS),
  purpose: z.string().min(1).max(AGENT_SITE_PLAN_MAX_PURPOSE_CHARS),
  steps: z.array(z.string().min(1).max(AGENT_SITE_PLAN_MAX_STEP_CHARS)).max(AGENT_SITE_PLAN_MAX_STEPS).optional(),
  alreadyApproved: z.array(sitePlanOriginSchema).max(AGENT_SITE_PLAN_MAX_ORIGINS).optional(),
  raisedAt: z.string().min(1).max(64),
});

export type AgentSitePlanPrompt = z.infer<typeof agentSitePlanPromptSchema>;

/**
 * A tab as the *owner* is shown it (004/T109a): the browser's own record of it, and who holds it.
 *
 * The same row the agent is given, minus the one thing that is not a fact from the panel's vantage.
 * `holder` is required and cannot be `this`: the panel is nobody's session, so a row saying "held by
 * this session" could only be one session's list mislabelled as the browser's - which is exactly the
 * state the projection was in before this schema existed, and why the owner never saw a tab held by
 * nobody.
 *
 * No page content, the rule `tabs_context` follows: listing is the one thing that happens without a
 * lease, and it stays that way only while what it carries is the browser's record rather than the
 * document's words.
 */
const agentPanelTabSchema = agentTabViewSchema.extend({
  holder: z.union([
    z.literal("none"),
    z.strictObject({ sessionId: z.string().min(1).max(128) }),
  ]),
});

export type AgentPanelTab = z.infer<typeof agentPanelTabSchema>;

export const agentPanelStateSchema = z.strictObject({
  pending: pendingPairingSchema.optional(),
  paired: z.array(pairedAgentSchema),
  sessions: z.array(agentSessionViewSchema),
  /**
   * Every tab the browser has, with its holder (004/T109a, FR-060).
   *
   * Required rather than optional, for the reason `title` is required on a tab view: an absent list
   * would let the worker answer "I did not look" about the browser it is projecting, and the owner
   * could not tell that from a browser with no tabs. The session lists above stay as they are - they
   * answer "what is this agent working on", and this answers "who has my tabs".
   */
  tabs: z.array(agentPanelTabSchema),
  /** Every site the owner has decided about, so the panel can show and change them (FR-042). */
  sites: z.array(siteModeRecordSchema),
  /** At most one at a time per session: the owner answers one question, not a queue of them. */
  prompt: agentEffectPromptSchema.optional(),
  /** The batch awaiting one answer, on a site the owner set to `follow-a-plan`. */
  plan: agentPlanPromptSchema.optional(),
  /** 017: a session's site-plan proposal awaiting the owner's answer. A 0.9.0 worker never sets it. */
  sitePlan: agentSitePlanPromptSchema.optional(),
  /**
   * 018 FR-268: this browser as the owner sees it - the name in use, the default it falls back to
   * when the owner clears theirs, its kind, and how many other browsers are connected (from the
   * relay's `browser-peers`). Optional: a 0.10.0 worker never sets it, and a worker whose relay has
   * not reported peers yet has nothing honest to say about the others.
   */
  browser: z
    .strictObject({
      name: agentBrowserNameSchema,
      defaultName: agentBrowserNameSchema,
      kind: agentBrowserKindSchema,
      others: z.number().int().nonnegative().max(1_000),
    })
    .optional(),
  /**
   * 018 FR-274: an agent asking to use this browser (prompt kind `browser-choice`). One at a time,
   * as `sitePlan`; the agent's name is its own stated name, shown as inert text.
   */
  browserChoice: z
    .strictObject({
      requestId: z.string().min(1).max(128),
      agentName: z.string().min(1).max(128),
      raisedAt: z.string().min(1).max(64),
    })
    .optional(),
  bridge: agentBridgeStatusSchema,
  /**
   * The paired agent's stated name, for the status row (006 FR-083). It is the first paired
   * agent's display name, lifted out so the panel need not pick one; absent while nothing is paired.
   */
  agentName: z.string().min(1).max(128).optional(),
  /** The bridge's technical facts (006 FR-082). Absent from a 004 projection; never required. */
  diagnostics: agentBridgeDiagnosticsSchema.optional(),
  /**
   * The pairs of origins the owner said "always" to (014 FR-191), for the panel's rows.
   *
   * Ordered pairs: `B→A` is a different record from `A→B`, because "I expect my bank to hand me to
   * this payment site" is not "I expect this payment site to hand me to my bank". `lastUsedAt` is
   * what makes a row reviewable a month later - a pair nothing has used is one the owner can
   * revoke without wondering what it was for.
   */
  transitions: z
    .array(
      z.strictObject({
        from: siteOriginSchema,
        to: siteOriginSchema,
        allowedAt: z.string().min(1).max(64),
        lastUsedAt: z.string().min(1).max(64).optional(),
      }),
    )
    .max(256)
    .optional(),
  /**
   * The directories the host may read uploads from, as the relay last reported them (014 FR-194).
   *
   * Absent rather than empty when the relay is old or has not answered yet: "no directories" and
   * "nobody has told me" are different things to show the owner, and only the first of them means
   * every upload will be asked about.
   */
  uploadRoots: z
    .strictObject({
      roots: z.array(absolutePathSchema).max(256),
      path: absolutePathSchema,
      malformed: z.boolean().optional(),
      /** Where a document the host could not read was kept, for the panel to say (S3 review F4). */
      preserved: z.string().min(1).max(64).optional(),
      /**
       * Directories the owner answered "from now on" about that are not on the list (S3 review F2).
       *
       * The agent is told in a word of its own when a write fails; the owner used to be told
       * nothing at all, and the next upload from the same directory would simply ask again with no
       * hint that their answer had gone nowhere. The worker derives it from the list the host sends
       * back after an answer - the one place both facts meet - and it clears itself the moment a
       * listing does carry the directory.
       */
      notRecorded: z.array(absolutePathSchema).max(16).optional(),
    })
    .optional(),
});

export type AgentPanelState = z.infer<typeof agentPanelStateSchema>;

export const agentPanelMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("worker.agent.state"),
    payload: agentPanelStateSchema,
  }),
]);

export type AgentPanelMessage = z.infer<typeof agentPanelMessageSchema>;

/**
 * The three things the owner can do about an agent. Nothing here can grant a capability, set a
 * site mode, or start a tool: the panel decides who may connect, and never what they may do.
 */
export const agentPanelCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("ui.agent.pair-decide"),
    payload: z.strictObject({
      agentId: z.string().min(1).max(128),
      accepted: z.boolean(),
    }),
  }),
  /**
   * The owner's Ignore on a pairing request (006 FR-084, amended 2026-09-24). It names the agent
   * and nothing else; the worker answers the waiting session with a marked decline of this one
   * request (003 FR-032a), so the agent hears at once and its next call raises a fresh card.
   */
  z.strictObject({
    type: z.literal("ui.agent.pair-ignore"),
    payload: z.strictObject({ agentId: z.string().min(1).max(128) }),
  }),
  z.strictObject({
    type: z.literal("ui.agent.unpair"),
    // The id alone: an unpair that carried a display name could be used to rewrite what the owner
    // is shown about the agent they are removing.
    payload: z.strictObject({ agentId: z.string().min(1).max(128) }),
  }),
  z.strictObject({
    type: z.literal("ui.agent.connect"),
    payload: z.strictObject({}),
  }),
  /**
   * The owner's answer to one `ask` prompt (FR-042, FR-043).
   *
   * `rememberMode` is how FR-042's "set the site's mode from within an ask prompt" is expressed:
   * one decision, optionally standing. It is a mode and only a mode - the diagnostics grant is a
   * separate consent with its own control (US6), and letting it ride along here would grant it from
   * a prompt that never mentioned it.
   */
  z.strictObject({
    type: z.literal("ui.agent.effect-decide"),
    payload: z.strictObject({
      promptId: z.string().min(1).max(128),
      allow: z.boolean(),
      rememberMode: siteModeSchema.optional(),
      /**
       * 014 FR-191: the transition card's "always allow this pair". Its own flag rather than a
       * shared `remember`, because the three cards remember three different things - a site's
       * mode, a pair of origins, a directory on the owner's disk - and one flag would let a yes
       * meant for one of them be read as another. `allow: false` is the decline for all three.
       */
      rememberTransition: z.boolean().optional(),
      /** 014 FR-193: the directory card's "these directories from now on". */
      rememberDirectory: z.boolean().optional(),
    }),
  }),
  /**
   * The owner's one answer to a whole batch under `follow-a-plan` (FR-041, FR-047).
   *
   * `excludedIndexes` is the same shape 002's plan approval had: the owner may strike out steps and
   * approve the rest, so the choice is not "all of this or nothing". A struck-out step is skipped
   * and answered `denied`, never quietly dropped; the steps that remain are what the gate then
   * admits, in order, and nothing else on that site is admitted by this answer.
   */
  z.strictObject({
    type: z.literal("ui.agent.plan-decide"),
    payload: z.strictObject({
      planId: z.string().min(1).max(128),
      approve: z.boolean(),
      excludedIndexes: z
        .array(z.number().int().nonnegative().max(AGENT_BATCH_MAX_STEPS))
        .max(AGENT_BATCH_MAX_STEPS)
        .optional(),
    }),
  }),
  /** The panel's per-site list. The mode, never the diagnostics flag, which has its own command. */
  z.strictObject({
    type: z.literal("ui.agent.site-mode"),
    payload: z.strictObject({
      site: siteOriginSchema,
      mode: siteModeSchema,
    }),
  }),
  /**
   * The owner granting or revoking diagnostics for one site (US6, FR-049).
   *
   * Separate from the mode on purpose, in both directions: a mode command cannot grant diagnostics
   * and this one cannot set a mode. They are different consents - "you may change this site" and
   * "you may attach a debugger to it" - and a single control that did both would let the owner give
   * the wider one while thinking about the narrower.
   *
   * Revoking is the same command with `granted: false`, and it is not merely a flag: the worker
   * detaches the debugger, so Chrome's own "is debugging this browser" bar goes away with it.
   */
  z.strictObject({
    type: z.literal("ui.agent.set-diagnostics"),
    payload: z.strictObject({
      site: siteOriginSchema,
      granted: z.boolean(),
    }),
  }),
  /**
   * The four owner controls of the rebuilt panel (006 R-126). Each names exactly the thing it is
   * about and carries nothing the worker could be steered by: a retry has no options, a clear
   * names a site and not a mode, and a stop or a release names a session and never a call or a tab
   * - the owner stops an agent's work, not one of its calls, and hands back all of its tabs, not one.
   */
  z.strictObject({
    type: z.literal("ui.agent.retry-bridge"),
    payload: z.strictObject({}),
  }),
  /** Forget the owner's stored decision for one site; the default (`ask`) applies from then on. */
  z.strictObject({
    type: z.literal("ui.agent.site-clear"),
    payload: z.strictObject({ site: siteOriginSchema }),
  }),
  /** End one session; its in-flight call, if any, answers `owner-stopped`. */
  z.strictObject({
    type: z.literal("ui.agent.session-stop"),
    payload: z.strictObject({ sessionId: z.string().min(1).max(128) }),
  }),
  /** Hand every tab one session holds back to the owner; the session itself goes on. */
  z.strictObject({
    type: z.literal("ui.agent.session-release"),
    payload: z.strictObject({ sessionId: z.string().min(1).max(128) }),
  }),
  /**
   * End the calls one session has in flight, and nothing else (014 FR-178, FR-179).
   *
   * A session and never a call, exactly as Stop names a session: the card shows an agent's work,
   * not a list of calls, and a control that named one call would be the owner picking among things
   * they were never shown. What separates it from Stop is what it leaves standing - the tabs, the
   * group marking, the leases, the attachment, the emulated viewport, the recording and the site
   * decisions all remain, and the agent may simply call again.
   */
  z.strictObject({
    type: z.literal("ui.agent.session-interrupt"),
    payload: z.strictObject({ sessionId: z.string().min(1).max(128) }),
  }),
  /** Forget one remembered pair of origins (014 FR-191); the next such move asks again. */
  z.strictObject({
    type: z.literal("ui.agent.transition-clear"),
    payload: z.strictObject({ from: siteOriginSchema, to: siteOriginSchema }),
  }),
  /**
   * Forget one upload directory (014 FR-194). Remove only, on this command as on the link frame it
   * becomes: the list grows by the owner's answer on a card and by nothing else.
   */
  z.strictObject({
    type: z.literal("ui.agent.upload-root-clear"),
    payload: z.strictObject({ root: absolutePathSchema }),
  }),
  /**
   * The owner's answer to one site-plan proposal (017 FR-252, R-247). `origins` are the sites left
   * ticked; an approval must keep at least one, and the worker accepts only sites that were in the
   * proposal - the panel cannot add one. Ignored when declining.
   */
  z.strictObject({
    type: z.literal("ui.agent.site-plan-decide"),
    payload: z
      .strictObject({
        proposalId: z.string().min(1).max(128),
        approve: z.boolean(),
        origins: z.array(sitePlanOriginSchema).max(AGENT_SITE_PLAN_MAX_ORIGINS),
      })
      .refine((payload) => !payload.approve || payload.origins.length > 0, {
        message: "an approval keeps at least one site",
        path: ["origins"],
      }),
  }),
  /** End one session's site plan at once (017 FR-259, R-252); the session itself goes on. */
  z.strictObject({
    type: z.literal("ui.agent.site-plan-withdraw"),
    payload: z.strictObject({ sessionId: z.string().min(1).max(128) }),
  }),
  /**
   * The owner naming this browser (018 FR-268). 1-40 characters and nothing else checked here: the
   * worker strips control characters and trims before it stores or sends the name (T501), so what
   * leaves the worker fits `agentBrowserNameSchema`. The name only; the kind is the browser's.
   */
  z.strictObject({
    type: z.literal("ui.agent.browser-rename"),
    payload: z.strictObject({ name: z.string().min(1).max(AGENT_BROWSER_NAME_MAX_CHARS) }),
  }),
  /** The owner's answer on the "Use this browser?" card (018 FR-274): confirm or decline, once. */
  z.strictObject({
    type: z.literal("ui.agent.browser-choice-decide"),
    payload: z.strictObject({ requestId: z.string().min(1).max(128), confirm: z.boolean() }),
  }),
]);

export type AgentPanelCommand = z.infer<typeof agentPanelCommandSchema>;
