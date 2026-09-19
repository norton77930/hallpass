export const PROTOCOL_VERSION = "1" as const;
export const RUNTIME_PROTOCOL_VERSION = 2 as const;
export const CAPABILITY_PROFILE = "hallpass-v1" as const;
export const SCHEMA_VERSION = "hallpass-v1/protocol-2" as const;

export const DATA_CATEGORIES = [
  "user.request",
  "page.canonical-origin",
  "page.title",
  "page.visible-text",
  "page.structure",
  "page.selection",
  "page.target-metadata",
  "page.form-values",
  "action.text-input",
  "action.observable-result",
] as const;

export type DataCategory = (typeof DATA_CATEGORIES)[number];

export const TERMINAL_OUTCOMES = [
  "success",
  "denial",
  "cancellation",
  "attention-required",
  "failure",
] as const;

export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

/**
 * Why the execution of an approved plan ended (002/FR-022, data model "Run").
 *
 * Closed so the panel can say it in the user's language instead of echoing a code. `completed` is
 * the only reason a run may end with every step observed; each of the others names the first thing
 * that stopped it, and a record keeps only the first.
 */
export const RUN_STOP_REASONS = [
  "completed",
  /**
   * A step committed to dispatch was answered `denied`: its covering grant was revoked between
   * admission and effect, or the content runtime refused it from policy at effect time (a target
   * the read policy withholds, a key the submission guard qualifies), or the approved Plan it
   * belonged to was expired by the user revoking the general page-read grant (002 T064-1). A
   * refusal *before* commit records no reason at all, and a fence refusal surfaces as a stale
   * context, which is `document-changed`.
   */
  "step-not-admitted",
  /**
   * A step committed to dispatch could not be carried out, whether or not it reached the page: no
   * target, a marker write or executor that failed after commit.
   */
  "step-failed",
  /** A step ran and its observable effect could not be verified. */
  "effect-unverified",
  "user-stopped",
  "document-changed",
  /**
   * A wait step reached its bound with its condition still unmet (002/FR-027). Distinct from
   * `step-failed` because nothing failed: the page simply never reached the state the plan was
   * waiting for, and the panel can say exactly that instead of implying a fault.
   */
  "wait-bound-reached",
] as const;

export type RunStopReason = (typeof RUN_STOP_REASONS)[number];

export const CAPABILITY_RESULT_STATUSES = [
  "succeeded",
  "denied",
  "unsupported",
  "inaccessible",
  "stale-context",
  "cancelled",
  "attention-required",
  "failed",
] as const;

export type CapabilityResultStatus = (typeof CAPABILITY_RESULT_STATUSES)[number];

/**
 * The codes an `attention-required` result may carry: the one error-code family that status has.
 *
 * Closed because an effect the user must look at themselves is the one outcome nobody else can
 * settle, and what they are asked to look at differs by cause: a replaced document invalidates every
 * handle minted against it and expires an approved plan, while a lost focus, a target no longer
 * shown, or an element that did not move leave the document and its bindings standing and put only
 * the attribution of that one effect in doubt. `execute-uncertain` is the cause with no observation
 * at all - the executor threw after the effect may have begun - and post-effect verification never
 * returns it.
 */
export const ATTENTION_REQUIRED_CAUSES = [
  /** The effect replaced or navigated the document; bindings to it are dead and a plan expires. */
  "document-changed",
  /** A key press whose target lost focus: delivered, but not to the element that was reviewed. */
  "focus-lost",
  /** A hover whose target is no longer shown. */
  "target-not-visible",
  /** A drag whose element did not change position. */
  "not-moved",
  /**
   * A click family gesture whose delivered point did not resolve to the target it was aimed at
   * (004/T128). Distinct from `target-not-located` (a tool-level failure meaning the element could
   * not be found at all): this means the element *was* found and something else was hit instead -
   * the rect used to place the point did not describe the element it claimed to.
   */
  "target-missed",
  /**
   * A click family gesture whose confirmation could not be asked at all - the round trip that
   * checks the delivered point was refused upstream, in the `stale-context` family (004/T129).
   * Deliberately distinct from `target-missed`: that cause means the check ran and named something
   * else under the point, while this means the check never ran, so nothing is known about whether
   * the point landed. Reporting the two the same way would claim an observation nobody made.
   */
  "target-unconfirmed",
  /** The executor threw after the effect may have begun; nothing observed it either way. */
  "execute-uncertain",
  /**
   * The effect ran and was observed, but the grant that covered it was revoked before its result
   * was submitted: nothing about the page is in doubt, only whether the user still wanted it, so
   * they are told it happened rather than shown a success they had withdrawn consent for.
   */
  "grant-revoked",
] as const;

export type AttentionRequiredCause = (typeof ATTENTION_REQUIRED_CAUSES)[number];

/**
 * Why a wait (002 US6 / FR-027) ended without observing its condition.
 *
 * Cousins of the causes above, defined here so US6 does not grow a second vocabulary for the same
 * kind of answer; `document-changed` is deliberately the same literal, because a wait and an effect
 * mean exactly the same thing by it. R-024 lists an origin change as a fourth ending; it is folded
 * into `document-changed` here, consistently with `onDocumentOrOriginChange`, which is the one
 * signal the worker actually observes for both.
 *
 * R-024's fourth ending, a Stop, is deliberately *not* a member. A Stop halts the task, and the one
 * path that already settles every in-flight run step reports it as `cancelled` under the stop's own
 * reason; a wait that named a `stopped` of its own would be a second name for that same event, and
 * a member no code ever produces (recorded at US6 implementation, T064a review carry-over).
 *
 * A grant revoked mid-wait is absent for the same reason: the user taking back the page-read consent
 * a wait was watching under is answered `denied` / `grant-revoked`, out of the vocabulary a dispatch
 * already uses for exactly that, and the run stops under `step-not-admitted` as it does for an action
 * whose grant was withdrawn. So this set is exactly the endings a wait names *on its own* - the ones
 * with no counterpart anywhere else - and never a second word for an event the task already has one
 * for.
 */
export const WAIT_END_REASONS = ["bound-reached", "document-changed"] as const;

export type WaitEndReason = (typeof WAIT_END_REASONS)[number];

/**
 * What a wait may observe (002/FR-027, R-024). Every member is decidable by the content runtime on
 * one element it already holds a handle for: a wait must not become a way to evaluate an arbitrary
 * expression against the page, so a selector, a URL, and a network condition are deliberately not
 * members and are not expressible under any name.
 */
export const WAIT_CONDITIONS = ["present", "absent", "enabled", "visible-text-changed"] as const;

export type WaitCondition = (typeof WAIT_CONDITIONS)[number];

export const TASK_MODES = [
  "undecided",
  "answer-only",
  "page-read-only",
  "single-action",
  "approved-plan",
] as const;

/**
 * Closed review-time risk labels for one browser effect. They are decided locally from the
 * capability and the bounded target metadata the worker holds; the panel renders reviewed local
 * copy for each. They are never a service-supplied string.
 */
export const ACTION_RISKS = ["view-only", "activation", "text-entry", "unclassified"] as const;

export type ActionRisk = (typeof ACTION_RISKS)[number];

/**
 * Closed target roles a review may project. The page's own role string never reaches the panel:
 * the worker maps it onto this set, and anything it does not recognise becomes `control`.
 */
export const TARGET_ROLES = ["button", "textbox", "combobox", "control", "document"] as const;

export type TargetRole = (typeof TARGET_ROLES)[number];

/**
 * How many files one `file_upload` may carry, and how much base64 the frame holding them may be
 * (003/FR-051).
 *
 * They live here rather than beside the tool because two layers enforce them: the agent contract,
 * and the shared content-runtime message that carries the bytes to the page. The size is the
 * native-messaging frame's own 1 MiB limit less its overhead - a frame past it would not fail
 * politely, it would break the link for every later call.
 */
export const AGENT_UPLOAD_MAX_FILES = 10;

export const AGENT_UPLOAD_MAX_BASE64_CHARS = 700_000;

/**
 * Which controls a collection mints a target handle for (003/FR-040).
 *
 * Closed, and the caller states it: `reviewed` is the 001/002 rule, where a handle exists only
 * where a reviewed remote effect could land, and `all-controls` is the local agent's, where every
 * control the walk sees is nameable. It is a *naming* policy and nothing else - what may then be
 * done to a named element is the executor's separate `policy` decision.
 */
export const TARGET_MINT_POLICIES = ["reviewed", "all-controls"] as const;

export type TargetMintPolicy = (typeof TARGET_MINT_POLICIES)[number];

/**
 * The bounded control kinds the worker keeps for a review (D1). On the wire only a resolution
 * candidate carries one (002/FR-026); the domain's `TargetKind` names the same four values.
 */
export const TARGET_KINDS = ["button", "text-input", "combobox", "other"] as const;

export type TargetKindValue = (typeof TARGET_KINDS)[number];

/**
 * Whether a resolved target is on screen. It moved here from `task-channel.ts` when the archived
 * remote path was removed (009/T245): the content runtime and the agent tools are the two callers
 * left, and both describe a target rather than a channel frame.
 */
export const TARGET_VISIBILITIES = ["visible", "not-visible", "not-applicable"] as const;

export type TargetVisibility = (typeof TARGET_VISIBILITIES)[number];

/**
 * What a live task is waiting on right now. It is worker-decided and locally rendered; the panel
 * never infers it from its own clicks.
 */
export const TASK_LIFECYCLES = [
  "running",
  "awaiting-safety",
  "awaiting-consent",
  "awaiting-plan",
  "executing",
] as const;

export type TaskLifecycle = (typeof TASK_LIFECYCLES)[number];

export const GRANT_LIFETIMES = [
  "current-task",
  "current-task-current-document",
  "one-dispatch",
] as const;

export const SESSION_STORAGE_ALLOWLIST = [
  "sessionId",
  "accessCredential",
  "refreshCredential",
  "expiresAt",
  "accountId",
  "organizationId",
  "authFlowState",
  "operationMarkers",
] as const;

/**
 * The complete field allowlist for a durable operation marker. A marker is a write-ahead risk
 * boundary only: it carries no prompt, URL, origin, target, argument, page content, or result.
 */
export const OPERATION_MARKER_FIELDS = [
  "runtimeEpochId",
  "taskId",
  "requestId",
  "accountId",
  "phase",
  "expiresAt",
] as const;

export const FORM_VALUE_DENIED_REPRESENTATIONS = ["value", "length", "hash", "partial"] as const;

export const FORM_VALUE_WITHHELD_CLASSES = [
  "password",
  "hidden",
  "file",
  "otp",
  "payment",
  "sensitive-autocomplete",
  "product-credential",
  "ambiguous",
] as const;

export const LOG_FORBIDDEN_FIELDS = [
  "Authorization",
  "cookie",
  "body",
  "taskId",
  "channelId",
  "ticket",
  "Origin",
  "canonicalOrigin",
  "formValue",
] as const;

export const ERROR_CODES = [
  "auth.account-mismatch",
  "deployment.adapter-missing",
  "protocol.violation",
  "capability.unsupported",
  "lifecycle-interruption",
] as const;

/**
 * The shape of a reason code: a code, never free text.
 *
 * A reason code is machine-readable — the panel keys reviewed copy off it and the packaged driver
 * reads it from the DOM — so it is a stable lowercase identifier (`plan.document-changed`), not a
 * sentence, an HTTP status line, or an `Error.message` forwarded from wherever the failure arose.
 * Bounding the shape at the frame is what keeps a producer from turning the field into a narrative
 * that would then be rendered, logged, or matched on.
 */
export const REASON_CODE_PATTERN = /^[a-z][a-z0-9.-]*$/;

/** The longest a reason code may be. A code that needs more is a sentence in disguise. */
export const REASON_CODE_MAX_CHARS = 80;
