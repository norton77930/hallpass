import type {
  ContentEvaluateConditionReply,
  ContentExecutionRefusalReason,
  ContentResolutionReply,
  RuntimeAction,
  TargetVisibility,
  TruncationDimension,
  WaitCondition,
} from "@hallpass/contracts";

/**
 * The ports the worker reaches the page through, and the vocabulary their answers are drawn from -
 * the answers they return and the failures they throw alike.
 *
 * They live here rather than beside the control port that consumes them or the content broker that
 * implements them: the port is the contract between the two, and a backend that is not the default
 * broker must be able to name the same answers without importing the default one. Nothing here
 * imports anything but the protocol contracts, so neither side of the port can pull the other in.
 *
 * The throw side is port-owned for the same reason as the return side. A page backend that cannot
 * carry out an operation raises a `pageFailure`, and the worker classifies it with the classifiers
 * below; neither the vocabulary nor its classification belongs to the default broker, because a
 * worker that had to import the default broker to read another backend's failure would have the
 * dependency this module exists to remove.
 */

/**
 * Which stage of reaching the page gave out. It is what the worker reports as a diagnostic, so it
 * names the stage rather than the user-visible consequence.
 */
export type PageFailureCode =
  | "content.injection"
  | "content.probe"
  | "content.stale-context"
  | "content.invalid-result"
  | "content.collection"
  | "content.evaluation"
  | "content.execution";

/**
 * The failure a page backend throws. `outcomeCode` is what the task channel is told, which is the
 * stage code unless the page is one the extension may not act on at all - `unsupported-page` is a
 * fact about the page rather than about a stage, so it is only ever an outcome.
 */
class PageFailure extends Error {
  constructor(
    readonly code: PageFailureCode,
    readonly outcomeCode: PageFailureCode | "unsupported-page" = code,
  ) {
    super(code);
    this.name = "PageFailure";
  }
}

/**
 * The one failure constructor every page backend raises: the worker classifies a refused operation
 * from this vocabulary, so a stand-in for the default broker names the same failures rather than a
 * string the worker would have to guess at.
 */
export function pageFailure(
  code: PageFailureCode,
  outcomeCode: PageFailureCode | "unsupported-page" = code,
): PageFailure {
  return new PageFailure(code, outcomeCode);
}

/** The stage a failure gave out at, for the diagnostic record. */
export function pageFailureCode(error: unknown): PageFailureCode {
  return error instanceof PageFailure ? error.code : "content.collection";
}

/**
 * What the task channel is told a failure was. One classifier for every port: a backend may also
 * raise `unsupported-page` or `no-active-tab` before it has a binding to fail against - there is no
 * stage to name yet - and both mean the same thing to the worker as the outcome variant does.
 */
export function pageOutcomeCode(error: unknown): PageFailureCode | "unsupported-page" {
  if (error instanceof PageFailure) return error.outcomeCode;
  if (
    error instanceof Error &&
    (error.message === "unsupported-page" || error.message === "no-active-tab")
  ) {
    return "unsupported-page";
  }
  return "content.collection";
}

export type PageCollector = (input: {
  taskId: string;
  operationId: string;
  runtimeEpochId: string;
  /** The worker's identifier for this page binding, repeated on every frame it sends. */
  nonce: string;
  requested: readonly string[];
  generalGrantActive: boolean;
  generalPageReadGrantId: string;
  formGrantActive: boolean;
  formValuesGrantId?: string;
}) => Promise<{
  tabId: number;
  contextHandle: string;
  documentEpoch: string;
  canonicalOrigin: string;
  title?: string;
  selection?: string;
  visibleText?: string;
  truncated?: boolean;
  truncatedDimension?: TruncationDimension;
  formValueItems: unknown[];
  semanticNodes?: unknown[];
}>;

/**
 * Refusals decided on the worker's side of the runtime channel: the leased tab or the binding it
 * cited no longer match, the frame failed the argument schema, or the dispatch fence closed. None of
 * them reached the page. `stale-context` is deliberately the same literal the runtime and the page
 * read use for the same fact, so every port that has to say "this is not the page in front of the
 * user" says it with one word.
 */
export type PageRefusalReason = "stale-context" | "invalid-action-arguments" | "fence-refused";

/**
 * Every refusal an executor may name: the runtime's own closed set plus the port's. A refusal is
 * always one of these, so the worker classifies a refused execution against a named value rather
 * than against a string it has to guess at.
 */
export type PageExecutorRefusal = ContentExecutionRefusalReason | PageRefusalReason;

/**
 * What one execution attempt answers. A refused attempt carries its reason and whether the frame
 * ever reached the page, and nothing else; only an `ok` attempt carries evidence, and which evidence
 * fields it fills is decided per capability by the executor. The arms are a discriminated union so a
 * refusal can never be read as an effect with a missing reason, and `reachedPage` decides on its own
 * whether an operation marker is removed or observed - which is a fact about the frame, not a list
 * of reasons a caller has to keep in step with the port.
 */
export type PageExecutionOutcome =
  | { ok: false; reachedPage: false; reason: PageRefusalReason }
  | { ok: false; reachedPage: true; reason: ContentExecutionRefusalReason }
  | {
      ok: true;
      effect?: string;
      scrollTop?: number;
      clicks?: number;
      charactersChanged?: number;
      valueEchoed?: false;
      /** The key a key press delivered, and whether its target kept focus; false is never success. */
      key?: string;
      focusRetained?: boolean;
      /** A hover's evidence: the target is still shown. False is never success. */
      targetVisible?: boolean;
      /** A drag's evidence: the dragged element's position changed. False is never success. */
      moved?: boolean;
      /** A form input's evidence: the control holds the stated value. False is never success. */
      valueMatched?: boolean;
      /** Observed synchronously by the runtime; a true value is never transmitted as success. */
      documentChanged?: boolean;
      targetVisibility?: TargetVisibility;
    };

export type PageExecutor = (input: {
  taskId: string;
  operationId: string;
  runtimeEpochId: string;
  capability: RuntimeAction;
  arguments: Record<string, unknown>;
  /**
   * Whose policy the page applies (003/US3 decision 3). Absent is `classified`, which is the only
   * value the remote caller of 001/002 has ever meant, and the port's default for the same reason
   * the frame's is: a backend that had to be told would be a backend a caller could forget to tell.
   */
  policy?: "classified" | "trusted-agent";
  documentEpoch: string;
  canonicalOrigin: string;
  /** The worker's identifier for this page binding, repeated on every frame it sends. */
  nonce: string;
  /** The leased tab. Any other active tab is refused before the executor probes or injects. */
  expectedTabId: number;
  /**
   * The worker-owned dispatch fence, re-run by the executor after its own probe and immediately
   * before it sends the effect. A false answer means no effect may start; the executor then reports
   * `cancelled` without touching the page.
   */
  stillAllowed?: () => boolean;
}) => Promise<PageExecutionOutcome>;

/** 002/FR-026: resolves a description against the bound document of the leased tab. */
export type PageResolver = (input: {
  taskId: string;
  operationId: string;
  runtimeEpochId: string;
  nonce: string;
  expectedTabId: number;
  canonicalOrigin: string;
  documentEpoch: string;
  generalPageReadGrantId: string;
  description: string;
  maxCandidates: number;
}) => Promise<ContentResolutionReply | { ok: false; reason: Extract<PageRefusalReason, "stale-context"> }>;

/**
 * 002/FR-027: asks the bound document whether one wait condition holds on one held handle, right
 * now. It is asked once per poll; the polling, the bound, and every decision about when to stop
 * asking are the worker's.
 *
 * It observes the *leased* tab, not the active one. A wait spans seconds and performs no effect, so
 * the user looking at another tab while it runs does not end it - only the bound document going away
 * does. The dependent action step still requires the leased tab to be active, and is refused at
 * dispatch when it is not; that rule belongs to the effect, not to watching.
 *
 * That split is the whole shape of this port. Everything the page can observe lives in the
 * contract's `ok: true` arm - one boolean - because that is all a wait may learn about a document it
 * is only watching. Everything the worker decides, that the bound was reached, that the user pressed
 * Stop, that the binding is gone, has no field here at all: those are facts about the task, not
 * about the page, and a backend that could report them would be reporting on state it does not hold.
 */
export type ConditionEvaluator = (input: {
  taskId: string;
  operationId: string;
  runtimeEpochId: string;
  nonce: string;
  expectedTabId: number;
  canonicalOrigin: string;
  documentEpoch: string;
  generalPageReadGrantId: string;
  targetHandle: string;
  condition: WaitCondition;
}) => Promise<
  ContentEvaluateConditionReply | { ok: false; reason: Extract<PageRefusalReason, "stale-context"> }
>;

/**
 * Post-effect verification: asks the runtime already bound to the leased tab for its current
 * document binding without injecting. Silence or a different epoch means the effect replaced or
 * navigated the document, which is never action success.
 */
export type PagePostEffectProbe = (input: {
  taskId: string;
  operationId: string;
  runtimeEpochId: string;
  nonce: string;
  expectedTabId: number;
  canonicalOrigin: string;
}) => Promise<
  | { ok: true; documentEpoch: string; canonicalOrigin: string }
  /**
   * `document-replaced` and `unsupported-page` are the probe's own: they are answers about the
   * document that replied, not about which page the worker is bound to.
   */
  | {
      ok: false;
      reason: Extract<PageRefusalReason, "stale-context"> | "document-replaced" | "unsupported-page";
    }
>;

export type PageCanceller = (input: {
  taskId: string;
  operationId: string;
  runtimeEpochId: string;
  /** The worker's identifier for this page binding, repeated on every frame it sends. */
  nonce: string;
  /** The leased tab. The cancel goes there, never to whatever tab happens to be active. */
  tabId: number;
  documentEpoch: string;
  canonicalOrigin: string;
}) => Promise<{ cancelled: boolean }>;

export type ActivePageResolver = () => Promise<{ tabId: number; canonicalOrigin: string }>;
