import type { AgentNativeResponse, AgentRefusal } from "@hallpass/contracts";
import { createChromeDebuggerAdapter, type DebuggerAdapter } from "../../chrome-adapters/debugger.js";
import { CONTENT_OPERATION_DEADLINE_MS } from "../content-broker.js";

/**
 * The debugger attachment two things share, and one consent that is not shared (004/T119, T125b,
 * US5, R-113, FR-064, FR-071).
 *
 * 003 attached a debugger for one purpose - diagnostics - and let go of it on every navigation,
 * because the *grant* that allowed it is per site. 004 gives the attachment a second use: browser
 * level input, which is the only way a hover is real and a keystroke is one the page cannot tell
 * from a person's. That second use has a different lifetime, and this module is where the two are
 * kept apart:
 *
 *   - **the attachment** is per held tab, made lazily on the first effect and kept while the
 *     session holds the tab. It survives a same-tab navigation, because input is gated per effect
 *     by the site mode and an attachment on its own exposes nothing at all.
 *   - **the domains** (`Runtime`, `Log`, `Network`) are what turn an attachment into a window on
 *     the page's console, its requests and its values, and they are enabled only under 003's
 *     per-site diagnostics grant and disabled the moment the tab leaves that site (FR-071).
 *
 * So a holder is named on every acquisition. The attachment lasts as long as any holder wants it,
 * and the diagnostics holder is the only one that turns it into a window on the page.
 *
 * **The invariant** (004/T125b, pinned by `input-attachment.test.ts`): *no domain whose events we
 * consume, and nothing carrying page content, is enabled outside the owner's diagnostics grant.*
 *
 * That is the promise the consent model actually rests on, and it is deliberately narrower than
 * "only diagnostics enables anything", which this module used to claim and which is not true: an
 * effect on a framed page has to measure where the frame sits, and the geometry domain (`DOM`) has
 * to be enabled on this attachment before it will answer (`frames.ts`). It is a stated exception
 * rather than a hole, on three counts that are checked rather than asserted - it is none of the
 * three diagnostics domains, nothing in this worker subscribes to its events, so nothing it emits
 * is buffered or reachable through any tool; and what it is asked is where a box is, never what
 * the page says. An attachment made to deliver a click still hears nothing.
 *
 * When Chrome refuses to attach - the owner has developer tools open on that tab, or it is a page
 * no extension may touch - every effect on that tab answers `failed` / `input-unavailable` with
 * the cause. There is deliberately no second route: 003's page-level synthetic events are what this
 * slice replaces, so falling back to them would quietly hand the page the very input the reference
 * never produces.
 *
 * **A second stated exception, on the same three counts** (004/T129): a genuinely cross-site
 * (out-of-process) frame is its own CDP target, addressed by `{tabId, sessionId}` rather than
 * `{tabId}` alone, and finding *which* frame a session belongs to can force one bounded
 * `Runtime.evaluate` on it (`effects.ts`'s `createOopifSessionResolver`) - never `Runtime.enable`,
 * so no console event this worker does not already refuse elsewhere is ever produced by it. What
 * that one call reads is a nonce this worker itself planted moments before, compared and discarded;
 * it is not one of the three diagnostics domains, nothing subscribes to it, and it is never asked
 * anything about the page the owner did not already consent to this attachment measuring (`DOM`,
 * above). The session itself carries input dispatch only - `Input.dispatchMouseEvent`,
 * `Input.dispatchKeyEvent` and `Input.insertText` at the frame's own coordinates - and
 * `Target.setAutoAttach` is the one command that discovers such a session exists at all, sent once
 * per attachment, never per effect.
 *
 * **A third stated exception, on the same three counts** (008/T224, D-008-5, R-138): `Page` is
 * enabled on every attachment, because a native dialog is *only* announced - there is no state to
 * poll and no way to suspect one - and a session that cannot hear a dialog answers every call on
 * that tab with a timeout that names the wrong cause: both references do
 * exactly that). The three counts again, each checkable rather than asserted: it is none of the
 * three diagnostics domains; exactly **two** of its events are consumed anywhere in this worker -
 * `Page.javascriptDialogOpening` and `Page.javascriptDialogClosed`, both read by `dialogs.ts`,
 * whose own switch drops the rest unbuffered and unreachable (`input-attachment.test.ts` emits the
 * others and asks every consumer afterwards); and what those two carry is the text of a box drawn
 * on top of the page - on-screen content, the same content a screenshot has shown ungated since
 * 003 - never the document, never a url the agent could not already read from the tab. The owner
 * was offered the narrower option (type only, text behind the diagnostics grant) and declined it:
 * a panel that shows the tester words the agent must guess at is the worse of the two.
 */

/** Why input cannot be delivered on a tab. The contract's `unavailableReason`, unchanged. */
export type InputUnavailableReason = Extract<
  AgentRefusal,
  { reason: "input-unavailable" }
>["unavailableReason"];

/** What this worker knows about one held tab's attachment (data-model InputAttachment). */
export type InputAttachment = {
  tabId: number;
  attached: boolean;
  /** Whether the console/network/runtime domains are on; only ever true under the 003 grant. */
  diagnosticsEnabled: boolean;
  unavailableReason?: InputUnavailableReason;
};

/**
 * Who wants the attachment. All four keep it alive; only `diagnostics` may enable a domain.
 *
 * `recording` is 008's frame capture (T218, R-133): it sends `Page.captureScreenshot` and
 * `Page.getLayoutMetrics`, which are *commands* - one answer each, to the caller that sent them -
 * and it enables nothing at all, so the invariant this module states is untouched by it.
 *
 * `viewport` is 012's emulated viewport (T306, FR-159, R-166): it sends
 * `Emulation.setDeviceMetricsOverride` and its clear - *commands*, one answer each to the caller
 * that sent them - and enables nothing at all. It exists for the lifetime rather than the
 * capability: R-166 measured that a detach does **not** drop an emulation, so the attachment has
 * to outlast every other holder on a tab whose page is being laid out at a size this session
 * chose, or there is nothing left to send the clear over.
 */
export type AttachmentHolder = "input" | "diagnostics" | "recording" | "viewport";

export type AttachmentOutcome = { ok: true } | { ok: false; unavailableReason: InputUnavailableReason };

export type AgentInputAttachments = {
  /**
   * Attach if this tab is not attached yet, and record that `holder` wants it.
   *
   * Lazy on purpose: nothing attaches until a call actually needs it, so Chrome's "is being
   * debugged" bar appears when the agent starts acting rather than when it pairs.
   */
  acquire(tabId: number, holder: AttachmentHolder): Promise<AttachmentOutcome>;
  /** One holder is done. The attachment ends only when no holder is left. */
  drop(tabId: number, holder: AttachmentHolder): Promise<void>;
  /** The lease is over - release, tab close, unpair: every holder lets go and the debugger detaches. */
  release(tabId: number): Promise<void>;
  /** The session ended; nothing it attached may outlive it. */
  releaseAll(): Promise<void>;
  /**
   * One protocol command over the shared attachment.
   *
   * `sessionId` addresses a flattened child session directly - an out-of-process frame's own
   * target (004/T129, `oopifSessions` below) - rather than the tab's top-level session.
   */
  send(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>>;
  /** Which tabs this worker currently has a debugger on. */
  attached(): number[];
  state(tabId: number): InputAttachment | undefined;
  onEvent(listener: (tabId: number, method: string, params: Record<string, unknown>) => void): void;
  onDetach(listener: (tabId: number) => void): void;
  /**
   * Told after a tab was attached and its per-attachment setup is done (012/T306, R-167).
   *
   * `acquire` is the only place in this worker that attaches a debugger, so it is the only place
   * that can say "this tab has one now" - which is what a state Chrome kept across an MV3 eviction
   * has to hear before anything else is sent over the new attachment.
   */
  onAttached(listener: (tabId: number) => Promise<void> | void): void;
  /**
   * Told before a tab's attachment is detached, and awaited (012/T306, FR-159, R-166).
   *
   * The five release sites in `agent-runtime.ts` become one hook here, because what has to happen
   * first - clearing an emulation Chrome would otherwise keep after the detach - is a *command over
   * the attachment*, and after the detach there is nothing to send it over.
   */
  onBeforeRelease(listener: (tabId: number) => Promise<void> | void): void;
  /**
   * How many consumers each fan-out has (008/T230, D-008-5).
   *
   * Read-only, and read by one test: "the page-events domain has exactly one consumer in this
   * worker" is a claim about the composed runtime that no comment can keep true, and a second
   * subscriber added later is exactly the change that would quietly widen what the agent can learn
   * about a page.
   */
  listenerCount(): { event: number; detach: number };
  /** What Chrome says is attached right now (003/C1 reconciliation). */
  attachedTabIds(): Promise<number[]>;
  /** Detach something this worker has no record of; throws when it was somebody else's. */
  detachStray(tabId: number): Promise<void>;
  /**
   * The tab's currently attached out-of-process frame targets (004/T129), fed by
   * `Target.attachedToTarget` / `Target.detachedFromTarget` on the shared attachment and cleared
   * with it. Empty for a tab holding no cross-site frame - which is the table's own answer to "is
   * this tab framing an OOPIF at all", asked before anything tries to correlate one.
   */
  oopifSessions(tabId: number): OopifSession[];
};

/** One out-of-process frame's own CDP session, as `Target.attachedToTarget` reported it. */
export type OopifSession = { targetId: string; sessionId: string; url: string };

export type AgentInputAttachmentsDeps = {
  debug?: DebuggerAdapter;
  reportDiagnostic?: (code: string) => void;
};

/**
 * The domains diagnostics needs, in the order they start producing (003): a domain enabled after a
 * read would answer that read from a buffer that had been filling for no time at all.
 */
const DIAGNOSTICS_DOMAINS = ["Runtime", "Log", "Network"] as const;

/**
 * Which of the two causes Chrome's refusal was.
 *
 * The distinction matters because the two need different things from the owner: close the
 * developer tools, or go to a page an extension may touch. Anything else is reported as the
 * restricted page, which is the reading that asks the agent to move rather than to wait.
 */
function attachFailureReason(error: unknown): InputUnavailableReason {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("another debugger") ||
    message.includes("already attached") ||
    message.includes("devtools")
    ? "devtools-open"
    : "restricted-page";
}

/** The one answer every effect on a tab input cannot reach gives (contracts README section 2). */
export function inputUnavailable(
  callId: string,
  unavailableReason: InputUnavailableReason,
): AgentNativeResponse {
  return {
    callId,
    outcome: "failed",
    reason: "input-unavailable",
    refusal: { reason: "input-unavailable", unavailableReason },
  };
}

type TabState = {
  holders: Set<AttachmentHolder>;
  diagnosticsEnabled: boolean;
};

export function createInputAttachments(deps: AgentInputAttachmentsDeps = {}): AgentInputAttachments {
  const tabs = new Map<number, TabState>();
  /**
   * The last refusal per tab, which is what `state` reports and what an effect answers with.
   *
   * Remembered rather than relied on: every acquisition asks Chrome again, because the owner may
   * close the developer tools between two effects and a remembered no would outlive the fact.
   */
  const unavailable = new Map<number, InputUnavailableReason>();
  /**
   * One held tab's out-of-process frame targets (004/T129), by the CDP `sessionId`
   * `Target.attachedToTarget` names them with (004/T154: never by `targetId`, which CDP's own
   * docs mark deprecated on `Target.detachedFromTarget` and which a real detach can omit). Fed by
   * that event and by its opposite, `Target.detachedFromTarget`; gone entirely when the tab's
   * attachment is.
   */
  const oopif = new Map<number, Map<string, OopifSession>>();
  let adapter: DebuggerAdapter | undefined;
  let wired = false;
  /**
   * What the rest of the worker asked to hear, before there is anything to hear it on (008/T224).
   *
   * Composition subscribes - `agent-runtime.ts` wires the dialog fan-out the moment it is built -
   * and composition happens in workers that never attach a debugger at all. Reaching Chrome's API
   * at that point would make the runtime unbuildable wherever the permission is absent, so the
   * subscriptions are kept here and fanned out from the one listener the adapter is given when it
   * is first actually needed.
   */
  const eventListeners: Array<(tabId: number, method: string, params: Record<string, unknown>) => void> = [];
  const detachListeners: Array<(tabId: number) => void> = [];
  /** 012/T306: what has to happen on either side of an attachment, registered at composition. */
  const attachedListeners: Array<(tabId: number) => Promise<void> | void> = [];
  const beforeReleaseListeners: Array<(tabId: number) => Promise<void> | void> = [];

  /**
   * Runs the hooks for one tab, and never lets one of them decide the caller's answer.
   *
   * A listener that threw has failed at its own job - a size that could not be re-applied, a clear
   * that went nowhere - and neither is a reason to refuse an effect or, worse, to leave a debugger
   * attached to a tab that is going back to the owner. The failure is a diagnostic, as every other
   * best-effort protocol call in this module reports one.
   */
  async function fanOut(
    listeners: Array<(tabId: number) => Promise<void> | void>,
    tabId: number,
  ): Promise<void> {
    for (const listener of listeners) {
      try {
        await listener(tabId);
      } catch {
        deps.reportDiagnostic?.("agent.attachment.hook-failed");
      }
    }
  }

  function debug(): DebuggerAdapter {
    adapter ??= deps.debug ?? createChromeDebuggerAdapter();
    if (!wired) {
      wired = true;
      adapter.onDetach((tabId) => {
        for (const listener of detachListeners) listener(tabId);
      });
      adapter.onEvent((tabId, method, params) => {
        for (const listener of eventListeners) listener(tabId, method, params);
      });
      // Chrome let go on its own - the tab closed, or the owner dismissed the debugging bar. What
      // this worker believed about the tab stops being true at that moment, so it is forgotten
      // before any listener of ours is told.
      adapter.onDetach((tabId) => {
        tabs.delete(tabId);
        oopif.delete(tabId);
      });
      // The auto-attach table's only source (004/T129): a cross-site child frame announces itself
      // as its own target on the *tab's* session, never on a session of its own asking to be
      // found. Both events are read for their addressing fields alone - a `targetId` and a
      // `sessionId` - and nothing here subscribes to what either target says about the page.
      adapter.onEvent((tabId, method, params) => {
        if (method === "Target.attachedToTarget") {
          const info = params as {
            sessionId?: unknown;
            targetInfo?: { targetId?: unknown; type?: unknown; url?: unknown };
          };
          const targetId = info.targetInfo?.targetId;
          const sessionId = info.sessionId;
          if (
            info.targetInfo?.type !== "iframe" ||
            typeof targetId !== "string" ||
            typeof sessionId !== "string"
          ) {
            return;
          }
          // 004/T161: captured once, at attach, and never refreshed - so a same-site cross-origin
          // navigation inside this OOPIF (no new `Target.attachedToTarget`, same session) leaves this
          // stale, and a sandboxed frame with no `allow-same-origin` answers a `url` whose origin is
          // literally `"null"`, which can never equal a real `expectedOrigin`. Both fail the
          // `createOopifSessionResolver` origin check below (`effects.ts`) rather than matching wrong.
          // That is the honest answer, not merely the safe one: the origin check exists so a nonce
          // written into one frame is never credited to a different document that happens to echo it
          // back (004/T149) - refusing on a `url` this worker no longer trusts is exactly that
          // discipline, and the fallback is the tab's own top-level session, not a wrong one. Fixing
          // the staleness (subscribing to `Target.targetInfoChanged` to keep this current) would
          // recover the cross-origin-navigation case; it is not done here because it touches shared
          // attach-table plumbing this brief's window does not cover.
          const url = typeof info.targetInfo?.url === "string" ? info.targetInfo.url : "";
          let forTab = oopif.get(tabId);
          if (!forTab) {
            forTab = new Map();
            oopif.set(tabId, forTab);
          }
          forTab.set(sessionId, { targetId, sessionId, url });
          return;
        }
        if (method === "Target.detachedFromTarget") {
          // 004/T154 (S4 review): `targetId` is deprecated on this event and a real detach can
          // omit it; `sessionId` is what `Target.attachedToTarget` keyed this entry by above, and
          // it is the field CDP always sends here.
          const sessionId = (params as { sessionId?: unknown }).sessionId;
          if (typeof sessionId === "string") oopif.get(tabId)?.delete(sessionId);
        }
      });
    }
    return adapter;
  }

  async function domains(tabId: number, verb: "enable" | "disable"): Promise<void> {
    for (const domain of DIAGNOSTICS_DOMAINS) {
      try {
        await debug().send(tabId, `${domain}.${verb}`);
      } catch {
        deps.reportDiagnostic?.(`agent.diagnostics.${verb}-failed`);
      }
    }
  }

  async function detach(tabId: number): Promise<void> {
    tabs.delete(tabId);
    unavailable.delete(tabId);
    try {
      await debug().detach(tabId);
    } catch {
      // Already gone - the tab closed, or Chrome detached first. The attachment is over either
      // way, which is the only thing this call was for.
      deps.reportDiagnostic?.("agent.diagnostics.detach-noop");
    }
    // 004/T161: cleared after the round trip, not before it - an `Target.attachedToTarget` that
    // lands while Chrome's own detach is still in flight would otherwise be recorded into a table
    // this call had already decided was empty, and the entry would outlive the attachment it named
    // a session on.
    oopif.delete(tabId);
  }

  return {
    async acquire(tabId, holder) {
      const existing = tabs.get(tabId);
      if (existing) {
        existing.holders.add(holder);
        if (holder === "diagnostics" && !existing.diagnosticsEnabled) {
          existing.diagnosticsEnabled = true;
          await domains(tabId, "enable");
        }
        return { ok: true };
      }
      try {
        await debug().attach(tabId);
      } catch (error) {
        const unavailableReason = attachFailureReason(error);
        unavailable.set(tabId, unavailableReason);
        deps.reportDiagnostic?.("agent.diagnostics.attach-failed");
        return { ok: false, unavailableReason };
      }
      unavailable.delete(tabId);
      tabs.set(tabId, { holders: new Set([holder]), diagnosticsEnabled: holder === "diagnostics" });
      // One per attachment (004/T129): flat auto-attach is what turns a cross-site child frame into
      // its own addressable session at all, and it is asked for here rather than on the first
      // effect that happens to need it - by the time a delivery is asking "does this frame have a
      // session", Chrome must already have told this worker so.
      try {
        await debug().send(tabId, "Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        });
      } catch {
        deps.reportDiagnostic?.("agent.diagnostics.autoattach-failed");
      }
      /**
       * The third stated exception, on every attachment (008/T224, D-008-5, R-138).
       *
       * A native dialog is invisible without it, and a session that cannot hear one has no honest
       * answer for the tool calls it blocks - which is the 25 s silence this feature ends. Enabled
       * here rather than when a dialog is suspected, because a dialog cannot be suspected: the
       * event is the only notice there ever is, and a domain enabled after it would arrive late by
       * exactly the interval that matters. The failure is reported and ignored, as auto-attach's
       * is: a tab whose dialogs cannot be heard still takes clicks.
       */
      try {
        await debug().send(tabId, "Page.enable");
      } catch {
        deps.reportDiagnostic?.("agent.dialog.page-enable-failed");
      }
      // 012/T306: the attachment is ready, and whatever Chrome kept about this tab across an
      // eviction is re-applied here - after the setup above, because a listener's own command
      // would otherwise race `Page.enable` on the same session.
      await fanOut(attachedListeners, tabId);
      if (holder === "diagnostics") await domains(tabId, "enable");
      return { ok: true };
    },
    async drop(tabId, holder) {
      const state = tabs.get(tabId);
      if (!state) return;
      state.holders.delete(holder);
      if (state.holders.size === 0) {
        // Nobody wants it any more. Detaching takes the domains with it, so they are not turned
        // off one by one first.
        await detach(tabId);
        return;
      }
      if (holder === "diagnostics" && state.diagnosticsEnabled) {
        // The grant stopped applying but the lease did not: the attachment stays for input, and
        // the domains that made it a window on the page go off (FR-071).
        state.diagnosticsEnabled = false;
        await domains(tabId, "disable");
      }
    },
    async release(tabId) {
      unavailable.delete(tabId);
      /**
       * 012/T306, FR-159, and 012/S2c F1: before the detach, and before this worker's own
       * bookkeeping gets a say.
       *
       * R-166 measured that Chrome keeps an emulation the detach was assumed to drop, so a command
       * sent afterwards has no attachment to go over. The hook also runs for a tab this map does
       * not list, because that is the ordinary state after an MV3 eviction - Chrome kept the
       * emulation *and* the debugger, and this worker kept neither. A release that returned early
       * there would hand the owner back a page still laid out for the agent, and the listener is
       * the one thing that can attach for the clear (`decideClear`).
       */
      await fanOut(beforeReleaseListeners, tabId);
      if (!tabs.has(tabId)) return;
      await detach(tabId);
    },
    async releaseAll() {
      unavailable.clear();
      for (const tabId of [...tabs.keys()]) {
        await fanOut(beforeReleaseListeners, tabId);
        await detach(tabId);
      }
    },
    async send(tabId, method, params, sessionId) {
      if (!tabs.has(tabId)) throw new Error("input-not-attached");
      return debug().send(tabId, method, params, sessionId);
    },
    attached() {
      return [...tabs.keys()];
    },
    oopifSessions(tabId) {
      return [...(oopif.get(tabId)?.values() ?? [])];
    },
    state(tabId) {
      const state = tabs.get(tabId);
      const unavailableReason = unavailable.get(tabId);
      if (!state) {
        return unavailableReason === undefined
          ? undefined
          : { tabId, attached: false, diagnosticsEnabled: false, unavailableReason };
      }
      return { tabId, attached: true, diagnosticsEnabled: state.diagnosticsEnabled };
    },
    onEvent(listener) {
      // Remembered rather than registered (008/T224): see `eventListeners` above - a subscription
      // made at composition must not be the thing that reaches for Chrome's debugger API.
      eventListeners.push(listener);
    },
    onDetach(listener) {
      detachListeners.push(listener);
    },
    onAttached(listener) {
      attachedListeners.push(listener);
    },
    onBeforeRelease(listener) {
      beforeReleaseListeners.push(listener);
    },
    listenerCount() {
      return { event: eventListeners.length, detach: detachListeners.length };
    },
    async attachedTabIds() {
      return debug().attachedTabIds();
    },
    async detachStray(tabId) {
      await debug().detach(tabId);
    },
  };
}

/**
 * An input dispatch the page did not answer within the content deadline (015/T402, FR-206, R-197).
 *
 * Raised by `dispatchInput` alone; the effect runner answers it as `page-not-responding`, the same
 * words a binding that hit the deadline gets.
 */
export class InputDispatchDeadline extends Error {
  constructor(readonly method: string) {
    super("page-not-responding");
    this.name = "InputDispatchDeadline";
  }
}

export function isInputDispatchDeadline(error: unknown): error is InputDispatchDeadline {
  return error instanceof InputDispatchDeadline;
}

/**
 * Every `Input.*` command the agent's pointer and keyboard send goes through here (015/T402).
 *
 * `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent` return only once the renderer has handled
 * the event. A page whose handler holds its main thread - or Chromium itself, measured blocking the
 * first opener-keeping `window.open` pressed after a cross-origin round trip (R-197) - never lets it
 * return, and an unbounded await left the call to the host's own give-up, `timed-out / no-answer`.
 * So the dispatch is raced against the content deadline, the one bound every page-facing round
 * trip already carries; nothing else sent over the attachment is bounded here.
 *
 * The command itself cannot be taken back. Its late answer settles a promise nobody reads any more:
 * both of its outcomes are handled below, so a late failure is never an unhandled rejection, and
 * the caller has already stopped - nothing after the timed-out event is sent.
 */
function dispatchInput(
  attachments: AgentInputAttachments,
  tabId: number,
  method: `Input.${string}`,
  params: Record<string, unknown>,
  sessionId?: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    // Sent before the clock starts, so a send that throws at once leaves no timer behind.
    const sent = attachments.send(tabId, method, params, sessionId);
    const timer = setTimeout(() => reject(new InputDispatchDeadline(method)), CONTENT_OPERATION_DEADLINE_MS);
    sent.then(
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

/** A point in the top document's viewport - the only coordinates the debugger accepts. */
export type PointerPoint = { x: number; y: number };

export type PointerButton = "left" | "right" | "middle";

/**
 * What the page is told so it can draw the pointer the owner can follow (T127 draws it).
 *
 * Sent rather than dispatched: the cursor is a mark on the page, not an event, so it travels the
 * ordinary content-script channel and its failure is never an effect's failure. One move per
 * gesture; the pointer stays on the page between them and leaves with the tab's lease (the
 * indicator's `show: false`), so `hide` is kept for the protocol and no longer sent per gesture.
 */
export type CursorMessage = { type: "cursor"; x?: number; y?: number; hide?: true };

/**
 * Sends the page one cursor message. A returned promise settles when the page reports the pointer
 * has arrived at the point; a sender that returns nothing, or one that never settles, is waited on
 * no longer than the arrival cap.
 */
export type CursorSender = (tabId: number, message: CursorMessage) => Promise<void> | void;

/**
 * How long a gesture waits for the page's "arrived" before the move is dispatched anyway: the
 * page's own glide plus slack. A page with no listener rejects at once and waits nothing.
 */
const CURSOR_ARRIVAL_CAP_MS = 250;

/** The shorter wait inside a drag, between the press and the move to the end of it. */
const DRAG_TRAVEL_CAP_MS = 60;

/**
 * Where a gesture is delivered (004/T129): the tab's own top-level session by default, or a
 * specific out-of-process frame's own session when the target has one - in which case `point` is
 * already that frame's own local coordinates, never the page's.
 */
export type PointerDestination = { sessionId?: string };

export type AgentPointerInput = {
  /** The move alone, which is what a hover *is* (G6). */
  hover(tabId: number, point: PointerPoint, destination?: PointerDestination): Promise<void>;
  /** Move to the point, press, release - in that order and at that point. */
  click(
    tabId: number,
    point: PointerPoint,
    options?: { button?: PointerButton; clickCount?: number } & PointerDestination,
  ): Promise<void>;
  /** A wheel at the point, so the page scrolls whatever is under the pointer. */
  scroll(
    tabId: number,
    point: PointerPoint,
    delta: { deltaX: number; deltaY: number },
    destination?: PointerDestination,
  ): Promise<void>;
  /** Move, press, move, release: the drag a person's hand makes. */
  drag(tabId: number, from: PointerPoint, to: PointerPoint, destination?: PointerDestination): Promise<void>;
};

export type AgentPointerInputDeps = {
  attachments: AgentInputAttachments;
  /** Absent means nothing is drawn; the delivery is unchanged either way. */
  cursor?: CursorSender;
};

/** The one message name the page's own cursor listens for; settles when the page has answered. */
function sendCursorMessage(tabId: number, message: CursorMessage): Promise<void> {
  const tabs = (globalThis as { chrome?: { tabs?: { sendMessage?: unknown } } }).chrome?.tabs;
  const send = tabs?.sendMessage as
    | ((tabId: number, message: unknown, options?: { frameId: number }) => Promise<unknown>)
    | undefined;
  if (!send) return Promise.resolve();
  // The top frame only: one cursor on the page, not one per document. A page with no listener
  // rejects, and that is not a failed effect - nothing about the input depends on it.
  return Promise.resolve()
    .then(() => send(tabId, message, { frameId: 0 }))
    .then(
      () => undefined,
      () => undefined,
    );
}

function sleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/**
 * Pointer input as the reference delivers it (004/T121, US5, G6, R-113, FR-064).
 *
 * The order is the whole point. Every click is a *move* to the target and then the press, because
 * that move is what makes the page's own hover state true when the press lands: a menu that exists
 * only under `:hover` is open, a control armed on `mouseenter` is armed, and the click the page
 * receives is one it cannot tell from a person's. A hover is that same move with nothing after it.
 *
 * Everything here goes through the shared attachment, so a tab that could not be attached never
 * reaches this module at all - the effect answered `input-unavailable` before it (R-113: there is
 * no second route, because the page-level events 003 used are what this replaces).
 */
export function createPointerInput(deps: AgentPointerInputDeps): AgentPointerInput {
  const cursor = deps.cursor ?? sendCursorMessage;

  async function mouse(tabId: number, params: Record<string, unknown>, sessionId?: string): Promise<void> {
    await dispatchInput(deps.attachments, tabId, "Input.dispatchMouseEvent", params, sessionId);
  }

  async function move(
    tabId: number,
    point: PointerPoint,
    held?: PointerButton,
    sessionId?: string,
  ): Promise<void> {
    await mouse(
      tabId,
      {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        // A move carries the button that is *down*, so a drag's middle move is part of one gesture
        // rather than a stray hover between two unrelated ones.
        button: held ?? "none",
        clickCount: 0,
      },
      sessionId,
    );
  }

  /**
   * Sends the pointer to `at` and waits for the page to say it has arrived - or `capMs`, whichever
   * comes first. The wait is the whole reason the mark is worth drawing: the owner should see the
   * arrow stop on the target and *then* the page react, never the other way round. The cap keeps a
   * page that cannot answer (no listener, hidden, mid-navigation) from holding the input.
   */
  async function arrive(tabId: number, at: PointerPoint, capMs: number): Promise<void> {
    let ack: Promise<void>;
    try {
      ack = Promise.resolve(cursor(tabId, { type: "cursor", x: at.x, y: at.y })).catch(() => undefined);
    } catch {
      return;
    }
    const cap = sleep(capMs);
    try {
      await Promise.race([ack, cap.promise]);
    } finally {
      cap.cancel();
    }
  }

  /**
   * One pointer gesture: the pointer is sent to the point and given time to get there, then the
   * events are dispatched. Nothing hides it after - it stays where the gesture left it until the
   * next one moves it or the tab leaves the session.
   */
  async function sequence(tabId: number, at: PointerPoint, run: () => Promise<void>): Promise<void> {
    await arrive(tabId, at, CURSOR_ARRIVAL_CAP_MS);
    await run();
  }

  return {
    async hover(tabId, point, destination = {}) {
      await sequence(tabId, point, () => move(tabId, point, undefined, destination.sessionId));
    },
    async click(tabId, point, options = {}) {
      const button = options.button ?? "left";
      const clickCount = options.clickCount ?? 1;
      const sessionId = options.sessionId;
      await sequence(tabId, point, async () => {
        await move(tabId, point, undefined, sessionId);
        await mouse(tabId, { type: "mousePressed", x: point.x, y: point.y, button, clickCount }, sessionId);
        await mouse(tabId, { type: "mouseReleased", x: point.x, y: point.y, button, clickCount }, sessionId);
      });
    },
    async scroll(tabId, point, delta, destination = {}) {
      const sessionId = destination.sessionId;
      await sequence(tabId, point, async () => {
        await move(tabId, point, undefined, sessionId);
        await mouse(
          tabId,
          {
            type: "mouseWheel",
            x: point.x,
            y: point.y,
            button: "none",
            deltaX: delta.deltaX,
            deltaY: delta.deltaY,
          },
          sessionId,
        );
      });
    },
    async drag(tabId, from, to, destination = {}) {
      const sessionId = destination.sessionId;
      await sequence(tabId, from, async () => {
        await move(tabId, from, undefined, sessionId);
        await mouse(
          tabId,
          { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 },
          sessionId,
        );
        // The pointer travels with the drag: the owner sees it go from the press to the release
        // rather than the page's content jump between two still frames.
        await arrive(tabId, to, DRAG_TRAVEL_CAP_MS);
        await move(tabId, to, "left", sessionId);
        await mouse(
          tabId,
          { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 },
          sessionId,
        );
      });
    },
  };
}

/**
 * The keyboard, as the one modifier bitmask the protocol understands. Shift is the only modifier
 * this slice ever sets on its own: a shifted character carries it so the page's `shiftKey` is true
 * while the key is down, exactly as it is under a person's finger.
 */
const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;

export type KeyModifier = keyof typeof MODIFIER_BITS;

/** One key on the layout: what the page is told was pressed, and what pressing it produces. */
type LayoutKey = {
  code: string;
  keyCode: number;
  /** The name the page sees when it is not the character itself (`Enter` for a newline). */
  key?: string;
  /** What the key puts in the field; absent means the key produces no character at all. */
  text?: string;
  shift?: true;
};

/** The named keys 003 admits (contracts `KEY_PRESS_KEYS`), unchanged in meaning. */
const NAMED_KEYS: Record<string, LayoutKey> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
};

/** The punctuation row: character, its key, and the character the same key makes under Shift. */
const PUNCTUATION: ReadonlyArray<readonly [string, string, number, string]> = [
  ["`", "Backquote", 192, "~"],
  ["-", "Minus", 189, "_"],
  ["=", "Equal", 187, "+"],
  ["[", "BracketLeft", 219, "{"],
  ["]", "BracketRight", 221, "}"],
  ["\\", "Backslash", 220, "|"],
  [";", "Semicolon", 186, ":"],
  ["'", "Quote", 222, '"'],
  [",", "Comma", 188, "<"],
  [".", "Period", 190, ">"],
  ["/", "Slash", 191, "?"],
];

/** The digits' shifted twins, in digit order. */
const SHIFTED_DIGITS = ")!@#$%^&*(";

/**
 * The keys a keyboard actually has (US layout) - which is the whole of "a character with a key to
 * press".
 *
 * The boundary is a property of the *layout* rather than a list of awkward characters somebody
 * remembered: a character is typed as a keystroke when this table has a key that produces it, and
 * inserted at the caret when it does not. Everything a US keyboard can reach is here, so what falls
 * to the insert path is what a person would reach through an input method or a picker instead - an
 * emoji, a CJK word, an accented letter (G7, R-113).
 */
function buildLayout(): Map<string, LayoutKey> {
  const layout = new Map<string, LayoutKey>();
  for (let index = 0; index < 26; index += 1) {
    const lower = String.fromCharCode(97 + index);
    const upper = String.fromCharCode(65 + index);
    layout.set(lower, { code: `Key${upper}`, keyCode: 65 + index, text: lower });
    layout.set(upper, { code: `Key${upper}`, keyCode: 65 + index, text: upper, shift: true });
  }
  for (let digit = 0; digit <= 9; digit += 1) {
    const character = String(digit);
    const shifted = SHIFTED_DIGITS[digit] as string;
    layout.set(character, { code: `Digit${digit}`, keyCode: 48 + digit, text: character });
    layout.set(shifted, { code: `Digit${digit}`, keyCode: 48 + digit, text: shifted, shift: true });
  }
  for (const [character, code, keyCode, shifted] of PUNCTUATION) {
    layout.set(character, { code, keyCode, text: character });
    layout.set(shifted, { code, keyCode, text: shifted, shift: true });
  }
  layout.set(" ", { code: "Space", keyCode: 32, text: " " });
  // A newline in a typed string is the Enter key and a tab is the Tab key: the page sees the
  // keystroke a person would have made, not a control character appearing in the field.
  layout.set("\n", { ...(NAMED_KEYS.Enter as LayoutKey), key: "Enter" });
  layout.set("\t", { ...(NAMED_KEYS.Tab as LayoutKey), key: "Tab" });
  return layout;
}

const US_LAYOUT = buildLayout();

export type AgentKeyboardInput = {
  /**
   * The string, one keystroke per character, in order.
   *
   * `replace` selects what the control holds and deletes it first - the two keystrokes a person
   * makes before typing over a field. Without it the characters land at the caret.
   *
   * `sessionId` (004/T129) routes delivery the same way a click into the same target already does:
   * a named target that turned out to live in a genuinely out-of-process frame was clicked through
   * that frame's own session, and the keys a person would then type there have to reach the same
   * session - the tab's own top-level session is a different document entirely.
   */
  type(tabId: number, text: string, options?: { replace?: boolean } & PointerDestination): Promise<void>;
  /** One named key, with its modifier, as many times as the call asked for (003's `key`). */
  press(
    tabId: number,
    key: string,
    options?: { modifiers?: readonly string[]; repeat?: number } & PointerDestination,
  ): Promise<void>;
};

export type AgentKeyboardInputDeps = { attachments: AgentInputAttachments };

/**
 * Keyboard input as the reference delivers it (004/T123, US5, G7, R-113, FR-064).
 *
 * 003 assigned the control's value and dispatched a single `input` event. Every page that behaves
 * differently *while* a person types - a search box that suggests, a combobox that filters per key,
 * a field that validates on each keystroke - stayed silent through that, because not one of the
 * events it reacts to ever happened. So the mechanism is the point here: one key-down and key-up
 * pair per character, in order, each carrying that character's own text.
 *
 * A character the keyboard has no key for is inserted at the caret instead - that character alone;
 * the rest of the string still goes key by key. It is the same thing a person's input method does
 * for an emoji or a CJK word, and it is the layout's edge rather than a shortcut around keystrokes.
 */
export function createKeyboardInput(deps: AgentKeyboardInputDeps): AgentKeyboardInput {
  function bits(modifiers: readonly string[] | undefined, shift: boolean): number {
    let mask = shift ? MODIFIER_BITS.Shift : 0;
    for (const modifier of modifiers ?? []) mask |= MODIFIER_BITS[modifier as KeyModifier] ?? 0;
    return mask;
  }

  async function stroke(
    tabId: number,
    name: string,
    layout: LayoutKey,
    options: { modifiers?: number; commands?: string[]; sessionId?: string } = {},
  ): Promise<void> {
    const key = layout.key ?? name;
    const modifiers = options.modifiers ?? 0;
    const base = { key, code: layout.code, windowsVirtualKeyCode: layout.keyCode, nativeVirtualKeyCode: layout.keyCode, modifiers };
    await dispatchInput(
      deps.attachments,
      tabId,
      "Input.dispatchKeyEvent",
      {
        ...base,
        // A key that produces a character is a `keyDown` carrying it; one that does not is a
        // `rawKeyDown`, which is the difference between text arriving in the field and only the
        // page's own handlers running.
        type: layout.text === undefined ? "rawKeyDown" : "keyDown",
        ...(layout.text === undefined ? {} : { text: layout.text, unmodifiedText: layout.text }),
        ...(options.commands === undefined ? {} : { commands: options.commands }),
      },
      options.sessionId,
    );
    await dispatchInput(deps.attachments, tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" }, options.sessionId);
  }

  return {
    async type(tabId, text, options = {}) {
      const sessionId = options.sessionId;
      if (options.replace) {
        await stroke(
          tabId,
          "a",
          { code: "KeyA", keyCode: 65 },
          { modifiers: MODIFIER_BITS.Control, commands: ["selectAll"], ...(sessionId === undefined ? {} : { sessionId }) },
        );
        await stroke(tabId, "Delete", NAMED_KEYS.Delete as LayoutKey, { ...(sessionId === undefined ? {} : { sessionId }) });
      }
      // By code point rather than by UTF-16 unit: an emoji is one character to insert, not two
      // halves neither of which is anything.
      for (const character of [...text]) {
        const layout = US_LAYOUT.get(character);
        if (layout === undefined) {
          await dispatchInput(deps.attachments, tabId, "Input.insertText", { text: character }, sessionId);
          continue;
        }
        await stroke(tabId, character, layout, {
          modifiers: bits(undefined, layout.shift === true),
          ...(sessionId === undefined ? {} : { sessionId }),
        });
      }
    },
    async press(tabId, key, options = {}) {
      const layout = NAMED_KEYS[key];
      // Unreachable from a tool call - the contract's enum is this same set - and refused rather
      // than delivered as something else if it ever is.
      if (layout === undefined) throw new Error(`unsupported-key:${key}`);
      const modifiers = bits(options.modifiers, false);
      for (let index = 0; index < (options.repeat ?? 1); index += 1) {
        await stroke(tabId, key, layout, { modifiers, ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) });
      }
    },
  };
}
