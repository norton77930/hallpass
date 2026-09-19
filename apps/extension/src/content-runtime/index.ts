import { contentRuntimeMessageSchema, DEFAULT_BOUNDS } from "@hallpass/contracts";
import { classifyDocumentSupport, collectPage, snapshotTarget } from "./collector.js";
import { setFilesOnTarget } from "./files.js";
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
  if (!bindingMatches(context, message)) return { ok: false, reason: "stale-binding" };
  if (message.expectedDocumentEpoch !== context.documentEpoch) {
    return { ok: false, reason: "stale-context" };
  }
  if (message.type === "content.cancel") {
    context.cancelledOperations.add(message.operationId);
    context.registry.invalidate();
    context.binding = undefined;
    return { ok: true, effect: "cancelled" };
  }
  if (context.cancelledOperations.has(message.operationId)) {
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
  if (message.type === "content.resolve-active-element") {
    const documentRef = (globalThis as { document?: { activeElement?: unknown } }).document;
    return registerLiveElement(context.registry, context.documentEpoch, documentRef?.activeElement);
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
    sendResponse(handleContentMessage(message));
    return false;
  };
  globalGuard.__pocContentRuntimeListener = listener;
  chromeRuntime.onMessage.addListener(listener);
}
