import { contentRuntimeMessageSchema, DEFAULT_BOUNDS } from "@hallpass/contracts";
import { classifyDocumentSupport, collectPage, snapshotTarget } from "./collector.js";
import { deliverImage, setFilesOnTarget } from "./files.js";
import { executeAction, pageSinkFromGlobal, type PageSink } from "./actions.js";
import {
  evaluateCondition,
  readLiveTarget,
  registerLiveElement,
  resolveDescription,
  TargetRegistry,
} from "./targets.js";

export { collectFormItems, collectPage } from "./collector.js";
export { TargetRegistry } from "./targets.js";
export { executeAction, createDocumentSink, createMemorySink, pageSinkFromGlobal } from "./actions.js";
export type { DocumentSinkHost, PageSink } from "./actions.js";

export type ContentMessage = ReturnType<typeof contentRuntimeMessageSchema.parse>;

/**
 * The worker conversation this document is currently bound to. The nonce is re-established by every
 * probe, so a frame captured under an earlier binding no longer matches a live one.
 */
type RuntimeBinding = { taskId: string; runtimeEpochId: string; nonce: string };

export type ContentRuntimeContext = {
  documentEpoch: string;
  documentUrl: string;
  canonicalOrigin: string;
  registry: TargetRegistry;
  binding: RuntimeBinding | undefined;
  cancelledOperations: Set<string>;
  /**
   * The binding the last cancel ended (015). Only an action frame carrying this exact binding and a
   * cancelled operation is answered `cancelled` rather than `stale-binding`; it never lets a frame act.
   */
  cancelledBinding: RuntimeBinding | undefined;
};

type NavigationHistory = {
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
};

type NavigationHost = {
  location?: { href?: string; origin?: string };
  history?: NavigationHistory;
  addEventListener?(type: string, listener: () => void): void;
  __pocContentRuntimeNavigationGuard?: {
    context: ContentRuntimeContext;
    href: string;
    check(): void;
  };
};

function randomId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return prefix + uuid;
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return prefix + [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function currentOrigin(): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  return typeof origin === "string" && origin.length > 0 ? origin : "null";
}

function currentHref(): string {
  const href = (globalThis as { location?: { href?: string } }).location?.href;
  return typeof href === "string" ? href : "";
}

/**
 * `elementFromPoint` hit-tests one document at a time - it never descends into a shadow tree on its
 * own, so a point inside an open shadow root always comes back as the shadow **host**: an *ancestor*
 * of whatever is actually there (004/T148). The host's own `shadowRoot.elementFromPoint` is the
 * browser's answer for what is inside it, at the same page-level point, so descending through it -
 * repeatedly, for a shadow root nested inside another - is what a real hit test would have found.
 * Stops the moment there is nothing further to descend into, so an ordinary element (no shadow
 * root) or a closed one (no `shadowRoot` at all) is returned exactly as `elementFromPoint` gave it.
 */
function resolveShadowHit(element: unknown, x: number, y: number): unknown {
  let current = element;
  for (;;) {
    const shadow = (current as { shadowRoot?: { elementFromPoint?: (x: number, y: number) => unknown } } | null)
      ?.shadowRoot;
    if (!shadow || typeof shadow.elementFromPoint !== "function") return current;
    const inner = shadow.elementFromPoint(x, y);
    if (!inner || inner === current) return current;
    current = inner;
  }
}

/**
 * `Node.contains` never crosses a shadow boundary (004/T158, second review): once
 * {@link resolveShadowHit} has descended *into* an open shadow tree, `host.contains(innerHit)` is
 * false even though the hit is exactly where the host said it was - so a target that **is** the
 * shadow host itself (a custom element that puts its own role on the host: `<vaadin-button
 * role="button">`, Lit, Lightning) reported `missed` on a click that landed. Walks up from the hit
 * element toward the target, crossing out of a shadow root through its `host` whenever `parentNode`
 * runs out (the boundary `contains` cannot see), so a host, an ordinary ancestor, and a descendant of
 * the target's shadow tree all resolve the same way a real hit test would.
 */
function containsAcrossShadow(target: unknown, hit: unknown): boolean {
  let current: unknown = hit;
  while (current) {
    if (current === target) return true;
    const node = current as { parentNode?: unknown; host?: unknown };
    current = node.parentNode ?? node.host ?? null;
  }
  return false;
}

/** Whether an element is an editing host: the focus it holds is a field's, wherever it sits. */
function isEditableElement(element: unknown): boolean {
  const node = element as {
    isContentEditable?: unknown;
    getAttribute?: (name: string) => string | null;
    ownerDocument?: { designMode?: unknown } | null;
  };
  // A browser answers `isContentEditable` itself (designMode and inheritance included); the
  // attribute and designMode reading is only for an environment that does not (jsdom).
  if (typeof node.isContentEditable === "boolean") return node.isContentEditable;
  const attribute = node.getAttribute?.("contenteditable");
  if (attribute != null && attribute.toLowerCase() !== "false") return true;
  return String(node.ownerDocument?.designMode ?? "").toLowerCase() === "on";
}

/**
 * The elements holding focus, outermost first: `document.activeElement` is the outermost open shadow
 * host, and each host's `shadowRoot.activeElement` is the element one root down, so every entry is
 * the focus as it reads from inside its own tree scope (a retargeted view). The body and the root
 * element are where focus rests when nothing is focused, so they are left out unless they are the
 * element named (handle equality, as before), or an editing host in a document that holds focus: in
 * a subframe without focus the body is `activeElement` however the click moved focus elsewhere, so
 * it must not stand for every target there (039 review I2, re-review I1; fail-closed).
 */
function focusChain(
  documentRef: { activeElement?: unknown; hasFocus?: () => boolean } | undefined,
  target: unknown,
): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = documentRef?.activeElement;
  while (current) {
    chain.push(current);
    current = (current as { shadowRoot?: { activeElement?: unknown } | null }).shadowRoot?.activeElement;
  }
  return chain.filter((element) => {
    const tagName = String((element as { tagName?: unknown }).tagName ?? "").toUpperCase();
    if (tagName !== "BODY" && tagName !== "HTML") return true;
    if (element === target) return true;
    return isEditableElement(element) && documentRef?.hasFocus?.() === true;
  });
}

/**
 * Whether `focused` (one entry of the focus chain) is `target` or an ancestor of it. The walk crosses
 * out of a shadow root through its host, but a host reached that way does not count: a target inside
 * a host's own shadow tree is not "in" the field that host stands for, so an unrelated field in the
 * same shadow tree still misses. A host reached as an ordinary parent (a light-DOM or slotted target)
 * counts. The deepest focused element is the exception (`throughHost`): focus on a host that has no
 * focused field below it is on the host itself, which is an ancestor of its own shadow content in the
 * composed tree.
 */
function isSelfOrAncestor(focused: unknown, target: unknown, throughHost: boolean): boolean {
  let current: unknown = target;
  while (current) {
    if (current === focused) return true;
    const node = current as { parentNode?: unknown; host?: unknown };
    if (node.parentNode) {
      current = node.parentNode;
      continue;
    }
    // Out of a shadow root: the host matches only for the deepest focused element; otherwise step past it.
    const host = node.host as { parentNode?: unknown; host?: unknown } | null | undefined;
    if (throughHost) current = host ?? null;
    else current = host ? (host.parentNode ?? host.host ?? null) : null;
  }
  return false;
}

/**
 * The element of the focus chain that is on the path a click at `target` took (039 D-039-1): the
 * element itself, an ancestor of it across shadow roots, or the control of the nearest `<label>`
 * around it. The deepest such element wins. The label rule follows `label.control` only; a label
 * inside a shadow root follows its own root.
 */
function focusedOnPathOf(chain: unknown[], target: unknown): unknown {
  const label = (target as { closest?: (selector: string) => unknown } | undefined)?.closest?.("label");
  const control = label == null ? undefined : (label as { control?: unknown }).control;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const focused = chain[index];
    if (isSelfOrAncestor(focused, target, index === chain.length - 1) || (control != null && control === focused)) return focused;
  }
  return undefined;
}

/** The role and label a read already shows for an element, bounded as a `find` candidate is. */
function describeField(element: unknown): { role?: string; label?: string } {
  const snapshot = snapshotTarget(element, DEFAULT_BOUNDS.maxLabelChars);
  const live = readLiveTarget(element);
  const role = snapshot?.role ?? live?.role ?? live?.tagName.toLowerCase();
  const label = snapshot?.label;
  return {
    ...(role ? { role: role.slice(0, 100) } : {}),
    ...(label ? { label } : {}),
  };
}

export function createContentRuntimeContext(input?: {
  documentEpoch?: string;
  documentUrl?: string;
  canonicalOrigin?: string;
}): ContentRuntimeContext {
  return {
    documentEpoch: input?.documentEpoch ?? randomId("doc-"),
    documentUrl: input?.documentUrl ?? currentHref(),
    canonicalOrigin: input?.canonicalOrigin ?? currentOrigin(),
    registry: new TargetRegistry(),
    binding: undefined,
    cancelledOperations: new Set<string>(),
    cancelledBinding: undefined,
  };
}

const runtimeContext = createContentRuntimeContext();

function invalidateForNavigation(context: ContentRuntimeContext, host: NavigationHost): void {
  context.documentEpoch = randomId("doc-");
  context.documentUrl = host.location?.href ?? context.documentUrl;
  const origin = host.location?.origin;
  context.canonicalOrigin =
    typeof origin === "string" && origin.length > 0 ? origin : currentOrigin();
  context.registry.invalidate();
  context.cancelledOperations.clear();
  context.cancelledBinding = undefined;
  context.binding = undefined;
}

function refreshNavigationContext(
  context: ContentRuntimeContext,
  host: NavigationHost = globalThis as unknown as NavigationHost,
): void {
  const href = host.location?.href;
  if (typeof href === "string" && href !== context.documentUrl) {
    invalidateForNavigation(context, host);
  }
}

export function installNavigationInvalidation(
  context: ContentRuntimeContext,
  host: NavigationHost = globalThis as unknown as NavigationHost,
): void {
  const href = host.location?.href;
  const history = host.history;
  if (typeof href !== "string" || !history) return;

  const existing = host.__pocContentRuntimeNavigationGuard;
  if (existing) {
    existing.context = context;
    existing.href = href;
    return;
  }

  const guard = {
    context,
    href,
    check() {
      const nextHref = host.location?.href;
      if (typeof nextHref !== "string" || nextHref === guard.href) return;
      guard.href = nextHref;
      invalidateForNavigation(guard.context, host);
    },
  };
  host.__pocContentRuntimeNavigationGuard = guard;

  const originalPushState = history.pushState;
  history.pushState = function pushState(data, unused, url) {
    originalPushState.call(this, data, unused, url);
    guard.check();
  };
  const originalReplaceState = history.replaceState;
  history.replaceState = function replaceState(data, unused, url) {
    originalReplaceState.call(this, data, unused, url);
    guard.check();
  };
  host.addEventListener?.("popstate", guard.check);
  host.addEventListener?.("hashchange", guard.check);
}

installNavigationInvalidation(runtimeContext);

/**
 * A non-probe frame belongs to this binding only if all three agree. The nonce is what a replayed
 * frame cannot supply: the epoch and task of an earlier round trip may still match, its nonce
 * cannot once any probe has re-established the binding.
 */
function bindingMatches(context: ContentRuntimeContext, message: ContentMessage): boolean {
  return (
    context.binding?.taskId === message.taskId &&
    context.binding.runtimeEpochId === message.runtimeEpochId &&
    context.binding.nonce === message.nonce
  );
}

/** Whether a probe is joining a different conversation, which is what invalidates the registry. */
function conversationChanged(context: ContentRuntimeContext, message: ContentMessage): boolean {
  return (
    context.binding?.taskId !== message.taskId ||
    context.binding.runtimeEpochId !== message.runtimeEpochId
  );
}

export function handleContentMessage(
  raw: unknown,
  sink?: PageSink,
  context: ContentRuntimeContext = runtimeContext,
): unknown {
  const parsed = contentRuntimeMessageSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid-message" };
  refreshNavigationContext(context);
  const message = parsed.data;
  if (message.type === "content.probe") {
    // A probe from a different task or worker epoch is a new conversation and drops everything the
    // previous one issued. A probe from the same one only rotates the nonce, so re-probing during a
    // task never throws away the handles that task is still using.
    if (conversationChanged(context, message)) {
      context.registry.invalidate();
      context.cancelledOperations.clear();
      context.cancelledBinding = undefined;
    }
    context.binding = {
      taskId: message.taskId,
      runtimeEpochId: message.runtimeEpochId,
      nonce: message.nonce,
    };
    return {
      documentEpoch: context.documentEpoch,
      canonicalOrigin: context.canonicalOrigin,
    };
  }
  if (!bindingMatches(context, message)) {
    // 015: an action frame for an operation this runtime cancelled, from the very binding the cancel
    // ended, is the frame that was queued behind the cancel - it is refused as `cancelled`, which is
    // what happened to it. Only the worker holding that binding's nonce can produce such a frame, and
    // it still acts on nothing; every other unmatched frame learns only `stale-binding`.
    if (
      message.type === "content.execute-action" &&
      context.cancelledOperations.has(message.operationId) &&
      context.cancelledBinding?.taskId === message.taskId &&
      context.cancelledBinding.runtimeEpochId === message.runtimeEpochId &&
      context.cancelledBinding.nonce === message.nonce
    ) {
      return { ok: false, reason: "cancelled" };
    }
    return { ok: false, reason: "stale-binding" };
  }
  if (message.expectedDocumentEpoch !== context.documentEpoch) {
    return { ok: false, reason: "stale-context" };
  }
  if (message.type === "content.cancel") {
    context.cancelledOperations.add(message.operationId);
    context.registry.invalidate();
    context.cancelledBinding = context.binding;
    context.binding = undefined;
    return { ok: true, effect: "cancelled" };
  }
  if (context.cancelledOperations.has(message.operationId)) {
    return { ok: false, reason: "cancelled" };
  }
  // 015 change log 2026-10-18: the worker has already answered the caller for this effect, so a
  // frame reached only now - queued behind a page that was busy - is refused before it acts.
  if (
    message.type === "content.execute-action" &&
    message.deadlineAt !== undefined &&
    Date.now() > message.deadlineAt
  ) {
    return { ok: false, reason: "cancelled" };
  }
  if (message.type === "content.collect-page") {
    if (
      typeof document !== "undefined" &&
      classifyDocumentSupport(document) === "unsupported"
    ) {
      return {
        ok: false,
        reason: "unsupported-page",
        documentEpoch: context.documentEpoch,
        canonicalOrigin: context.canonicalOrigin,
        formValueItems: [],
      };
    }
    return collectPage({
      snapshotId: randomId("snap-"),
      documentEpoch: context.documentEpoch,
      origin: context.canonicalOrigin,
      requested: message.payload.requestedDataCategories,
      formGrantActive: message.payload.formValuesGrantId !== undefined,
      generalGrantActive: message.payload.generalPageReadGrantId.length > 0,
      // The worker supplies the limits; the page never picks its own.
      bounds: message.payload.bounds,
      registry: context.registry,
      ...(message.payload.rootTargetHandle === undefined
        ? {}
        : { rootTargetHandle: message.payload.rootTargetHandle }),
      // Absent is `reviewed`, which is the only thing the archived remote path ever asks for.
      ...(message.payload.mintPolicy === undefined ? {} : { mintPolicy: message.payload.mintPolicy }),
      ...(message.payload.scrollIntoView === undefined
        ? {}
        : { scrollIntoView: message.payload.scrollIntoView }),
    });
  }
  if (message.type === "content.resolve-target") {
    // 002/FR-026: answered from the handles the last collection minted for this document, with the
    // bound the worker supplied. Nothing here reads the page beyond what a review card shows.
    return resolveDescription(
      context.registry,
      context.documentEpoch,
      message.payload.description,
      message.payload.maxCandidates,
    );
  }
  if (message.type === "content.evaluate-condition") {
    // 002/FR-027: one question about one handle this document minted, answered with one boolean.
    // It observes the live element and sends nothing about the page back.
    return evaluateCondition(
      context.registry,
      context.documentEpoch,
      message.payload.targetHandle,
      message.payload.condition,
    );
  }
  if (message.type === "content.resolve-point") {
    // 003/US3 decision 2: what the user would be pointing at becomes a registry handle, so it has
    // the same lifetime every other target has. `elementFromPoint` is the browser's own answer to
    // "what is here", hit-testing included, which is why no geometry is computed on this side.
    const documentRef = (globalThis as { document?: { elementFromPoint?: (x: number, y: number) => unknown } })
      .document;
    const element = resolveShadowHit(
      documentRef?.elementFromPoint?.(message.payload.x, message.payload.y),
      message.payload.x,
      message.payload.y,
    );
    const targetHandle = message.payload.targetHandle;
    if (targetHandle) {
      // 004/T128 gap 1: a point that lands on the target's own element or on any descendant of it
      // hit the target - the icon inside a button, the label span inside a link - so it resolves to
      // the same handle the delivery was aimed at rather than a fresh one for whatever was
      // topmost. The check is against the registry's own record of that handle's live element,
      // never against the rect-collection walk that is itself under suspicion.
      const record = context.registry.resolve(targetHandle, context.documentEpoch);
      const targetElement = record?.element;
      // 004/T168: a target the delivery itself removed - a cued-overlay play button that swaps
      // itself for the player's controls on the click that plays the video, a search toggle that
      // expands into the box it hid - is no longer anywhere a point can hit. Testing the point
      // against whatever replaced it and calling that a miss reported `target-missed` on clicks
      // that landed. There is nothing to hit-test against, so the confirmation cannot be made; the
      // worker reads this as `unconfirmed`, never as an observed miss.
      if (targetElement && (targetElement as { isConnected?: unknown }).isConnected === false) {
        return { ok: false, reason: "stale-target" };
      }
      if (element && targetElement && containsAcrossShadow(targetElement, element)) {
        // The ref itself, not a re-mint through the register: the element is already named, and
        // asking for its name again is how a caller-bound alias (a test fixture's own handle, or a
        // 002 remote registration) could come back as a *different* name for the same element.
        return { ok: true, outcome: "resolved", candidates: [{ targetHandle }] };
      }
      // A confirmation named a ref, and the point did not hit it or a descendant of it: a real
      // miss (004/T129), distinct from `stale-context` (the round trip never ran at all). Say what
      // was actually there - the role and name a plain read already discloses under the same
      // grant - rather than the bare refusal that told an agent nothing to act on. Bounded the way
      // `find`'s own candidates are; nothing about the element travels back beyond that.
      const live = element ? readLiveTarget(element) : undefined;
      const role = live?.role ?? live?.tagName.toLowerCase();
      // Not `readLiveTarget`'s `name` - the HTML `name` attribute, which an arbitrary control (a
      // player button, say) almost never carries. The collector's own name computation is what
      // `read_page` and `find` already show a caller for this same element (aria-label, title,
      // alt, caption, own text, name attribute, placeholder), so a miss says the same thing a read
      // would have (004/T129, B83).
      const label = element ? snapshotTarget(element, DEFAULT_BOUNDS.maxLabelChars)?.label : undefined;
      return {
        ok: true,
        outcome: "missed",
        ...(role ? { role: role.slice(0, 100) } : {}),
        ...(label ? { label } : {}),
      };
    }
    return registerLiveElement(context.registry, context.documentEpoch, element);
  }
  if (message.type === "content.set-files") {
    // 003/FR-051: bytes the host was allowed to read, put on one file input. Nothing here knows
    // where they came from, which is what keeps the file system out of the page's reach.
    return setFilesOnTarget(context.registry, {
      documentEpoch: context.documentEpoch,
      targetHandle: message.payload.targetHandle,
      files: message.payload.files,
    });
  }
  if (message.type === "content.deliver-image") {
    // 013/FR-170: a picture this session took, put where the agent asked - on a file input, or
    // dropped at a point. Nothing here knows which picture it was: the id stayed with the host.
    return deliverImage(context.registry, {
      documentEpoch: context.documentEpoch,
      target: message.payload.target,
      file: message.payload.file,
    });
  }
  if (message.type === "content.resolve-active-element") {
    const documentRef = (globalThis as { document?: { activeElement?: unknown; hasFocus?: () => boolean } }).document;
    const targetHandle = message.payload.targetHandle;
    if (targetHandle === undefined) {
      return registerLiveElement(context.registry, context.documentEpoch, documentRef?.activeElement);
    }
    // 039 FR-568: the focus check between a placing click and the first key. The element holding
    // focus counts when it is on the path the click took, not only when it is the element named -
    // a point on the inner span of a rich-text editor focuses the editing host above it.
    const targetElement = context.registry.resolve(targetHandle, context.documentEpoch)?.element;
    // 041 FR-586: a ref this frame's registry cannot resolve has no element to compare focus with, so
    // nothing was checked. Answered as the point confirmation answers a target that left the
    // document (`stale-target`, read by the worker as "could not check"), never as a confirmed miss.
    if (targetElement === undefined) return { ok: false, reason: "stale-target" };
    const chain = focusChain(documentRef, targetElement);
    const onPath = focusedOnPathOf(chain, targetElement);
    if (onPath !== undefined) {
      // The ref itself, as `content.resolve-point` answers a confirmation (no re-mint). When focus is
      // on another element than the ref's own, say which field holds it (FR-569).
      return {
        ok: true,
        outcome: "resolved",
        candidates: [{ targetHandle }],
        ...(onPath === targetElement ? {} : { receivedBy: describeField(onPath) }),
      };
    }
    // A real miss: what holds focus, by role and label, or nothing when nothing does.
    const active = chain[chain.length - 1];
    return { ok: true, outcome: "missed", ...(active === undefined ? {} : describeField(active)) };
  }
  const resolvedSink = sink ?? pageSinkFromGlobal();
  // The action and its arguments arrived as one closed pair, so nothing has to be re-checked here:
  // whatever the schema accepted is exactly what this action takes.
  const payload = message.payload;
  /**
   * Whose policy this effect runs under (003/US3 decision 3). It is passed down rather than decided
   * here: the executor is the one place that classifies, and a second reading of the same field
   * beside it is how the two would come to disagree.
   */
  const policy = message.policy;
  if (payload.action === "browser.enter-text") {
    return executeAction(context.registry, {
      capability: "browser.enter-text",
      documentEpoch: context.documentEpoch,
      targetHandle: payload.arguments.targetHandle,
      text: payload.arguments.text,
      editMode: payload.arguments.editMode,
      policy,
      ...(resolvedSink ? { sink: resolvedSink } : {}),
    });
  }
  if (
    payload.action === "browser.click" ||
    payload.action === "browser.hover" ||
    payload.action === "browser.double-click" ||
    payload.action === "browser.right-click" ||
    payload.action === "browser.triple-click"
  ) {
    return executeAction(context.registry, {
      capability: payload.action,
      documentEpoch: context.documentEpoch,
      targetHandle: payload.arguments.targetHandle,
      policy,
      ...(resolvedSink ? { sink: resolvedSink } : {}),
    });
  }
  if (payload.action === "browser.form-input") {
    return executeAction(context.registry, {
      capability: "browser.form-input",
      documentEpoch: context.documentEpoch,
      targetHandle: payload.arguments.targetHandle,
      value: payload.arguments.value,
      policy,
      ...(resolvedSink ? { sink: resolvedSink } : {}),
    });
  }
  if (payload.action === "browser.drag") {
    return executeAction(context.registry, {
      capability: "browser.drag",
      documentEpoch: context.documentEpoch,
      targetHandle: payload.arguments.targetHandle,
      dropTargetHandle: payload.arguments.dropTargetHandle,
      policy,
      ...(resolvedSink ? { sink: resolvedSink } : {}),
    });
  }
  if (payload.action === "browser.key-press") {
    return executeAction(context.registry, {
      capability: "browser.key-press",
      documentEpoch: context.documentEpoch,
      targetHandle: payload.arguments.targetHandle,
      key: payload.arguments.key,
      policy,
      ...(payload.arguments.modifiers ? { modifiers: payload.arguments.modifiers } : {}),
      ...(resolvedSink ? { sink: resolvedSink } : {}),
    });
  }
  const scroll = payload.arguments;
  return executeAction(context.registry, {
    capability: "browser.scroll",
    documentEpoch: context.documentEpoch,
    mode: scroll.mode,
    policy,
    ...(scroll.mode === "target"
      ? { targetHandle: scroll.targetHandle }
      : { direction: scroll.direction, magnitude: scroll.magnitude }),
    ...(resolvedSink ? { sink: resolvedSink } : {}),
  });
}

export function bindContentRuntime(
  subscribe: (handler: (message: unknown) => unknown) => void,
  sink?: PageSink,
  context: ContentRuntimeContext = runtimeContext,
): void {
  const resolvedSink = sink ?? pageSinkFromGlobal();
  subscribe((message) => handleContentMessage(message, resolvedSink, context));
}

type ChromeContentRuntime = {
  id?: string;
  onMessage?: {
    addListener(
      listener: (
        message: unknown,
        sender: { id?: string },
        sendResponse: (response: unknown) => void,
      ) => boolean | void,
    ): void;
    removeListener?(
      listener: (
        message: unknown,
        sender: { id?: string },
        sendResponse: (response: unknown) => void,
      ) => boolean | void,
    ): void;
  };
};

/** Every message of `contentRuntimeMessageSchema` has a type starting with `content.`; nothing else is answered. */
function ownsContentMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const type = (message as { type?: unknown }).type;
  return typeof type === "string" && type.startsWith("content.");
}

const chromeRuntime = (globalThis as { chrome?: { runtime?: ChromeContentRuntime } }).chrome?.runtime;
type ChromeContentListener = Parameters<NonNullable<ChromeContentRuntime["onMessage"]>["addListener"]>[0];
const globalGuard = globalThis as typeof globalThis & {
  __pocContentRuntimeListener?: ChromeContentListener;
};
if (chromeRuntime?.id && chromeRuntime.onMessage) {
  const previousListener = globalGuard.__pocContentRuntimeListener;
  if (previousListener && chromeRuntime.onMessage.removeListener) {
    chromeRuntime.onMessage.removeListener(previousListener);
  }
  const listener: ChromeContentListener = (message, sender, sendResponse) => {
    if (sender.id !== chromeRuntime.id) return false;
    // Only `content.*` messages are this script's (033 review I1). The agent entry shares frame 0's
    // isolated world and answers its own awaited messages (marks, cursor) later; the first reply
    // wins, so an `invalid-message` answered here would settle those waits at once.
    if (!ownsContentMessage(message)) return false;
    sendResponse(handleContentMessage(message));
    return false;
  };
  globalGuard.__pocContentRuntimeListener = listener;
  chromeRuntime.onMessage.addListener(listener);
}
