import {
  contentEvaluateConditionReplySchema,
  contentResolutionReplySchema,
  contentRuntimeMessageSchema,
  DEFAULT_BOUNDS,
  isContentExecutionRefusalReason,
  KEY_PRESS_KEYS,
  PAGE_READ_DATA_CATEGORIES,
  RUNTIME_PROTOCOL_VERSION,
  TARGET_VISIBILITIES,
  TRUNCATION_DIMENSIONS,
  type ContentRuntimeMessage,
  type KeyPressKey,
  type RuntimeAction,
  type ProtocolBounds,
  type TargetMintPolicy,
  type TargetVisibility,
  type TruncationDimension,
  type WaitCondition,
} from "@hallpass/contracts";
import { classifyPageSupport, type PageSupportInput } from "../chrome-adapters/tabs.js";
import { injectContentRuntime } from "../chrome-adapters/scripting.js";
import {
  pageFailure,
  type ConditionEvaluator,
  type PageExecutionOutcome,
  type PageFailureCode,
  type PagePostEffectProbe,
  type PageResolver,
} from "./page-ports.js";

type PageReadCategory = (typeof PAGE_READ_DATA_CATEGORIES)[number];
export type ActivePageBinding = { tabId: number; canonicalOrigin: string; supportInput: PageSupportInput };
type ContentBinding = { tabId: number; documentEpoch: string; canonicalOrigin: string };

/**
 * The worker's identifier for one page binding: 128 bits of local randomness, in the closed hex
 * shape the runtime contract pins. The worker mints it and keeps it for the life of the binding, so
 * every frame of that binding repeats it and a frame from a superseded binding cannot be replayed
 * into a live one. It is deliberately not minted here: the broker is stateless, and a value minted
 * per call could not be repeated by a later call - a cancel in particular, which must reach the page
 * without probing first.
 */
export function mintChannelNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The finite limits the worker hands the page. It is a subset of the protocol bounds, not a
 * translation of them: a mapping with its own field names would be a second representation of the
 * same numbers, free to drift from the ones the worker then re-cuts by.
 */
export type CollectionBounds = Pick<
  ProtocolBounds,
  "maxVisibleTextChars" | "maxSemanticNodes" | "maxLabelChars"
>;

function collectionBounds(bounds: ProtocolBounds): CollectionBounds {
  return {
    maxVisibleTextChars: bounds.maxVisibleTextChars,
    maxSemanticNodes: bounds.maxSemanticNodes,
    maxLabelChars: bounds.maxLabelChars,
  };
}

function isTruncationDimension(value: unknown): value is TruncationDimension {
  return (TRUNCATION_DIMENSIONS as readonly unknown[]).includes(value);
}

function nextMessageId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function contentFrame(input: {
  /** Drawn from the message union itself, so a frame kind the schema does not know cannot be built. */
  type: ContentRuntimeMessage["type"];
  taskId: string;
  operationId: string;
  runtimeEpochId: string;
  nonce: string;
  tabId: number;
  documentEpoch: string;
  /**
   * Effect frames only (003/US3 decision 3). Left off entirely rather than defaulted here, so the
   * schema's own `classified` is the single place the absent value is decided - and so every frame
   * the remote path builds is byte-identical to the one it built before this field existed.
   */
  policy?: "classified" | "trusted-agent";
  payload: Record<string, unknown>;
}): ReturnType<typeof contentRuntimeMessageSchema.parse> {
  return contentRuntimeMessageSchema.parse({
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    messageId: nextMessageId(),
    runtimeEpochId: input.runtimeEpochId,
    type: input.type,
    taskId: input.taskId,
    operationId: input.operationId,
    nonce: input.nonce,
    expectedTabId: input.tabId,
    expectedDocumentEpoch: input.documentEpoch,
    ...(input.policy === undefined ? {} : { policy: input.policy }),
    payload: input.payload,
  });
}

/**
 * A content-script round trip settles only when the page answers. A runtime that accepts the message
 * and then goes silent would otherwise leave the task with no capability result and no terminal, so
 * every page-facing operation carries a finite termination bound.
 *
 * The bound exists to guarantee an outcome, not to promise latency. FR-003 and Constitution XI require
 * termination; the spec's A-010 keeps every numeric limit an explicit product decision.
 *
 * The product owner approved ten seconds on 2026-09-02 (T138). It is deliberately two to three orders
 * of magnitude above a real page round trip so it can only end a hang, never a working page. It is a
 * termination bound for this path only and is not a latency target for anything else.
 */
export const CONTENT_OPERATION_DEADLINE_MS = 10_000;

/**
 * The failures `withDeadline` itself raised (015/T401, FR-206, R-197).
 *
 * A deadline is a different fact from every other way a round trip can fail: the page is still
 * there, its frame simply did not answer in time, and asking again may well work. The failure it
 * raises keeps its existing code - every caller that classifies by code reads it exactly as before -
 * and is remembered here as well, so the one caller that has to tell "did not answer" from "is not
 * there" (`probeActiveTab`) can, without a new failure code in the port vocabulary.
 */
const deadlineFailures = new WeakSet<object>();

function isDeadline(error: unknown): boolean {
  return typeof error === "object" && error !== null && deadlineFailures.has(error);
}

function withDeadline<T>(
  operation: Promise<T>,
  code: PageFailureCode,
  outcomeCode: PageFailureCode | "unsupported-page" = code,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const failure = pageFailure(code, outcomeCode);
      deadlineFailures.add(failure);
      reject(failure);
    }, CONTENT_OPERATION_DEADLINE_MS);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * A frame that took the message and answered nothing (004/T107a).
 *
 * The agent build declares a content script in every frame from `document_start`, so a frame that
 * has no page runtime is still a *receiver*: Chrome resolves `tabs.sendMessage` with `undefined`
 * instead of raising "receiving end does not exist". That silence is the same fact the rejection
 * carried - no runtime is bound in this frame - so it is classified the same way. Anything the
 * runtime did answer, malformed or not, stays a `stale-context` fact about a live runtime.
 */
const NO_CONTENT_RUNTIME = "content-runtime-absent";

function isNoReceiver(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (message === NO_CONTENT_RUNTIME) return true;
  return /receiving end does not exist|could not establish connection|message port closed/i.test(message);
}

/**
 * The origin a probe's answer has to carry.
 *
 * The check is **per document, not per tab** (004/T115). What it catches is a document being
 * replaced under us between the probe and the read, so the origin it compares against is the one
 * *that document* just declared - established by its own probe and then required of that same
 * frame's later answers, which is what `collectFromActiveTab` compares the collection against. The
 * top frame is unchanged: its expected origin is the tab's, because the tab's url *is* the top
 * document's. A child frame is legitimately on another origin - that is the entire reason this
 * slice exists - and a tab-wide comparison would reject it for being exactly what it is.
 */
function parseProbeResult(
  value: unknown,
  /** The tab's origin for the top document; `undefined` for a child frame, which declares its own. */
  expectedOrigin: string | undefined,
): Omit<ContentBinding, "tabId"> {
  if (!value || typeof value !== "object") throw new Error("invalid-content-probe");
  const candidate = value as { documentEpoch?: unknown; canonicalOrigin?: unknown };
  if (typeof candidate.documentEpoch !== "string" || candidate.documentEpoch.length === 0) {
    throw new Error("invalid-content-probe");
  }
  if (
    typeof candidate.canonicalOrigin !== "string" ||
    candidate.canonicalOrigin.length === 0 ||
    (expectedOrigin !== undefined && candidate.canonicalOrigin !== expectedOrigin)
  ) {
    throw new Error("stale-content-origin");
  }
  return { documentEpoch: candidate.documentEpoch, canonicalOrigin: candidate.canonicalOrigin };
}

export async function resolveActiveSupportedPage(): Promise<ActivePageBinding> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return bindSupportedTab(tabs[0]);
}

/** The same support classification for one specific tab, used when the leased tab is already known. */
async function resolveSupportedTab(tabId: number): Promise<ActivePageBinding> {
  return bindSupportedTab(await chrome.tabs.get(tabId));
}

/**
 * The classification of one named tab, for a caller that holds the tab rather than the lease
 * (003/T028).
 *
 * Exported so the agent path can find out whether a tab is a page this extension may act on at all -
 * the answer that becomes `not-actionable` - without duplicating `classifyPageSupport` or the
 * origin derivation beside it. It throws exactly what the internal callers throw, so a restricted
 * page reads the same way whoever asked.
 */
export async function resolveSupportedTabPage(tabId: number): Promise<ActivePageBinding> {
  return resolveSupportedTab(tabId);
}

/**
 * The page one request concerns: the caller's tab if it named one, otherwise the active tab.
 *
 * This is the seam between the two callers (003/R-103). An explicit tab is a *binding*, not an
 * authority: every check that follows - the leased-tab comparison, the origin, the document epoch,
 * the dispatch fence - runs against it exactly as it runs against the active tab, so naming a tab
 * can only ever say which page was meant, never make a refused request succeed. The remote caller
 * of 001/002 names nothing and reaches the active tab as it always has; the local agent names its
 * own tab, because a tab it owns is very often not the one the user is looking at.
 */
async function resolveBoundPage(tab: number | undefined): Promise<ActivePageBinding> {
  return tab === undefined ? resolveActiveSupportedPage() : resolveSupportedTab(tab);
}

function bindSupportedTab(tab: chrome.tabs.Tab | undefined): ActivePageBinding {
  // The committed address, or - while the document has not committed yet - the one the tab is on
  // its way to (004/T165). A tab created a moment ago reads `url: ""` until its document commits,
  // and a PDF's viewer commits late; classifying it on nothing called it absent (`stale`) where the
  // page it was opening was one this extension may not read at all. The probe that follows still
  // asks the document itself, so a pending address can only ever *refuse* a page earlier, never
  // admit one.
  const address = tab?.url || tab?.pendingUrl;
  if (tab?.id === undefined || !address) throw new Error("no-active-tab");
  const url = new URL(address);
  const supportInput: PageSupportInput = {
    protocol: url.protocol,
    hostname: url.hostname,
    pathname: url.pathname,
    incognito: tab.incognito === true,
    isTopFrame: true,
    isPdf: /\.pdf$/i.test(url.pathname),
    isWebStore:
      url.hostname === "chromewebstore.google.com" ||
      (url.hostname === "chrome.google.com" && url.pathname.startsWith("/webstore")),
  };
  if (classifyPageSupport(supportInput) !== "supported") throw new Error("unsupported-page");
  return { tabId: tab.id, canonicalOrigin: url.origin, supportInput };
}

/**
 * Establishes, or re-establishes, the binding with the page. The runtime adopts the worker's nonce,
 * so every later frame of the same binding is recognised and a frame carrying any other nonce is not.
 */
async function probeContentRuntime(
  page: ActivePageBinding,
  input: {
    taskId: string;
    operationId: string;
    runtimeEpochId: string;
    nonce: string;
    /** Which document of the tab; absent is the top one, which is every 003 caller's page. */
    frameId?: number;
  },
): Promise<ContentBinding> {
  const frameId = input.frameId ?? 0;
  const response = await withDeadline(
    chrome.tabs.sendMessage(
    page.tabId,
    contentFrame({
      type: "content.probe",
      taskId: input.taskId,
      operationId: input.operationId,
      runtimeEpochId: input.runtimeEpochId,
      nonce: input.nonce,
      tabId: page.tabId,
      documentEpoch: "probe-unbound",
      payload: {},
    }),
    { frameId },
    ),
    "content.probe",
  );
  if (response === undefined || response === null) throw new Error(NO_CONTENT_RUNTIME);
  return {
    tabId: page.tabId,
    ...parseProbeResult(response, frameId === 0 ? page.canonicalOrigin : undefined),
  };
}

async function ensureContentRuntime(
  page: ActivePageBinding,
  input: {
    taskId: string;
    operationId: string;
    runtimeEpochId: string;
    nonce: string;
    frameId?: number;
  },
): Promise<ContentBinding> {
  try {
    return await probeContentRuntime(page, input);
  } catch (error) {
    if (!isNoReceiver(error)) throw pageFailure("content.probe");
  }
  try {
    // The frame that stayed silent is the one injected, never the whole tab: an all-frames
    // injection would re-run the runtime in the top document, mint a fresh epoch there and fail
    // every in-flight read on the tab as `stale-context` (004/T115).
    await withDeadline(injectContentRuntime(page.tabId, input.frameId ?? 0), "content.injection");
  } catch {
    throw pageFailure("content.injection");
  }
  try {
    return await probeContentRuntime(page, input);
  } catch {
    throw pageFailure("content.probe");
  }
}

export function preInjectionDecision(input: PageSupportInput): {
  inject: boolean;
  support: ReturnType<typeof classifyPageSupport>;
} {
  const support = classifyPageSupport(input);
  return { inject: support === "supported", support };
}

export async function injectIfSupported(tabId: number, input: PageSupportInput): Promise<{ injected: boolean }> {
  const decision = preInjectionDecision(input);
  if (!decision.inject) return { injected: false };
  await withDeadline(injectContentRuntime(tabId), "content.injection");
  return { injected: true };
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function sanitizeFormValueItems(
  value: unknown,
  formGrantActive: boolean,
  bounds: ProtocolBounds,
): unknown[] {
  if (!formGrantActive) return [];
  if (!Array.isArray(value)) throw new Error("invalid-content-result");
  return value.slice(0, bounds.maxFormValueItems).map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("invalid-content-result");
    const item = raw as Record<string, unknown>;
    const controlId = boundedString(item.controlId, 256);
    const controlKind = boundedString(item.controlKind, 32);
    if (!controlId || !controlKind) throw new Error("invalid-content-result");
    if (item.classification === "allowed-ordinary") {
      const valueText = boundedString(item.value, bounds.maxTextEntryChars);
      const selectedOptionLabels = Array.isArray(item.selectedOptionLabels)
        ? item.selectedOptionLabels
            .slice(0, bounds.maxFormValueItems)
            .map((label) => boundedString(label, bounds.maxLabelChars))
            .filter((label): label is string => label !== undefined)
        : undefined;
      return {
        controlId,
        controlKind,
        classification: "allowed-ordinary",
        ...(valueText !== undefined ? { value: valueText } : {}),
        ...(selectedOptionLabels !== undefined ? { selectedOptionLabels } : {}),
      };
    }
    if (item.classification === "withheld-sensitive" || item.classification === "withheld-ambiguous") {
      return { controlId, controlKind, classification: item.classification };
    }
    throw new Error("invalid-content-result");
  });
}

/**
 * A node's box in its own frame's viewport, as four finite numbers and nothing else.
 *
 * Projected the same way every other value from the page is: the shape is rebuilt here from
 * numbers the worker checked, so a page cannot send a "rect" that is anything but one.
 */
function sanitizeRect(value: unknown): { rect: { x: number; y: number; width: number; height: number } } | Record<string, never> {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const box = ["x", "y", "width", "height"].map((key) => raw[key]);
  if (!box.every((side): side is number => typeof side === "number" && Number.isFinite(side))) return {};
  const [x, y, width, height] = box as number[];
  return { rect: { x: x!, y: y!, width: width!, height: height! } };
}

/**
 * The fields an agent chooses on, bounded (004/FR-067, R-116).
 *
 * A destination is a url the *browser* resolved, kept whole up to the contract's bound because a
 * truncated address is worse than none - an agent would read the prefix as the target. The rest are
 * label-length strings, and the option list is bounded in both directions: how many, and how long
 * each one may be.
 */
function sanitizeNodeFields(node: Record<string, unknown>, bounds: ProtocolBounds): Record<string, unknown> {
  const href = boundedString(node.href, 2048);
  const type = boundedString(node.type, 64);
  const placeholder = boundedString(node.placeholder, bounds.maxLabelChars);
  const options = Array.isArray(node.options)
    ? node.options
        .slice(0, 200)
        .map((option) => boundedString(option, bounds.maxLabelChars))
        .filter((option): option is string => option !== undefined)
    : undefined;
  // 005/FR-072..FR-074: what the control holds. `redacted` wins over any value the page might
  // have sent beside it, and a toggle's `checked` wins the same way, so the shape the contract
  // refuses (a value beside either) cannot be built here whatever the page said.
  const redacted = node.redacted === true;
  const checked = typeof node.checked === "boolean" ? node.checked : undefined;
  const value = redacted || checked !== undefined ? undefined : boundedString(node.value, bounds.maxLabelChars);
  return {
    ...(href ? { href } : {}),
    ...(type ? { type } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(options && options.length > 0 ? { options } : {}),
    ...(value ? { value } : {}),
    ...(value && node.valueTruncated === true ? { valueTruncated: true } : {}),
    ...(checked === undefined ? {} : { checked }),
    ...(redacted ? { redacted: true } : {}),
  };
}

function sanitizeSemanticNodes(
  value: unknown,
  includeTargets: boolean,
  bounds: ProtocolBounds,
  /**
   * Whether the caller asked for each node's nesting depth (003/FR-037).
   *
   * Off by default, and the remote path never turns it on, so the frames the archived 001/002
   * channel sends are exactly the shape its closed `semanticNodeSchema` declares. The collector
   * computes the depth either way - it is a fact about the DOM - and this is where it is either
   * projected or dropped.
   */
  includeDepth = false,
  /** Whether a node the page is not showing should say so (003/C2). Off for the remote path. */
  includeVisibility = false,
  /**
   * Whether the two facts a page-wide merge is spliced on survive the projection (004/T115).
   *
   * `frameOwner` marks the element that holds a child document and `rect` is that element's place
   * in its *own* frame's viewport. Both are dropped by default - the remote path's closed schema
   * has no room for them, and no 003 caller has anything to do with them - so they travel only for
   * the caller that is assembling one page out of several documents.
   */
  includeFrameFacts = false,
  /**
   * Whether the node keeps the facts an agent chooses on (004/FR-067): a link's destination, a
   * control's type and placeholder, a select's options.
   *
   * Off by default and never on for the remote path, whose closed `semanticNodeSchema` has no room
   * for them. Each is bounded here the same way a label is - they are page-authored strings, and
   * the length a page may spend in the agent's context is the worker's to decide, not the page's.
   */
  includeFields = false,
): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, bounds.maxSemanticNodes).flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const node = raw as Record<string, unknown>;
    const role = boundedString(node.role, 100);
    if (!role) return [];
    const label = boundedString(node.label, bounds.maxLabelChars);
    const text = boundedString(node.text, bounds.maxNarrativeChars);
    const targetHandle = includeTargets ? boundedString(node.targetHandle, 256) : undefined;
    const depth =
      includeDepth && typeof node.depth === "number" && Number.isInteger(node.depth) && node.depth >= 0
        ? Math.min(node.depth, 64)
        : undefined;
    return [{
      role,
      ...(label ? { label } : {}),
      ...(text ? { text } : {}),
      ...(targetHandle ? { targetHandle } : {}),
      ...(includeVisibility && node.hidden === true ? { hidden: true } : {}),
      // 004/FR-067: rendered, but not on the screen right now. It travels with the visibility
      // facts because it answers the same question for the caller - may this be acted on now -
      // and is a separate field because it is a different reason for the same answer.
      ...(includeVisibility && node.offscreen === true ? { offscreen: true } : {}),
      ...(depth === undefined ? {} : { depth }),
      ...(includeFrameFacts && node.frameOwner === true ? { frameOwner: true } : {}),
      ...(includeFrameFacts ? sanitizeRect(node.rect) : {}),
      ...(includeFields ? sanitizeNodeFields(node, bounds) : {}),
    }];
  });
}

export async function collectFromActiveTab(input: {
  taskId: string;
  operationId: string;
  runtimeEpochId: string;
  /** The worker's identifier for this page binding; every frame of it repeats this value. */
  nonce: string;
  requested: readonly string[];
  generalGrantActive: boolean;
  generalPageReadGrantId: string;
  formGrantActive: boolean;
  formValuesGrantId?: string;
  /** Deployment-injected limits; the page is told what they are rather than choosing its own. */
  bounds?: ProtocolBounds;
  /**
   * When set, the page is this tab, whether or not it is active; when absent, the active tab of the
   * current window - the remote caller's binding.
   */
  tab?: number;
  /**
   * Which document of that tab (004/T115, US4). Absent is the top frame, which is the only document
   * a 003 read could see; a merge names each frame the browser enumerated in turn, and the probe,
   * the injection and the collection all go to that one frame.
   */
  frameId?: number;
  /**
   * Roots the structural part of the collection at one handle this document minted (003/FR-037).
   * Absent is the whole document, which is what the remote path always asks for.
   */
  rootTargetHandle?: string;
  /**
   * Brings `rootTargetHandle`'s own element on screen before its rect is measured (004/T128, B67 G5
   * correction). Set only by the locator that is about to deliver a coordinate there
   * (`agent-tools/effects.ts`'s `locateInFrame`); every reader leaves it unset.
   */
  scrollIntoView?: boolean;
  /** Whether each node should carry its nesting depth. Off for the remote path, on for `read_page`. */
  includeDepth?: boolean;
  /**
   * Whether each node should say that nobody can see it (003/C2).
   *
   * Off for the remote path, whose frames stay exactly the shape its closed schema declares. The
   * agent's `read_page` turns it on: it names every control the page has, including the ones a page
   * has hidden until later, and the caller has to be able to tell those apart from the ones it can
   * act on now.
   */
  includeVisibility?: boolean;
  /**
   * Which controls the page mints a handle for (003/FR-040, B1). Absent is `reviewed`, the rule the
   * remote path has always collected under; the agent's tools ask for `all-controls` by name.
   */
  mintPolicy?: TargetMintPolicy;
  /** Whether `frameOwner` and `rect` survive the projection (004/T115); off for every 003 caller. */
  includeFrameFacts?: boolean;
  /**
   * Whether each node carries `href`, `type`, `placeholder` and a select's `options` (004/FR-067),
   * and what the control holds - `value`, `checked`, `redacted`, `valueTruncated` (005/FR-072).
   */
  includeFields?: boolean;
}): Promise<{
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
  /** 004/T136: `rootTargetHandle` named an entry this document had bound whose element is gone. */
  rootTargetGone?: boolean;
  semanticNodes?: unknown[];
}> {
  if (!input.generalGrantActive || input.generalPageReadGrantId.length === 0) {
    throw new Error("general-grant-inactive");
  }
  if (input.formGrantActive && !input.formValuesGrantId) throw new Error("form-grant-missing");
  const requested = input.requested.filter((item): item is PageReadCategory =>
    (PAGE_READ_DATA_CATEGORIES as readonly string[]).includes(item),
  );
  if (requested.length === 0 || requested.length !== input.requested.length) {
    throw new Error("invalid-page-read-categories");
  }
  const bounds = input.bounds ?? DEFAULT_BOUNDS;
  const page = await resolveBoundPage(input.tab);
  const binding = await ensureContentRuntime(page, input);
  let collected: {
    ok?: unknown;
    reason?: unknown;
    contextHandle?: unknown;
    documentEpoch?: unknown;
    canonicalOrigin?: unknown;
    visibleText?: string;
    truncated?: boolean;
    truncatedDimension?: unknown;
    formValueItems?: unknown[];
    rootTargetGone?: unknown;
    semanticNodes?: unknown[];
  };
  try {
    collected = (await withDeadline(
      chrome.tabs.sendMessage(
      page.tabId,
      contentFrame({
        type: "content.collect-page",
        taskId: input.taskId,
        operationId: input.operationId,
        runtimeEpochId: input.runtimeEpochId,
        nonce: input.nonce,
        tabId: page.tabId,
        documentEpoch: binding.documentEpoch,
        payload: {
          generalPageReadGrantId: input.generalPageReadGrantId,
          ...(input.formGrantActive && input.formValuesGrantId
            ? { formValuesGrantId: input.formValuesGrantId }
            : {}),
          requestedDataCategories: requested,
          bounds: collectionBounds(bounds),
          ...(input.rootTargetHandle === undefined ? {} : { rootTargetHandle: input.rootTargetHandle }),
          ...(input.mintPolicy === undefined ? {} : { mintPolicy: input.mintPolicy }),
          ...(input.scrollIntoView === undefined ? {} : { scrollIntoView: input.scrollIntoView }),
        },
      }),
      { frameId: input.frameId ?? 0 },
      ),
      "content.collection",
    )) as typeof collected;
  } catch {
    throw pageFailure("content.collection");
  }
  if (collected.ok === false && collected.reason === "unsupported-page") {
    throw pageFailure("content.collection", "unsupported-page");
  }
  if (
    collected.documentEpoch !== binding.documentEpoch ||
    collected.canonicalOrigin !== binding.canonicalOrigin
  ) {
    throw pageFailure("content.stale-context");
  }
  if (typeof collected.contextHandle !== "string" || !Array.isArray(collected.formValueItems)) {
    throw pageFailure("content.invalid-result");
  }
  const visibleText = input.requested.includes("page.visible-text")
    ? boundedString(collected.visibleText, bounds.maxVisibleTextChars)
    : undefined;
  const title = input.requested.includes("page.title")
    ? boundedString((collected as Record<string, unknown>).title, bounds.maxNarrativeChars)
    : undefined;
  const selection = input.requested.includes("page.selection")
    ? boundedString((collected as Record<string, unknown>).selection, bounds.maxNarrativeChars)
    : undefined;
  const includeStructure =
    input.requested.includes("page.structure") || input.requested.includes("page.target-metadata");
  const semanticNodes = includeStructure
    ? sanitizeSemanticNodes(
        collected.semanticNodes,
        input.requested.includes("page.target-metadata"),
        bounds,
        input.includeDepth === true,
        input.includeVisibility === true,
        input.includeFrameFacts === true,
        input.includeFields === true,
      )
    : undefined;
  const truncatedDimension = isTruncationDimension(collected.truncatedDimension)
    ? collected.truncatedDimension
    : undefined;
  try {
    return {
      tabId: binding.tabId,
      contextHandle: collected.contextHandle,
      documentEpoch: binding.documentEpoch,
      canonicalOrigin: binding.canonicalOrigin,
      ...(visibleText !== undefined ? { visibleText } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(selection !== undefined ? { selection } : {}),
      ...(collected.truncated !== undefined ? { truncated: collected.truncated === true } : {}),
      ...(truncatedDimension !== undefined ? { truncatedDimension } : {}),
      formValueItems: sanitizeFormValueItems(
        collected.formValueItems,
        input.formGrantActive,
        bounds,
      ),
      ...(collected.rootTargetGone === true ? { rootTargetGone: true } : {}),
      ...(semanticNodes !== undefined ? { semanticNodes } : {}),
    };
  } catch {
    throw pageFailure("content.invalid-result");
  }
}

/**
 * 002/FR-026: resolves a description on the leased tab's bound document. The reply is held to
 * exactly the three outcomes and to review-card metadata per candidate; anything else from the page
 * is an invalid result, never forwarded.
 */
export async function resolveOnActiveTab(input: {
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
  bounds?: ProtocolBounds;
  /**
   * When set, the page is this tab, whether or not it is active; when absent, the active tab of the
   * current window - the remote caller's binding.
   */
  tab?: number;
  /**
   * Which document of that tab (004/T115, US4). Absent is the top frame, the only document a 003
   * find could see; `find` names each frame the browser enumerated in turn.
   */
  frameId?: number;
  /**
   * The origin required of *this frame's* answers, when it is not the tab's.
   *
   * The check is per document, as the collection's is: what it catches is a document being
   * replaced under us between the probe and the resolution, and a cross-origin child never had the
   * tab's origin and never will. The caller supplies the origin the frame declared at the
   * collection that minted the handles, so this frame's resolution has to come from that same
   * document. Absent is the tab's origin, which is the top document's.
   */
  frameOrigin?: string;
}): ReturnType<PageResolver> {
  const bounds = input.bounds ?? DEFAULT_BOUNDS;
  const page = await resolveBoundPage(input.tab);
  if (page.tabId !== input.expectedTabId || page.canonicalOrigin !== input.canonicalOrigin) {
    return { ok: false, reason: "stale-context" };
  }
  const expectedOrigin = input.frameOrigin ?? input.canonicalOrigin;
  const binding = await ensureContentRuntime(page, input);
  if (binding.documentEpoch !== input.documentEpoch || binding.canonicalOrigin !== expectedOrigin) {
    return { ok: false, reason: "stale-context" };
  }
  const raw = (await withDeadline(
    chrome.tabs.sendMessage(
      page.tabId,
      contentFrame({
        type: "content.resolve-target",
        taskId: input.taskId,
        operationId: input.operationId,
        runtimeEpochId: input.runtimeEpochId,
        nonce: input.nonce,
        tabId: page.tabId,
        documentEpoch: binding.documentEpoch,
        payload: {
          generalPageReadGrantId: input.generalPageReadGrantId,
          description: input.description,
          maxCandidates: input.maxCandidates,
        },
      }),
      { frameId: input.frameId ?? 0 },
    ),
    "content.collection",
  )) as Record<string, unknown> | undefined;
  if (raw?.ok === false) {
    if (raw.reason === "stale-context" || raw.reason === "stale-binding") return { ok: false, reason: "stale-context" };
    throw pageFailure("content.invalid-result");
  }
  // The reply is admitted by the contract that declares it, so "a handle and nothing else" is one
  // rule in one place: a candidate carrying any other field is a page trying to say more than it
  // may, and the answer is no.
  const reply = contentResolutionReplySchema.safeParse(raw);
  if (!reply.success) throw pageFailure("content.invalid-result");
  // The worker's bound for this request, never above the protocol's.
  const maxCandidates = Math.min(input.maxCandidates, bounds.maxResolutionCandidates);
  if (reply.data.outcome === "resolved" && reply.data.candidates.length > maxCandidates) {
    throw pageFailure("content.invalid-result");
  }
  return reply.data;
}

/**
 * 003/US3 decision 2: mints a ref for what is at a viewport point, or for whatever has focus.
 *
 * Both are the same round trip as a description resolution and answer in the same shape, because
 * both are the same act: turning something the caller can name into a handle the registry owns. The
 * binding checks in front of them are the resolution's, unchanged - a point on a tab that is not the
 * one bound, or on a document that has moved on, resolves nothing rather than something else.
 */
export async function resolveHandleOnTab(input: {
  taskId: string;
  operationId: string;
  runtimeEpochId: string;
  nonce: string;
  expectedTabId: number;
  canonicalOrigin: string;
  documentEpoch: string;
  generalPageReadGrantId: string;
  /** A viewport point, or the focused element when absent. */
  point?: { x: number; y: number };
  /**
   * The ref this point is confirming (004/T128 gap 1). Only meaningful alongside `point`; carried
   * through to `content.resolve-point` unchanged.
   */
  targetHandle?: string;
  /**
   * Which document of the tab to ask (004/T128 gap 2). Absent is the top frame - the same default
   * every resolution here has had - because a point is only ever in a frame's own document, the
   * same way a description resolution already names a frame (`resolveOnActiveTab`).
   */
  frameId?: number;
  tab?: number;
  /**
   * The origin required of *this frame's* answers, when it is not the tab's (004/T129, B71).
   *
   * Mirrors `resolveOnActiveTab`'s `frameOrigin`, for the same reason: the check is per document,
   * and a cross-origin child never had the tab's origin and never will. Without this, confirmation
   * always compared a frame's own origin against the top tab's, which is structural for any
   * genuinely cross-origin frame - not a staleness this document ever recovers from - so a click
   * that landed inside such a frame always answered `stale-context`. Absent is the tab's origin,
   * which is the top document's, unchanged.
   */
  frameOrigin?: string;
}): ReturnType<PageResolver> {
  const page = await resolveBoundPage(input.tab);
  if (page.tabId !== input.expectedTabId || page.canonicalOrigin !== input.canonicalOrigin) {
    return { ok: false, reason: "stale-context" };
  }
  const expectedOrigin = input.frameOrigin ?? input.canonicalOrigin;
  const binding = await ensureContentRuntime(page, input);
  if (binding.documentEpoch !== input.documentEpoch || binding.canonicalOrigin !== expectedOrigin) {
    return { ok: false, reason: "stale-context" };
  }
  const raw = (await withDeadline(
    chrome.tabs.sendMessage(
      page.tabId,
      contentFrame({
        type: input.point ? "content.resolve-point" : "content.resolve-active-element",
        taskId: input.taskId,
        operationId: input.operationId,
        runtimeEpochId: input.runtimeEpochId,
        nonce: input.nonce,
        tabId: page.tabId,
        documentEpoch: binding.documentEpoch,
        payload: {
          generalPageReadGrantId: input.generalPageReadGrantId,
          ...(input.point ? { x: input.point.x, y: input.point.y } : {}),
          ...(input.point && input.targetHandle !== undefined ? { targetHandle: input.targetHandle } : {}),
        },
      }),
      { frameId: input.frameId ?? 0 },
    ),
    "content.collection",
  )) as Record<string, unknown> | undefined;
  if (raw?.ok === false) {
    if (raw.reason === "stale-context" || raw.reason === "stale-binding") return { ok: false, reason: "stale-context" };
    // 004/T168: the ref a point confirmation named has left the document since the delivery - the
    // page's own answer to "was it hit" is that there is nothing left to hit-test. Not a miss and
    // not an invalid reply: the same "the check could not be made" the confirmer already reads
    // `ok: false` as, so it answers `unconfirmed` rather than `target-missed` for a click that landed.
    if (raw.reason === "stale-target" && input.targetHandle !== undefined) return { ok: false, reason: "stale-context" };
    throw pageFailure("content.invalid-result");
  }
  const reply = contentResolutionReplySchema.safeParse(raw);
  if (!reply.success) throw pageFailure("content.invalid-result");
  return reply.data;
}

/**
 * 003/FR-051: hands one file input the bytes the host was allowed to read.
 *
 * The same binding checks a resolution makes, for the same reason: the bytes are meant for one
 * element of one document, and a tab that has moved on is a different page that would receive them.
 * Nothing about a path travels through here - the worker never had one - and what comes back is
 * what the input is holding, which is the evidence the tool answers with.
 */
export async function setFilesOnTab(input: {
  taskId: string;
  operationId: string;
  runtimeEpochId: string;
  nonce: string;
  expectedTabId: number;
  canonicalOrigin: string;
  documentEpoch: string;
  targetHandle: string;
  files: ReadonlyArray<{ name: string; type: string; bytesBase64: string }>;
  tab?: number;
  /**
   * Which document of the tab holds the file input (004/T160). Absent is the top frame, unchanged
   * from every caller before this slice - a ref a nested frame minted needs its own frame named, the
   * same way `resolveHandleOnTab` already names one for a point.
   */
  frameId?: number;
  /** The origin required of *this frame's* answer, mirroring `resolveHandleOnTab`'s `frameOrigin`. */
  frameOrigin?: string;
}): Promise<
  | { ok: true; files: Array<{ name: string; size: number }> }
  | { ok: false; reason: string }
> {
  const page = await resolveBoundPage(input.tab);
  if (page.tabId !== input.expectedTabId || page.canonicalOrigin !== input.canonicalOrigin) {
    return { ok: false, reason: "stale-context" };
  }
  const expectedOrigin = input.frameOrigin ?? input.canonicalOrigin;
  const binding = await ensureContentRuntime(page, input);
  if (binding.documentEpoch !== input.documentEpoch || binding.canonicalOrigin !== expectedOrigin) {
    return { ok: false, reason: "stale-context" };
  }
  const raw = (await withDeadline(
    chrome.tabs.sendMessage(
      page.tabId,
      contentFrame({
        type: "content.set-files",
        taskId: input.taskId,
        operationId: input.operationId,
        runtimeEpochId: input.runtimeEpochId,
        nonce: input.nonce,
        tabId: page.tabId,
        documentEpoch: binding.documentEpoch,
        payload: { targetHandle: input.targetHandle, files: input.files },
      }),
      { frameId: input.frameId ?? 0 },
    ),
    "content.execution",
  )) as Record<string, unknown> | undefined;
  if (raw?.ok !== true) {
    const reason = typeof raw?.reason === "string" ? raw.reason : "invalid-result";
    return { ok: false, reason };
  }
  const files = Array.isArray(raw.files) ? raw.files : [];
  return {
    ok: true,
    files: files.flatMap((entry) => {
      const file = entry as { name?: unknown; size?: unknown };
      // Bounded here as well as in the page: what the page reports is still page-derived, and the
      // agent is handed a name and a number rather than whatever the element said.
      return typeof file.name === "string" && typeof file.size === "number"
        ? [{ name: boundedString(file.name, 255) ?? "", size: Math.max(0, Math.floor(file.size)) }]
        : [];
    }),
  };
}

/**
 * 013/FR-170: hands one place on the page a picture this session took.
 *
 * `setFilesOnTab`'s port with one more target. The binding checks are the same and for the same
 * reason - the picture is meant for one document, and a tab that has moved on is a different page
 * that would receive it - and the reply is bounded here as well as in the page, because what comes
 * back from a delivery is still page-derived.
 *
 * A point goes to the top frame, which does its own one-level descent into a frame it can read
 * (`deliverImage`); a handle goes to the frame that minted it, which the caller has already found.
 */
export async function deliverImageOnTab(input: {
  taskId: string;
  operationId: string;
  runtimeEpochId: string;
  nonce: string;
  expectedTabId: number;
  canonicalOrigin: string;
  documentEpoch: string;
  target: { handle: string } | { point: { x: number; y: number } };
  file: { name: string; type: string; bytesBase64: string };
  tab?: number;
  /** Which document of the tab the delivery is for; absent is the top frame, as everywhere else. */
  frameId?: number;
  /** The origin required of *this frame's* answer, mirroring `setFilesOnTab`'s `frameOrigin`. */
  frameOrigin?: string;
}): Promise<
  | {
      ok: true;
      delivery: "input" | "drop";
      file: { name: string; size: number };
      point?: { x: number; y: number };
    }
  | { ok: false; reason: string }
> {
  const page = await resolveBoundPage(input.tab);
  if (page.tabId !== input.expectedTabId || page.canonicalOrigin !== input.canonicalOrigin) {
    return { ok: false, reason: "stale-context" };
  }
  const expectedOrigin = input.frameOrigin ?? input.canonicalOrigin;
  const binding = await ensureContentRuntime(page, input);
  if (binding.documentEpoch !== input.documentEpoch || binding.canonicalOrigin !== expectedOrigin) {
    return { ok: false, reason: "stale-context" };
  }
  const raw = (await withDeadline(
    chrome.tabs.sendMessage(
      page.tabId,
      contentFrame({
        type: "content.deliver-image",
        taskId: input.taskId,
        operationId: input.operationId,
        runtimeEpochId: input.runtimeEpochId,
        nonce: input.nonce,
        tabId: page.tabId,
        documentEpoch: binding.documentEpoch,
        payload: { target: input.target, file: input.file },
      }),
      { frameId: input.frameId ?? 0 },
    ),
    "content.execution",
  )) as Record<string, unknown> | undefined;
  if (raw?.ok !== true) {
    const reason = typeof raw?.reason === "string" ? raw.reason : "invalid-result";
    // The one refusal that carries a fact with it: how big the page's own viewport is, so the agent
    // can name a point that is on it. Said in the reason rather than beside it, because that is what
    // the tool answers with.
    const frame = raw?.frame as { width?: unknown; height?: unknown } | undefined;
    if (reason === "point-outside-viewport" && typeof frame?.width === "number" && typeof frame.height === "number") {
      return {
        ok: false,
        reason: `point-outside-viewport (frame ${Math.max(0, Math.floor(frame.width))}x${Math.max(0, Math.floor(frame.height))})`,
      };
    }
    return { ok: false, reason };
  }
  const delivery = raw.delivery === "input" || raw.delivery === "drop" ? raw.delivery : undefined;
  const file = raw.file as { name?: unknown; size?: unknown } | undefined;
  if (delivery === undefined || typeof file?.name !== "string" || typeof file.size !== "number") {
    return { ok: false, reason: "invalid-result" };
  }
  const point = raw.point as { x?: unknown; y?: unknown } | undefined;
  return {
    ok: true,
    delivery,
    file: { name: boundedString(file.name, 255) ?? "", size: Math.max(0, Math.floor(file.size)) },
    ...(typeof point?.x === "number" && Number.isFinite(point.x) && typeof point.y === "number" && Number.isFinite(point.y)
      ? { point: { x: point.x, y: point.y } }
      : {}),
  };
}

/**
 * 002/FR-027: asks the leased tab's bound document whether one wait condition holds. One round trip
 * per poll, with the same binding checks a resolution makes before it speaks to the page at all.
 * The reply is admitted by the contract that declares it, so an answer carrying anything besides the
 * boolean is an invalid result rather than something the worker has to decide what to do with.
 *
 * The question goes to the leased tab, never to whatever tab is active now - the same rule a cancel
 * follows, and for the same reason: the document being watched lives there even after the user has
 * switched tabs. A wait touches nothing, so it has no business ending because of where the user is
 * looking; the effect the plan runs afterwards is still refused unless the leased tab is active. A
 * leased tab that is gone, or that no longer shows the task origin, has no document left to watch,
 * which is `stale-context` - the same word every other port uses for that fact.
 *
 * **The identity a frame's answer is checked against is that frame's own (004/T155, extended by
 * T160).** `frameId`, `documentEpoch` and `frameOrigin` belong to the document that claimed the ref -
 * comparing a nested frame's reply against the binding's own epoch or origin is not a staleness
 * check, it is asking the wrong document and reporting its mismatch as one. This rule was written
 * once, in `effects.ts`'s confirmers, and every caller here that accepts an optional `frameId` has to
 * accept `frameOrigin` beside it and diff the frame's own probed epoch against `documentEpoch`, never
 * the binding's - `evaluateConditionOnLeasedTab` and `setFilesOnTab` were the fourth and fifth place
 * this shipped without it before T160. Absent is the top frame, unchanged for every caller that has
 * never named one.
 */
export async function evaluateConditionOnLeasedTab(input: {
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
  /** Which document of the leased tab holds the ref (004/T160). Absent is the top frame. */
  frameId?: number;
  /** The origin required of *this frame's* answer, mirroring `resolveHandleOnTab`'s `frameOrigin`. */
  frameOrigin?: string;
}): ReturnType<ConditionEvaluator> {
  let page: ActivePageBinding;
  try {
    page = await resolveSupportedTab(input.expectedTabId);
  } catch {
    return { ok: false, reason: "stale-context" };
  }
  if (page.canonicalOrigin !== input.canonicalOrigin) {
    return { ok: false, reason: "stale-context" };
  }
  const expectedOrigin = input.frameOrigin ?? input.canonicalOrigin;
  const binding = await ensureContentRuntime(page, input);
  if (binding.documentEpoch !== input.documentEpoch || binding.canonicalOrigin !== expectedOrigin) {
    return { ok: false, reason: "stale-context" };
  }
  const raw = (await withDeadline(
    chrome.tabs.sendMessage(
      page.tabId,
      contentFrame({
        type: "content.evaluate-condition",
        taskId: input.taskId,
        operationId: input.operationId,
        runtimeEpochId: input.runtimeEpochId,
        nonce: input.nonce,
        tabId: page.tabId,
        documentEpoch: binding.documentEpoch,
        payload: {
          generalPageReadGrantId: input.generalPageReadGrantId,
          targetHandle: input.targetHandle,
          condition: input.condition,
        },
      }),
      { frameId: input.frameId ?? 0 },
    ),
    // A poll is its own stage. It collects nothing and executes nothing, so a diagnostic that named
    // either would send a reader to the wrong round trip.
    "content.evaluation",
  )) as Record<string, unknown> | undefined;
  if (raw?.ok === false) {
    // The runtime's own refusals travel as they are: the worker decides from the reason whether the
    // wait is over, and a reason it does not know is an invalid result rather than a guess.
    if (isContentExecutionRefusalReason(raw.reason)) return { ok: false, reason: raw.reason };
    throw pageFailure("content.invalid-result");
  }
  const reply = contentEvaluateConditionReplySchema.safeParse(raw);
  if (!reply.success) throw pageFailure("content.invalid-result");
  return reply.data;
}

export async function executeOnActiveTab(input: {
  taskId: string;
  operationId: string;
  runtimeEpochId: string;
  capability: RuntimeAction;
  arguments: Record<string, unknown>;
  /**
   * Whose policy the page applies to this effect (003/US3 decision 3). Absent means `classified`,
   * which is what the remote caller of 001/002 has always meant and still means.
   */
  policy?: "classified" | "trusted-agent";
  documentEpoch: string;
  canonicalOrigin: string;
  /** The worker's identifier for this page binding; every frame of it repeats this value. */
  nonce: string;
  /** The leased tab. Any other active tab is refused before this function probes or injects. */
  expectedTabId: number;
  /**
   * The worker's dispatch fence, asked again after the probe and immediately before the effect is
   * sent. The probe is an await the worker cannot see through; a Stop, revocation, or binding change
   * that lands during it must still prevent the effect.
   */
  stillAllowed?: () => boolean;
  /**
   * When set, the page is this tab, whether or not it is active; when absent, the active tab of the
   * current window - the remote caller's binding. It must still be the leased tab: the comparison
   * below is unchanged, so an explicit tab that is not `expectedTabId` is refused as any other tab
   * would be.
   */
  tab?: number;
}): Promise<PageExecutionOutcome> {
  const page = await resolveBoundPage(input.tab);
  if (page.tabId !== input.expectedTabId || page.canonicalOrigin !== input.canonicalOrigin) {
    return { ok: false, reachedPage: false, reason: "stale-context" };
  }
  const binding = await ensureContentRuntime(page, input);
  if (binding.documentEpoch !== input.documentEpoch || binding.canonicalOrigin !== input.canonicalOrigin) {
    return { ok: false, reachedPage: false, reason: "stale-context" };
  }
  // The frame is assembled - and therefore validated - before the fence is asked, so a frame the
  // schema refuses is a refusal that never reached the page rather than a throw after the fence has
  // already committed the effect and made it uncertain.
  let frame: ReturnType<typeof contentFrame>;
  try {
    frame = contentFrame({
      type: "content.execute-action",
      taskId: input.taskId,
      operationId: input.operationId,
      runtimeEpochId: input.runtimeEpochId,
      nonce: input.nonce,
      tabId: page.tabId,
      documentEpoch: binding.documentEpoch,
      ...(input.policy === undefined ? {} : { policy: input.policy }),
      payload: { action: input.capability, arguments: input.arguments },
    });
  } catch {
    return { ok: false, reachedPage: false, reason: "invalid-action-arguments" };
  }
  // Distinct from the runtime's own `cancelled`: this refusal never reached the page.
  if (input.stillAllowed && !input.stillAllowed()) return { ok: false, reachedPage: false, reason: "fence-refused" };
  const raw = (await withDeadline(
    chrome.tabs.sendMessage(page.tabId, frame, { frameId: 0 }),
    // Its own stage: an action that may already have happened must not be filed under collection.
    "content.execution",
  )) as Record<string, unknown>;
  if (typeof raw?.ok !== "boolean") throw pageFailure("content.invalid-result");
  if (!raw.ok) {
    // The runtime's refusal vocabulary is closed (002 T053b). A reply naming anything else is not a
    // result the worker can put on the channel, so it is refused here rather than forwarded as an
    // error code the service has never been told about.
    if (!isContentExecutionRefusalReason(raw.reason)) throw pageFailure("content.invalid-result");
    // The runtime answered, so the frame arrived: whatever it decided, it decided on the page.
    return { ok: false, reachedPage: true, reason: raw.reason };
  }
  if (input.capability === "browser.scroll") {
    if (
      raw.effect !== "scrolled" ||
      typeof raw.scrollTop !== "number" ||
      !Number.isFinite(raw.scrollTop) ||
      !isTargetVisibility(raw.targetVisibility)
    ) {
      throw pageFailure("content.invalid-result");
    }
    return { ok: true, effect: "scrolled", scrollTop: raw.scrollTop, targetVisibility: raw.targetVisibility };
  }
  // A click or text entry must state whether the document URL moved under it. A reply without that
  // observation is not a verified result, so it is refused rather than assumed unchanged.
  if (typeof raw.documentChanged !== "boolean") throw pageFailure("content.invalid-result");
  if (input.capability === "browser.click") {
    if (raw.effect !== "activated" || !Number.isInteger(raw.clicks) || Number(raw.clicks) < 1) {
      throw pageFailure("content.invalid-result");
    }
    return { ok: true, effect: "activated", clicks: Number(raw.clicks), documentChanged: raw.documentChanged };
  }
  if (input.capability === "browser.key-press") {
    // The key is a contract value, checked here the way a scroll's visibility is: a reply naming a
    // key outside the set is not a verified result, and refusing it here keeps it from reaching the
    // channel as a frame the schema would reject after the effect was already filed.
    if (
      raw.effect !== "key-pressed" ||
      !isKeyPressKey(raw.key) ||
      typeof raw.focusRetained !== "boolean" ||
      raw.valueEchoed !== false
    ) {
      throw pageFailure("content.invalid-result");
    }
    return {
      ok: true,
      effect: "key-pressed",
      key: raw.key,
      focusRetained: raw.focusRetained,
      valueEchoed: false,
      documentChanged: raw.documentChanged,
    };
  }
  if (input.capability === "browser.hover") {
    if (raw.effect !== "hovered" || typeof raw.targetVisible !== "boolean") {
      throw pageFailure("content.invalid-result");
    }
    return { ok: true, effect: "hovered", targetVisible: raw.targetVisible, documentChanged: raw.documentChanged };
  }
  if (input.capability === "browser.double-click") {
    if (raw.effect !== "double-activated" || !Number.isInteger(raw.clicks) || Number(raw.clicks) < 2) {
      throw pageFailure("content.invalid-result");
    }
    return { ok: true, effect: "double-activated", clicks: Number(raw.clicks), documentChanged: raw.documentChanged };
  }
  if (input.capability === "browser.right-click") {
    if (raw.effect !== "context-activated" || !Number.isInteger(raw.clicks) || Number(raw.clicks) < 1) {
      throw pageFailure("content.invalid-result");
    }
    return { ok: true, effect: "context-activated", clicks: Number(raw.clicks), documentChanged: raw.documentChanged };
  }
  if (input.capability === "browser.triple-click") {
    if (raw.effect !== "triple-activated" || !Number.isInteger(raw.clicks) || Number(raw.clicks) < 3) {
      throw pageFailure("content.invalid-result");
    }
    return { ok: true, effect: "triple-activated", clicks: Number(raw.clicks), documentChanged: raw.documentChanged };
  }
  if (input.capability === "browser.drag") {
    if (raw.effect !== "dragged" || typeof raw.moved !== "boolean") {
      throw pageFailure("content.invalid-result");
    }
    return { ok: true, effect: "dragged", moved: raw.moved, documentChanged: raw.documentChanged };
  }
  if (input.capability === "browser.form-input") {
    if (raw.effect !== "value-set" || typeof raw.valueMatched !== "boolean") {
      throw pageFailure("content.invalid-result");
    }
    return { ok: true, effect: "value-set", valueMatched: raw.valueMatched, documentChanged: raw.documentChanged };
  }
  if (input.capability === "browser.enter-text") {
    if (
      raw.effect !== "text-entered" ||
      !Number.isInteger(raw.charactersChanged) ||
      Number(raw.charactersChanged) < 0 ||
      raw.valueEchoed !== false
    ) {
      throw pageFailure("content.invalid-result");
    }
    return {
      ok: true,
      effect: "text-entered",
      charactersChanged: Number(raw.charactersChanged),
      valueEchoed: false,
      documentChanged: raw.documentChanged,
    };
  }
  return noResultShape(input.capability);
}

/**
 * Reached only if `BRIDGE_ACTIONS` gains a member without a reply mapping of its own: the compiler
 * refuses the call, and a reply for it at runtime is invalid rather than another action's shape.
 */
function noResultShape(capability: never): never {
  void capability;
  throw pageFailure("content.invalid-result");
}

function isTargetVisibility(value: unknown): value is TargetVisibility {
  return (TARGET_VISIBILITIES as readonly unknown[]).includes(value);
}

/**
 * The port vocabulary this broker answers in. It is defined with the port rather than here so a
 * caller that only knows the port can name every answer, and re-exported so the broker's own tests
 * and callers keep one import.
 */
export type { PageExecutionOutcome, PageExecutorRefusal, PageRefusalReason } from "./page-ports.js";

function isKeyPressKey(value: unknown): value is KeyPressKey {
  return (KEY_PRESS_KEYS as readonly unknown[]).includes(value);
}

/**
 * What `probeActiveTab` answers: the port's own answers, plus `deadline` (015/T401, FR-206).
 *
 * `deadline` is a frame that took the probe and did not answer within the content deadline. It is
 * not `stale-context` - the tab is there, on the same origin, and nothing says its document moved -
 * so a caller that reports it has to be able to say so rather than calling a live page gone
 * (R-197: measured at 10 033 ms on a `complete` tab on the right URL). A caller that only asks "is
 * the document intact" reads it as the not-ok it is.
 */
export type ActiveTabProbeResult = Awaited<ReturnType<PagePostEffectProbe>> | { ok: false; reason: "deadline" };

/**
 * Post-effect verification probe. It asks the runtime that is already bound to the leased tab for
 * its current document binding and never injects: a document that replaced itself has no runtime
 * to answer, and that silence is exactly the evidence the worker needs. It runs after the effect
 * settle window so a navigation the effect started has had time to unload the old document.
 */
export async function probeActiveTab(input: {
  taskId: string;
  operationId: string;
  runtimeEpochId: string;
  nonce: string;
  expectedTabId: number;
  canonicalOrigin: string;
  /**
   * When set, the page is this tab, whether or not it is active; when absent, the active tab of the
   * current window - the remote caller's binding. Verification has to reach the tab the effect ran
   * on: an agent's tab is very often not the active one, and probing the active tab instead would
   * report `stale-context` for a document that is perfectly intact, turning every observed effect
   * into an unverified one (003 M2 review A8, FR-040).
   */
  tab?: number;
}): Promise<ActiveTabProbeResult> {
  let page: ActivePageBinding;
  try {
    page = await resolveBoundPage(input.tab);
  } catch {
    return { ok: false, reason: "unsupported-page" };
  }
  if (page.tabId !== input.expectedTabId || page.canonicalOrigin !== input.canonicalOrigin) {
    return { ok: false, reason: "stale-context" };
  }
  try {
    const binding = await probeContentRuntime(page, input);
    return { ok: true, documentEpoch: binding.documentEpoch, canonicalOrigin: binding.canonicalOrigin };
  } catch (error) {
    if (isNoReceiver(error)) return { ok: false, reason: "document-replaced" };
    // 015/T401: the frame is there and did not answer in time - its own answer, never `stale`.
    if (isDeadline(error)) return { ok: false, reason: "deadline" };
    return { ok: false, reason: "stale-context" };
  }
}

/**
 * Cancels on the leased tab, never on whatever tab is active now: the runtime that may be running
 * the effect lives there even if the user has since switched tabs. A leased tab that is gone or no
 * longer shows the task origin has no runtime to cancel, which is reported, never thrown.
 */
export async function cancelActiveContent(input: {
  taskId: string;
  operationId: string;
  runtimeEpochId: string;
  /** The worker's identifier for the binding being cancelled; a cancel never probes for one. */
  nonce: string;
  tabId: number;
  documentEpoch: string;
  canonicalOrigin: string;
}): Promise<{ cancelled: boolean }> {
  let page: ActivePageBinding;
  try {
    page = await resolveSupportedTab(input.tabId);
  } catch {
    return { cancelled: false };
  }
  if (page.canonicalOrigin !== input.canonicalOrigin) return { cancelled: false };
  // Cancel never probes and never injects: a probe would rebind a runtime that may already belong
  // to a successor task, and the nonce the worker holds is what lets this frame be recognised
  // without one.
  try {
    const response = (await withDeadline(
      chrome.tabs.sendMessage(
      page.tabId,
      contentFrame({
        type: "content.cancel",
        taskId: input.taskId,
        operationId: input.operationId,
        runtimeEpochId: input.runtimeEpochId,
        nonce: input.nonce,
        tabId: page.tabId,
        documentEpoch: input.documentEpoch,
        payload: {},
      }),
      { frameId: 0 },
      ),
      "content.collection",
    )) as { ok?: unknown };
    return { cancelled: response?.ok === true };
  } catch (error) {
    if (isNoReceiver(error)) return { cancelled: false };
    throw error;
  }
}
